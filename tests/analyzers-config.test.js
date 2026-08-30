import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-workspace.js';
import { loadConfig, resolveAnalyzersList } from '../src/shared/config.js';

async function writeConfig(dir, obj) {
  const file = path.join(dir, 'app.config.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, JSON.stringify(obj), 'utf8');
  return file;
}

test('resolveAnalyzersList prefers analyzers array when present', () => {
  const list = resolveAnalyzersList({
    analyzers: [
      { id: 'ruff', enabled: true, command: 'ruff', args: [], timeoutMs: 1, onAnalyzerError: 'skip' }
    ],
    analyzer: { enabled: true, tool: 'clang-tidy', command: 'clang-tidy', args: [], timeoutMs: 1, onAnalyzerError: 'skip' }
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'ruff');
});

test('resolveAnalyzersList falls back to legacy analyzer object', () => {
  const list = resolveAnalyzersList({
    analyzer: {
      enabled: true,
      tool: 'clang-tidy',
      command: 'clang-tidy',
      args: ['{file}'],
      timeoutMs: 300000,
      onAnalyzerError: 'skip'
    }
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'clang-tidy');
  assert.equal(list[0].enabled, true);
});

test('loadConfig defaults include clang-tidy, ruff, and go-vet analyzers', async () => {
  const dir = await makeTempDir('crs-cfg-analyzers-');
  const root = await makeTempDir('crs-root-');
  const file = await writeConfig(dir, { security: { allowedRoots: [root] } });
  const config = await loadConfig(file);
  const ids = config.analyzers.map((a) => a.id).sort();
  assert.deepEqual(ids, ['clang-tidy', 'go-vet', 'ruff']);
  assert.equal(config.analyzers.every((a) => a.enabled === false), true);
  assert.ok(config.review.allowedExtensions.includes('.py'));
  assert.ok(config.review.allowedExtensions.includes('.go'));
});
