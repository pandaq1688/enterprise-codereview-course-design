import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { makeTempDir } from './temp-workspace.js';

const execFile = promisify(execFileCb);

export async function git(cwd, args) {
  const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
  return stdout;
}

export async function makeGitRepo() {
  const dir = await makeTempDir('crs-git-');
  await git(dir, ['init']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  return dir;
}

export async function writeFile(root, rel, content) {
  const abs = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  return abs;
}
