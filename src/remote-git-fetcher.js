import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as cb } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from './shared/app-error.js';
import { ErrorCodes } from './shared/error-codes.js';
import { resolveRealPath, assertInsideAllowedRoots } from './shared/path-security.js';
import { buildGitEnv } from './shared/git-env.js';

const execFile = promisify(cb);

export function repoNameFromUrl(url) {
  return String(url).replace(/\\/g, '/').replace(/\.git$/i, '').split('/').filter(Boolean).pop() || 'remote';
}

function classifyGitError(stderr) {
  const s = String(stderr ?? '');
  if (/Authentication failed|Invalid username|403|401|not authorized/i.test(s)) return ErrorCodes.REMOTE_AUTH_FAILED;
  if (/pathspec|did not match|ref .* does not exist|unknown revision/i.test(s)) return ErrorCodes.REMOTE_REF_NOT_FOUND;
  return ErrorCodes.REMOTE_FETCH_FAILED;
}

export function createRemoteGitFetcher({ workspaceDir, ephemeral, fetchRetries, credentials, allowedRoots, logger }) {
  async function runGit(args, { cwd, env, retries }) {
    let last;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return (await execFile('git', args, { cwd, env, windowsHide: true })).stdout;
      } catch (err) {
        last = err;
        const code = classifyGitError(err.stderr || err.message);
        if (code === ErrorCodes.REMOTE_AUTH_FAILED || code === ErrorCodes.REMOTE_REF_NOT_FOUND) break;
        if (attempt === retries) break;
      }
    }
    throw new AppError(classifyGitError(last?.stderr || last?.message), 'Git 远程拉取失败', []);
  }

  async function fetch({ remoteUrl, ref }) {
    const { env, extraArgs } = buildGitEnv(credentials);
    let localDir;
    let cleanup;
    if (ephemeral) {
      localDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crs-remote-'));
      cleanup = async () => { await fs.rm(localDir, { recursive: true, force: true }); };
    } else {
      const wsReal = await resolveRealPath(workspaceDir);
      if (allowedRoots) assertInsideAllowedRoots(wsReal, allowedRoots, workspaceDir);
      localDir = path.join(wsReal, repoNameFromUrl(remoteUrl));
      await fs.mkdir(localDir, { recursive: true });
    }
    const exists = await fs.stat(path.join(localDir, '.git')).then(() => true).catch(() => false);
    if (exists) {
      await runGit([...extraArgs, 'fetch', remoteUrl, ref], { cwd: localDir, env, retries: 0 });
      await runGit(['checkout', ref], { cwd: localDir, env, retries: 0 });
    } else {
      await runGit([...extraArgs, 'clone', remoteUrl, localDir], { cwd: process.cwd(), env, retries: fetchRetries });
      await runGit(['checkout', ref], { cwd: localDir, env, retries: 0 });
    }
    const real = await resolveRealPath(localDir);
    if (allowedRoots) assertInsideAllowedRoots(real, allowedRoots, localDir);
    return { localDir: real, cleanup };
  }

  return { fetch };
}
