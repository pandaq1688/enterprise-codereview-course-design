import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createClangTidyAnalyzer } from '../src/clang-tidy-analyzer.js';
import { fakeClangTidy } from './helpers/fake-clang-tidy.js';
import { makeTempDir } from './helpers/temp-workspace.js';
import { AppError } from '../src/shared/app-error.js';
import { ErrorCodes } from '../src/shared/error-codes.js';

/**
 * @param {object} options
 * @param {'emit' | 'fail' | 'timeout'} [options.mode]
 * @param {number} [options.timeoutMs]
 * @param {'skip' | 'fail'} [options.onAnalyzerError]
 * @param {{ warn?: (...args: unknown[]) => void } | null} [options.logger]
 */
function makeAnalyzer(options = {}) {
  const fake = fakeClangTidy({ mode: options.mode ?? 'emit' });
  return createClangTidyAnalyzer({
    command: fake.command,
    args: fake.args,
    timeoutMs: options.timeoutMs ?? 10_000,
    onAnalyzerError: options.onAnalyzerError ?? 'skip',
    logger: options.logger ?? null
  });
}

test('emit mode returns one RawFinding with analyzer metadata', async () => {
  process.env.CRS_FAKE_TIDY_MODE = 'emit';
  const projectDir = await makeTempDir('crs-tidy-emit-');
  const analyzer = makeAnalyzer({ mode: 'emit' });

  const findings = await analyzer.analyze({
    projectDir,
    files: [{ path: path.join(projectDir, 'a.c') }],
    signal: undefined
  });

  assert.equal(findings.length, 1);
  const finding = findings[0];
  assert.equal(finding.source, 'analyzer');
  assert.equal(finding.analyzerId, 'clang-tidy');
  assert.equal(finding.ruleId, 'misc-unused');
  assert.equal(finding.severity, 'minor');
  assert.ok(finding.location.file.endsWith('a.c'));
  assert.equal(finding.location.line, 3);
  assert.equal(finding.location.column, 5);
});

test('fail mode with onAnalyzerError skip returns empty and logs skip', async () => {
  process.env.CRS_FAKE_TIDY_MODE = 'fail';
  const projectDir = await makeTempDir('crs-tidy-skip-');
  const warnings = [];
  const logger = {
    warn(message) {
      warnings.push(String(message));
    }
  };
  const analyzer = makeAnalyzer({ mode: 'fail', onAnalyzerError: 'skip', logger });

  const findings = await analyzer.analyze({
    projectDir,
    files: [{ path: path.join(projectDir, 'a.c') }],
    signal: undefined
  });

  assert.deepEqual(findings, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ANALYZER_SKIPPED/);
  assert.match(warnings[0], /跳过/);
});

test('fail mode with onAnalyzerError fail throws ANALYZER_FAILED', async () => {
  process.env.CRS_FAKE_TIDY_MODE = 'fail';
  const projectDir = await makeTempDir('crs-tidy-fail-');
  const analyzer = makeAnalyzer({ mode: 'fail', onAnalyzerError: 'fail' });

  await assert.rejects(
    () =>
      analyzer.analyze({
        projectDir,
        files: [{ path: path.join(projectDir, 'a.c') }],
        signal: undefined
      }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, ErrorCodes.ANALYZER_FAILED);
      return true;
    }
  );
});

test('non C/C++ files are skipped without spawning clang-tidy', async () => {
  process.env.CRS_FAKE_TIDY_MODE = 'emit';
  const projectDir = await makeTempDir('crs-tidy-nospawn-');
  const marker = path.join(projectDir, 'spawn-marker.txt');
  process.env.CRS_FAKE_TIDY_MARKER = marker;
  const analyzer = makeAnalyzer({ mode: 'emit' });

  const findings = await analyzer.analyze({
    projectDir,
    files: [{ path: path.join(projectDir, 'a.md') }],
    signal: undefined
  });

  assert.deepEqual(findings, []);
  await assert.rejects(() => fs.access(marker), /ENOENT/);
  delete process.env.CRS_FAKE_TIDY_MARKER;
});

test('timeout mode with short timeoutMs throws ANALYZER_FAILED', async () => {
  process.env.CRS_FAKE_TIDY_MODE = 'timeout';
  const projectDir = await makeTempDir('crs-tidy-timeout-');
  const analyzer = makeAnalyzer({ mode: 'timeout', timeoutMs: 200, onAnalyzerError: 'skip' });

  await assert.rejects(
    () =>
      analyzer.analyze({
        projectDir,
        files: [{ path: path.join(projectDir, 'a.c') }],
        signal: undefined
      }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, ErrorCodes.ANALYZER_FAILED);
      return true;
    }
  );
});

test('aborted signal returns empty findings without throwing', async () => {
  process.env.CRS_FAKE_TIDY_MODE = 'emit';
  const projectDir = await makeTempDir('crs-tidy-abort-');
  const warnings = [];
  const logger = {
    warn(message) {
      warnings.push(String(message));
    }
  };
  const controller = new AbortController();
  controller.abort();
  const analyzer = makeAnalyzer({ mode: 'emit', logger });

  const findings = await analyzer.analyze({
    projectDir,
    files: [{ path: path.join(projectDir, 'a.c') }],
    signal: controller.signal
  });

  assert.deepEqual(findings, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ANALYZER_SKIPPED/);
  assert.match(warnings[0], /分析器已中止/);
});
