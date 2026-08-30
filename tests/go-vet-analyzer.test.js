import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGoVetAnalyzer } from '../src/go-vet-analyzer.js';
import { makeTempDir } from './helpers/temp-workspace.js';
import { AppError } from '../src/shared/app-error.js';
import { ErrorCodes } from '../src/shared/error-codes.js';

const fakeScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'helpers',
  'fake-go-vet-script.mjs'
);

function makeAnalyzer(options = {}) {
  return createGoVetAnalyzer({
    command: process.execPath,
    args: [fakeScript, '{file}'],
    timeoutMs: options.timeoutMs ?? 10_000,
    onAnalyzerError: options.onAnalyzerError ?? 'skip',
    logger: options.logger ?? null
  });
}

test('go vet emit returns analyzer findings for .go files', async () => {
  process.env.CRS_FAKE_GOVET_MODE = 'emit';
  const projectDir = await makeTempDir('crs-govet-emit-');
  const findings = await makeAnalyzer().analyze({
    projectDir,
    files: [{ path: 'main.go' }, { path: 'a.py' }],
    signal: undefined
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].source, 'analyzer');
  assert.equal(findings[0].analyzerId, 'go-vet');
  assert.equal(findings[0].file_path, 'main.go');
  assert.equal(findings[0].line_start, 12);
});

test('go vet fail with onAnalyzerError fail throws ANALYZER_FAILED', async () => {
  process.env.CRS_FAKE_GOVET_MODE = 'fail';
  const projectDir = await makeTempDir('crs-govet-fail-');
  await assert.rejects(
    () =>
      makeAnalyzer({ onAnalyzerError: 'fail' }).analyze({
        projectDir,
        files: [{ path: 'main.go' }],
        signal: undefined
      }),
    (err) => err instanceof AppError && err.code === ErrorCodes.ANALYZER_FAILED
  );
});
