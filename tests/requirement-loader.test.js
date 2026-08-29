import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-workspace.js';
import { loadRequirement } from '../src/requirement-loader.js';
import { ErrorCodes } from '../src/shared/error-codes.js';
import { sha256Text } from '../src/shared/hash.js';

test('loads utf8 markdown without rewriting', async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, 'req.md');
  const content = '# 需求\n必须返回 0\n';
  await fs.writeFile(file, content, 'utf8');
  const loaded = await loadRequirement({ filePath: file, maxChars: 50000 });
  assert.equal(loaded.text, content);
  assert.equal(loaded.characterCount, content.length);
  assert.equal(loaded.contentHash, sha256Text(content));
});

test('loads .markdown extension successfully', async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, 'req.markdown');
  const content = '# 需求\n.markdown 扩展名\n';
  await fs.writeFile(file, content, 'utf8');
  const loaded = await loadRequirement({ filePath: file, maxChars: 50000 });
  assert.equal(loaded.text, content);
  assert.equal(loaded.characterCount, content.length);
  assert.equal(loaded.contentHash, sha256Text(content));
});

test('rejects oversize requirement with SOURCE_SIZE_LIMIT_EXCEEDED', async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, 'big.md');
  const content = 'x'.repeat(20);
  await fs.writeFile(file, content, 'utf8');
  await assert.rejects(
    () => loadRequirement({ filePath: file, maxChars: 10 }),
    (err) =>
      err.code === ErrorCodes.SOURCE_SIZE_LIMIT_EXCEEDED &&
      Array.isArray(err.details) &&
      err.details.includes('requirement')
  );
});

test('rejects non-markdown and empty files', async () => {
  const dir = await makeTempDir();
  const txt = path.join(dir, 'req.txt');
  await fs.writeFile(txt, 'x', 'utf8');
  await assert.rejects(
    () => loadRequirement({ filePath: txt, maxChars: 50000 }),
    (err) => err.code === ErrorCodes.REQUIREMENT_NOT_MARKDOWN
  );
  const md = path.join(dir, 'empty.md');
  await fs.writeFile(md, '   \n', 'utf8');
  await assert.rejects(
    () => loadRequirement({ filePath: md, maxChars: 50000 }),
    (err) => err.code === ErrorCodes.REQUIREMENT_EMPTY
  );
});
