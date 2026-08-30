import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-workspace.js';
import { makeBareRepo } from './helpers/temp-bare-repo.js';
import { createRemoteGitFetcher } from '../src/remote-git-fetcher.js';
import { resolveRealPath } from '../src/shared/path-security.js';
import { ErrorCodes } from '../src/shared/error-codes.js';

function toGitPath(p) {
  return p.replace(/\\/g, '/');
}

function makeFetcher(workspace, allowedRoots, opts = {}) {
  return createRemoteGitFetcher({
    workspaceDir: workspace,
    ephemeral: false,
    fetchRetries: 0,
    credentials: null,
    allowedRoots,
    logger: null,
    ...opts
  });
}

test('clone leaves a.c in localDir', async () => {
  const { bare, headRef } = await makeBareRepo();
  const workspace = await makeTempDir('crs-ws-');
  const realWs = await resolveRealPath(workspace);
  const fetcher = makeFetcher(workspace, [realWs]);
  const { localDir } = await fetcher.fetch({ remoteUrl: toGitPath(bare), ref: headRef });
  await fs.access(path.join(localDir, 'a.c'));
});

test('second fetch from same fetcher still reads a.c', async () => {
  const { bare, headRef } = await makeBareRepo();
  const workspace = await makeTempDir('crs-ws-');
  const realWs = await resolveRealPath(workspace);
  const fetcher = makeFetcher(workspace, [realWs]);
  await fetcher.fetch({ remoteUrl: toGitPath(bare), ref: headRef });
  const { localDir } = await fetcher.fetch({ remoteUrl: toGitPath(bare), ref: headRef });
  await fs.access(path.join(localDir, 'a.c'));
});

test('missing ref throws REMOTE_REF_NOT_FOUND', async () => {
  const { bare } = await makeBareRepo();
  const workspace = await makeTempDir('crs-ws-');
  const realWs = await resolveRealPath(workspace);
  const fetcher = makeFetcher(workspace, [realWs]);
  await assert.rejects(
    () => fetcher.fetch({ remoteUrl: toGitPath(bare), ref: 'no-such-ref' }),
    (err) => err.code === ErrorCodes.REMOTE_REF_NOT_FOUND
  );
});

test('workspaceDir outside allowedRoots throws PATH_OUTSIDE_ALLOWED_ROOT', async () => {
  const { bare, headRef } = await makeBareRepo();
  const allowedRoot = await makeTempDir('crs-allowed-');
  const workspace = await makeTempDir('crs-ws-');
  const realAllowed = await resolveRealPath(allowedRoot);
  const fetcher = makeFetcher(workspace, [realAllowed]);
  await assert.rejects(
    () => fetcher.fetch({ remoteUrl: toGitPath(bare), ref: headRef }),
    (err) => err.code === ErrorCodes.PATH_OUTSIDE_ALLOWED_ROOT
  );
});

test('ephemeral cleanup removes localDir', async () => {
  const { bare, headRef } = await makeBareRepo();
  const realTmp = await resolveRealPath(os.tmpdir());
  const fetcher = createRemoteGitFetcher({
    workspaceDir: '/unused',
    ephemeral: true,
    fetchRetries: 0,
    credentials: null,
    allowedRoots: [realTmp],
    logger: null
  });
  const { localDir, cleanup } = await fetcher.fetch({ remoteUrl: toGitPath(bare), ref: headRef });
  await fs.access(path.join(localDir, 'a.c'));
  await cleanup();
  await assert.rejects(() => fs.access(localDir));
});

test('existing-repo fetch path retries network errors', async () => {
  const { bare, headRef } = await makeBareRepo();
  const workspace = await makeTempDir('crs-ws-');
  const realWs = await resolveRealPath(workspace);
  const fetcher = makeFetcher(workspace, [realWs], { fetchRetries: 2 });
  await fetcher.fetch({ remoteUrl: toGitPath(bare), ref: headRef });
  await fs.rm(bare, { recursive: true, force: true });
  await assert.rejects(
    () => fetcher.fetch({ remoteUrl: toGitPath(bare), ref: headRef }),
    (err) => err.code === ErrorCodes.REMOTE_FETCH_FAILED
  );
});

test('ephemeral removes temp dir on fetch failure', async () => {
  const realTmp = await resolveRealPath(os.tmpdir());
  const prefix = 'crs-remote-';
  const remoteDirs = async () => (await fs.readdir(realTmp)).filter((n) => n.startsWith(prefix));
  const before = new Set(await remoteDirs());
  const fetcher = createRemoteGitFetcher({
    workspaceDir: '/unused',
    ephemeral: true,
    fetchRetries: 0,
    credentials: null,
    allowedRoots: [realTmp],
    logger: null
  });
  await assert.rejects(
    () => fetcher.fetch({ remoteUrl: 'http://127.0.0.1:9/unreachable.git', ref: 'master' }),
    (err) => err.code === ErrorCodes.REMOTE_FETCH_FAILED
  );
  const after = new Set(await remoteDirs());
  assert.equal(after.size, before.size);
});
