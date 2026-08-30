import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from './temp-workspace.js';
import { git, writeFile } from './temp-git-repo.js';

export async function makeBareRepo() {
  const root = await makeTempDir('crs-bare-');
  const bare = path.join(root, 'remote.git');
  await git(root, ['init', '--bare', bare]);

  const work = path.join(root, 'work');
  await fs.mkdir(work, { recursive: true });
  await git(work, ['init', '-b', 'master']);
  await git(work, ['config', 'user.email', 'test@example.com']);
  await git(work, ['config', 'user.name', 'Test']);
  await writeFile(work, 'a.c', 'int main(){return 0;}\n');
  await git(work, ['add', 'a.c']);
  await git(work, ['commit', '-m', 'init']);
  await git(work, ['remote', 'add', 'origin', bare]);
  await git(work, ['push', '-u', 'origin', 'master']);

  return { bare, headRef: 'master' };
}
