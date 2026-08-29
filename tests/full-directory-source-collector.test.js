import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-workspace.js';
import { collectFullDirectorySource } from '../src/full-directory-source-collector.js';

test('collects supported files, skips excluded dirs and unsupported names', async () => {
  const dir = await makeTempDir();
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'a.cpp'), 'int a;\n', 'utf8');
  await fs.writeFile(path.join(dir, 'src', 'B.java'), 'class B {}\n', 'utf8');
  await fs.writeFile(path.join(dir, 'src', 'note.md'), '# n\n', 'utf8');
  await fs.writeFile(path.join(dir, 'node_modules', 'x', 'n.cpp'), 'int n;\n', 'utf8');
  const source = await collectFullDirectorySource({
    projectDir: dir, maxFiles: 50, maxFileChars: 80000, maxInputChars: 240000
  });
  assert.deepEqual(source.files.map((f) => f.path).sort(), ['src/B.java', 'src/a.cpp']);
  assert.equal(source.files[0].status, 'ADDED');
  assert.ok(source.contents['src/a.cpp'].includes('1|'));
});

test('rejects binary supported-extension files', async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, 'blob.cpp'), Buffer.from([0x00, 0x01, 0x02]));
  await assert.rejects(
    () => collectFullDirectorySource({
      projectDir: dir, maxFiles: 50, maxFileChars: 80000, maxInputChars: 240000
    }),
    (err) => err.code === 'SOURCE_SIZE_LIMIT_EXCEEDED' || err.message.includes('二进制')
  );
});

test('fails with NO_REVIEWABLE_SOURCE when only unsupported files exist', async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, 'notes.txt'), 'not source\n', 'utf8');
  await assert.rejects(
    () => collectFullDirectorySource({
      projectDir: dir, maxFiles: 50, maxFileChars: 80000, maxInputChars: 240000
    }),
    (err) => err.code === 'NO_REVIEWABLE_SOURCE'
  );
});

test('fails with SOURCE_FILE_LIMIT_EXCEEDED when files exceed maxFiles', async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, 'a.cpp'), 'int a;\n', 'utf8');
  await fs.writeFile(path.join(dir, 'b.cpp'), 'int b;\n', 'utf8');
  await assert.rejects(
    () => collectFullDirectorySource({
      projectDir: dir, maxFiles: 1, maxFileChars: 80000, maxInputChars: 240000
    }),
    (err) =>
      err.code === 'SOURCE_FILE_LIMIT_EXCEEDED' &&
      err.details.includes('files=2') &&
      err.details.includes('maxFiles=1')
  );
});

test('fails with SOURCE_SIZE_LIMIT_EXCEEDED when a file exceeds maxFileChars', async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, 'big.cpp'), 'int x = 1;\n', 'utf8');
  await assert.rejects(
    () => collectFullDirectorySource({
      projectDir: dir, maxFiles: 50, maxFileChars: 5, maxInputChars: 240000
    }),
    (err) =>
      err.code === 'SOURCE_SIZE_LIMIT_EXCEEDED' &&
      Array.isArray(err.details) &&
      err.details.some((d) => String(d).includes('big.cpp'))
  );
});

test('fails with SOURCE_SIZE_LIMIT_EXCEEDED when total exceeds maxInputChars', async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, 'a.cpp'), 'int a;\n', 'utf8');
  await fs.writeFile(path.join(dir, 'b.cpp'), 'int b;\n', 'utf8');
  await assert.rejects(
    () => collectFullDirectorySource({
      projectDir: dir, maxFiles: 50, maxFileChars: 80000, maxInputChars: 20
    }),
    (err) =>
      err.code === 'SOURCE_SIZE_LIMIT_EXCEEDED' &&
      Array.isArray(err.details) &&
      err.details.some((d) => String(d).includes('totalCharacters='))
  );
});

test('collects uppercase extension as CPP', async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, 'Foo.CPP'), 'int foo;\n', 'utf8');
  const source = await collectFullDirectorySource({
    projectDir: dir, maxFiles: 50, maxFileChars: 80000, maxInputChars: 240000
  });
  assert.equal(source.files.length, 1);
  assert.equal(source.files[0].path, 'Foo.CPP');
  assert.equal(source.files[0].language, 'CPP');
});

test('skips symlink file and directory entries', async (t) => {
  const dir = await makeTempDir();
  const outside = await makeTempDir();
  await fs.mkdir(path.join(outside, 'nested'), { recursive: true });
  await fs.writeFile(path.join(outside, 'nested', 'hidden.cpp'), 'int h;\n', 'utf8');
  await fs.writeFile(path.join(dir, 'keep.cpp'), 'int k;\n', 'utf8');
  try {
    await fs.symlink(outside, path.join(dir, 'linked'), 'dir');
    await fs.symlink(
      path.join(outside, 'nested', 'hidden.cpp'),
      path.join(dir, 'link.cpp'),
      'file'
    );
  } catch {
    t.skip('symlink not permitted on this machine');
    return;
  }
  const source = await collectFullDirectorySource({
    projectDir: dir, maxFiles: 50, maxFileChars: 80000, maxInputChars: 240000
  });
  assert.deepEqual(source.files.map((f) => f.path), ['keep.cpp']);
  assert.equal(source.contents['link.cpp'], undefined);
  assert.equal(source.contents['linked/nested/hidden.cpp'], undefined);
});
