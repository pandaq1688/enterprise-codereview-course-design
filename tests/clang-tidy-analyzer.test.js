import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
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

test('export-fixes file is never written inside projectDir (uses os.tmpdir())', async () => {
  process.env.CRS_FAKE_TIDY_MODE = 'emit';
  const projectDir = await makeTempDir('crs-tidy-notmp-');
  const analyzer = makeAnalyzer({ mode: 'emit' });

  await analyzer.analyze({
    projectDir,
    files: [{ path: path.join(projectDir, 'a.c') }],
    signal: undefined
  });

  const entries = await fs.readdir(projectDir);
  const leaked = entries.filter((n) => /\.clang-tidy-fixes-.*\.yaml$/.test(n));
  assert.deepEqual(leaked, [], `projectDir must not contain clang-tidy fix files: ${JSON.stringify(leaked)}`);
});

test('export-fixes temp file under os.tmpdir() is cleaned up after analyze', async () => {
  // Custom fake clang-tidy that actually writes the --export-fixes file at the
  // path given via {outputFile}, so we can prove the analyzer's finally block
  // unlinks it. The script writes the fixes file plus a side-marker proving
  // it ran and created the file.
  const scriptDir = await makeTempDir('crs-tidy-script-');
  const scriptPath = path.join(scriptDir, 'fake-tidy-writes-fixes.mjs');
  const sideMarker = path.join(scriptDir, 'ran.marker');
  await fs.writeFile(
    scriptPath,
    [
      `import fs from 'node:fs';`,
      `import path from 'node:path';`,
      `const outputFile = process.argv[2];`,
      `const sideMarker = ${JSON.stringify(sideMarker)};`,
      `if (outputFile) fs.writeFileSync(outputFile, 'fixes: []\\n');`,
      `fs.writeFileSync(sideMarker, 'ran');`,
      `console.error('a.c:3:5: warning: unused variable [misc-unused]');`,
      `process.exit(0);`
    ].join('\n'),
    'utf8'
  );

  const projectDir = await makeTempDir('crs-tidy-cleanup-');
  const filePath = path.join(projectDir, 'a.c');
  const analyzer = createClangTidyAnalyzer({
    command: process.execPath,
    args: [scriptPath, '{outputFile}'],
    timeoutMs: 10_000,
    onAnalyzerError: 'skip',
    logger: null
  });

  const expectedOutputFile = path.join(
    os.tmpdir(),
    'crs-clang-tidy-fixes-' + Buffer.from(filePath).toString('hex').slice(0, 12) + '.yaml'
  );

  await analyzer.analyze({
    projectDir,
    files: [{ path: filePath }],
    signal: undefined
  });

  // The side-marker proves the fake actually ran and wrote the fixes file.
  await fs.access(sideMarker);

  // The fixes file must have been unlinked by the finally block.
  await assert.rejects(() => fs.access(expectedOutputFile), /ENOENT/);

  // And nothing leaked into projectDir.
  const entries = await fs.readdir(projectDir);
  const leaked = entries.filter((n) => /\.clang-tidy-fixes-.*\.yaml$/.test(n));
  assert.deepEqual(leaked, []);
});

test('export-fixes temp file is cleaned up even when clang-tidy fails', async () => {
  const scriptDir = await makeTempDir('crs-tidy-fail-script-');
  const scriptPath = path.join(scriptDir, 'fake-tidy-fail-writes-fixes.mjs');
  await fs.writeFile(
    scriptPath,
    [
      `import fs from 'node:fs';`,
      `const outputFile = process.argv[2];`,
      `if (outputFile) fs.writeFileSync(outputFile, 'fixes: []\\n');`,
      `console.error('error: boom');`,
      `process.exit(1);`
    ].join('\n'),
    'utf8'
  );

  const projectDir = await makeTempDir('crs-tidy-fail-cleanup-');
  const filePath = path.join(projectDir, 'a.c');
  const analyzer = createClangTidyAnalyzer({
    command: process.execPath,
    args: [scriptPath, '{outputFile}'],
    timeoutMs: 10_000,
    onAnalyzerError: 'skip',
    logger: null
  });

  const expectedOutputFile = path.join(
    os.tmpdir(),
    'crs-clang-tidy-fixes-' + Buffer.from(filePath).toString('hex').slice(0, 12) + '.yaml'
  );

  await analyzer.analyze({
    projectDir,
    files: [{ path: filePath }],
    signal: undefined
  });

  await assert.rejects(() => fs.access(expectedOutputFile), /ENOENT/);
});
