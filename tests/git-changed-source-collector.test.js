import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGitRepo, git, writeFile } from './helpers/temp-git-repo.js';
import { collectGitChangedSource } from '../src/git-changed-source-collector.js';

test('collects staged, unstaged, and untracked supported files once each', async () => {
  const dir = await makeGitRepo();
  await writeFile(dir, 'src/base.cpp', 'int a = 1;\n');
  await git(dir, ['add', 'src/base.cpp']);
  await git(dir, ['commit', '-m', 'base']);

  await writeFile(dir, 'src/staged.cpp', 'int s = 1;\n');
  await git(dir, ['add', 'src/staged.cpp']);

  await writeFile(dir, 'src/base.cpp', 'int a = 2;\n'); // unstaged modify
  await writeFile(dir, 'src/untracked.cpp', 'int u = 1;\n');
  await writeFile(dir, 'src/skip.txt', 'nope\n');

  const source = await collectGitChangedSource({
    projectDir: dir,
    maxFiles: 50,
    maxFileChars: 80000,
    maxInputChars: 240000
  });
  const paths = source.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['src/base.cpp', 'src/staged.cpp', 'src/untracked.cpp']);
  assert.equal(source.files.find((f) => f.path === 'src/untracked.cpp').status, 'UNTRACKED');
  assert.equal(source.files.find((f) => f.path === 'src/base.cpp').status, 'MODIFIED');
  assert.ok(source.files.find((f) => f.path === 'src/base.cpp').changedLines.includes(1));
});

test('treats all supported files as ADDED when HEAD is missing', async () => {
  const dir = await makeGitRepo();
  await writeFile(dir, 'src/new.cpp', 'int n = 1;\n');
  const source = await collectGitChangedSource({
    projectDir: dir, maxFiles: 50, maxFileChars: 80000, maxInputChars: 240000
  });
  assert.equal(source.files[0].status, 'ADDED');
  assert.equal(source.files[0].path, 'src/new.cpp');
});

test('fails with GIT_REPOSITORY_REQUIRED when not a git work tree', async () => {
  const { makeTempDir } = await import('./helpers/temp-workspace.js');
  const dir = await makeTempDir();
  await assert.rejects(
    () => collectGitChangedSource({
      projectDir: dir, maxFiles: 50, maxFileChars: 80000, maxInputChars: 240000
    }),
    (err) => err.code === 'GIT_REPOSITORY_REQUIRED'
  );
});

test('keeps deleted file diff without current line numbers', async () => {
  const dir = await makeGitRepo();
  await writeFile(dir, 'src/gone.cpp', 'int g = 1;\n');
  await git(dir, ['add', 'src/gone.cpp']);
  await git(dir, ['commit', '-m', 'add']);
  await git(dir, ['rm', 'src/gone.cpp']);
  const source = await collectGitChangedSource({
    projectDir: dir, maxFiles: 50, maxFileChars: 80000, maxInputChars: 240000
  });
  const gone = source.files.find((f) => f.path === 'src/gone.cpp');
  assert.equal(gone.status, 'DELETED');
  assert.equal(gone.lineCount, null);
  assert.deepEqual(gone.changedLines, []);
  assert.ok(source.contents['src/gone.cpp'].includes('-int g'));
});

test('records rename with final path and oldPath metadata', async () => {
  const dir = await makeGitRepo();
  await writeFile(dir, 'src/old.cpp', 'int r = 1;\n');
  await git(dir, ['add', 'src/old.cpp']);
  await git(dir, ['commit', '-m', 'add']);
  await git(dir, ['mv', 'src/old.cpp', 'src/new.cpp']);
  const source = await collectGitChangedSource({
    projectDir: dir, maxFiles: 50, maxFileChars: 80000, maxInputChars: 240000
  });
  const renamed = source.files.find((f) => f.path === 'src/new.cpp');
  assert.equal(renamed.status, 'RENAMED');
  assert.equal(renamed.oldPath, 'src/old.cpp');
});
