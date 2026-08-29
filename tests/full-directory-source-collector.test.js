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
