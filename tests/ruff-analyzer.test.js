import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuffAnalyzer } from '../src/ruff-analyzer.js';
import { makeTempDir } from './helpers/temp-workspace.js';
import { AppError } from '../src/shared/app-error.js';
import { ErrorCodes } from '../src/shared/error-codes.js';

const fakeScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'helpers',
  'fake-ruff-script.mjs'
);

function makeAnalyzer(options = {}) {
  return createRuffAnalyzer({
    command: process.execPath,
    args: [fakeScript, '{file}'],
    timeoutMs: options.timeoutMs ?? 10_000,
    onAnalyzerError: options.onAnalyzerError ?? 'skip',
    logger: options.logger ?? null
  });
}

test('ruff emit returns analyzer findings for .py files', async () => {
  process.env.CRS_FAKE_RUFF_MODE = 'emit';
  const projectDir = await makeTempDir('crs-ruff-emit-');
  const findings = await makeAnalyzer().analyze({
    projectDir,
    files: [{ path: 'a.py' }, { path: 'b.go' }],
    signal: undefined
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].source, 'analyzer');
  assert.equal(findings[0].analyzerId, 'ruff');
  assert.equal(findings[0].ruleId, 'F401');
  assert.equal(findings[0].file_path, 'a.py');
});

test('ruff fail with onAnalyzerError skip returns empty', async () => {
  process.env.CRS_FAKE_RUFF_MODE = 'fail';
  const projectDir = await makeTempDir('crs-ruff-skip-');
  const findings = await makeAnalyzer({ onAnalyzerError: 'skip' }).analyze({
    projectDir,
    files: [{ path: 'a.py' }],
    signal: undefined
  });
  assert.deepEqual(findings, []);
});

test('ruff fail with onAnalyzerError fail throws ANALYZER_FAILED', async () => {
  process.env.CRS_FAKE_RUFF_MODE = 'fail';
  const projectDir = await makeTempDir('crs-ruff-fail-');
  await assert.rejects(
    () =>
      makeAnalyzer({ onAnalyzerError: 'fail' }).analyze({
        projectDir,
        files: [{ path: 'a.py' }],
        signal: undefined
      }),
    (err) => err instanceof AppError && err.code === ErrorCodes.ANALYZER_FAILED
  );
});
