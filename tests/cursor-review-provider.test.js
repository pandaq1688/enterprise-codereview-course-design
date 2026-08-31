import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as realSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCursorReviewProvider } from '../src/providers/cursor-review-provider.js';
import { createFakeReviewProvider } from './helpers/fake-review-provider.js';
import { makeTempDir } from './helpers/temp-workspace.js';
import {
  SUCCESS_SCRIPT,
  TIMEOUT_SCRIPT,
  EXIT_NON_ZERO_SCRIPT,
  FLAKY_THEN_OK_SCRIPT,
  LARGE_STDOUT_SCRIPT,
  LARGE_OUTPUT_FILE_SCRIPT,
  writeFakeCursorScript
} from './helpers/fake-cursor-script.js';
import { ErrorCodes } from '../src/shared/error-codes.js';

function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {};
  return child;
}

async function makePromptAndOutput(dir) {
  const promptFile = path.join(dir, 'prompt.txt');
  const outputFile = path.join(dir, 'output.json');
  await fs.writeFile(promptFile, 'prompt', 'utf8');
  await fs.writeFile(outputFile, '', 'utf8');
  return { promptFile, outputFile };
}

function wrapSpawn() {
  /** @type {import('node:child_process').SpawnOptions | undefined} */
  let lastOptions;
  /** @type {string[] | undefined} */
  let lastArgs;
  const spawnImpl = (command, args, options) => {
    lastArgs = args;
    lastOptions = options;
    return realSpawn(command, args, options);
  };
  return {
    spawnImpl,
    get lastOptions() {
      return lastOptions;
    },
    get lastArgs() {
      return lastArgs;
    }
  };
}

test('replaces placeholders, returns file rawOutput, and sets windowsHide', async () => {
  const dir = await makeTempDir('crs-cursor-ok-');
  const scriptPath = await writeFakeCursorScript(dir, 'fake-agent.mjs', SUCCESS_SCRIPT);
  const { promptFile, outputFile } = await makePromptAndOutput(dir);
  const projectDir = dir;
  const wrapped = wrapSpawn();

  const provider = createCursorReviewProvider({
    command: process.execPath,
    args: [
      scriptPath,
      '--prompt-file',
      '{promptFile}',
      '--workspace',
      '{projectDir}',
      '--output',
      '{outputFile}'
    ],
    timeoutMs: 10_000,
    maxOutputChars: 100_000,
    spawnImpl: wrapped.spawnImpl
  });

  const result = await provider.review({
    projectDir,
    promptFile,
    outputFile,
    timeoutMs: 10_000
  });

  assert.ok(wrapped.lastArgs);
  assert.ok(!wrapped.lastArgs.includes('{outputFile}'));
  assert.ok(!wrapped.lastArgs.includes('{promptFile}'));
  assert.ok(!wrapped.lastArgs.includes('{projectDir}'));
  assert.equal(wrapped.lastArgs[wrapped.lastArgs.indexOf('--output') + 1], outputFile);
  assert.equal(wrapped.lastOptions?.windowsHide, true);
  assert.equal(wrapped.lastOptions?.shell, false);
  assert.equal(
    result.rawOutput,
    '{"summary":"ok","overall_risk":"LOW","findings":[]}'
  );
  assert.equal(result.exitCode, 0);

  await assert.rejects(() => fs.access(promptFile), { code: 'ENOENT' });
  await assert.rejects(() => fs.access(outputFile), { code: 'ENOENT' });
});

test('times out with CURSOR_TIMEOUT', async () => {
  const dir = await makeTempDir('crs-cursor-timeout-');
  const scriptPath = await writeFakeCursorScript(dir, 'slow-agent.mjs', TIMEOUT_SCRIPT);
  const { promptFile, outputFile } = await makePromptAndOutput(dir);
  const wrapped = wrapSpawn();

  const provider = createCursorReviewProvider({
    command: process.execPath,
    args: [scriptPath, '--output', '{outputFile}'],
    timeoutMs: 50,
    maxOutputChars: 100_000,
    spawnImpl: wrapped.spawnImpl
  });

  await assert.rejects(
    () =>
      provider.review({
        projectDir: dir,
        promptFile,
        outputFile,
        timeoutMs: 50
      }),
    (err) => err.code === ErrorCodes.CURSOR_TIMEOUT && !String(err.message).includes('PATH=')
  );

  await assert.rejects(() => fs.access(promptFile), { code: 'ENOENT' });
  await assert.rejects(() => fs.access(outputFile), { code: 'ENOENT' });
});

test('non-zero exit yields CURSOR_EXIT_NON_ZERO with stderr details', async () => {
  const dir = await makeTempDir('crs-cursor-exit-');
  const scriptPath = await writeFakeCursorScript(dir, 'fail-agent.mjs', EXIT_NON_ZERO_SCRIPT);
  const { promptFile, outputFile } = await makePromptAndOutput(dir);

  const provider = createCursorReviewProvider({
    command: process.execPath,
    args: [scriptPath],
    timeoutMs: 10_000,
    maxOutputChars: 100_000,
    maxRetries: 0
  });

  await assert.rejects(
    () =>
      provider.review({
        projectDir: dir,
        promptFile,
        outputFile,
        timeoutMs: 10_000
      }),
    (err) =>
      err.code === ErrorCodes.CURSOR_EXIT_NON_ZERO &&
      Array.isArray(err.details) &&
      err.details.some((d) => String(d).includes('fake-agent boom details'))
  );
});

test('retries once after transient non-zero exit then succeeds', async () => {
  const dir = await makeTempDir('crs-cursor-retry-');
  const scriptPath = await writeFakeCursorScript(dir, 'flaky-agent.mjs', FLAKY_THEN_OK_SCRIPT);
  const { promptFile, outputFile } = await makePromptAndOutput(dir);

  const provider = createCursorReviewProvider({
    command: process.execPath,
    args: [scriptPath, '--output', '{outputFile}'],
    timeoutMs: 10_000,
    maxOutputChars: 100_000,
    maxRetries: 1
  });

  const result = await provider.review({
    projectDir: dir,
    promptFile,
    outputFile,
    timeoutMs: 10_000
  });

  assert.equal(result.exitCode, 0);
  assert.equal(
    result.rawOutput,
    '{"summary":"ok","overall_risk":"LOW","findings":[]}'
  );
});

test('does not replace partial placeholder tokens in args', async () => {
  const dir = await makeTempDir('crs-cursor-partial-');
  const scriptPath = await writeFakeCursorScript(dir, 'fake-agent.mjs', SUCCESS_SCRIPT);
  const { promptFile, outputFile } = await makePromptAndOutput(dir);
  const wrapped = wrapSpawn();

  const provider = createCursorReviewProvider({
    command: process.execPath,
    args: [
      scriptPath,
      'pre{promptFile}',
      '--prompt-file',
      '{promptFile}',
      '--workspace',
      '{projectDir}',
      '--output',
      '{outputFile}'
    ],
    timeoutMs: 10_000,
    maxOutputChars: 100_000,
    spawnImpl: wrapped.spawnImpl
  });

  await provider.review({
    projectDir: dir,
    promptFile,
    outputFile,
    timeoutMs: 10_000
  });

  assert.ok(wrapped.lastArgs?.includes('pre{promptFile}'));
  assert.equal(wrapped.lastArgs?.[wrapped.lastArgs.indexOf('--prompt-file') + 1], promptFile);
});

test('oversized stdout/stderr yields CURSOR_OUTPUT_TOO_LARGE', async () => {
  const dir = await makeTempDir('crs-cursor-large-');
  const scriptPath = await writeFakeCursorScript(dir, 'large-agent.mjs', LARGE_STDOUT_SCRIPT);
  const { promptFile, outputFile } = await makePromptAndOutput(dir);

  const provider = createCursorReviewProvider({
    command: process.execPath,
    args: [scriptPath],
    timeoutMs: 10_000,
    maxOutputChars: 100
  });

  await assert.rejects(
    () =>
      provider.review({
        projectDir: dir,
        promptFile,
        outputFile,
        timeoutMs: 10_000
      }),
    (err) => err.code === ErrorCodes.CURSOR_OUTPUT_TOO_LARGE
  );
});

test('missing command yields CURSOR_START_FAILED', async () => {
  const dir = await makeTempDir('crs-cursor-start-');
  const { promptFile, outputFile } = await makePromptAndOutput(dir);

  const provider = createCursorReviewProvider({
    command: path.join(dir, 'no-such-cursor-agent-binary'),
    args: ['--output', '{outputFile}'],
    timeoutMs: 5_000,
    maxOutputChars: 100_000
  });

  await assert.rejects(
    () =>
      provider.review({
        projectDir: dir,
        promptFile,
        outputFile,
        timeoutMs: 5_000
      }),
    (err) =>
      err.code === ErrorCodes.CURSOR_START_FAILED &&
      !JSON.stringify(err).includes(process.env.PATH ?? '__no_path__')
  );
});

test('FakeReviewProvider waits, optionally writes output file, returns fixed rawOutput', async () => {
  const dir = await makeTempDir('crs-fake-provider-');
  const outputFile = path.join(dir, 'out.json');
  const rawOutput = '{"summary":"fake","overall_risk":"HIGH","findings":[]}';
  const started = Date.now();

  const provider = createFakeReviewProvider({
    rawOutput,
    exitCode: 0,
    delayMs: 40,
    writeOutputFile: true
  });

  const result = await provider.review({
    projectDir: dir,
    promptFile: path.join(dir, 'prompt.txt'),
    outputFile,
    timeoutMs: 5_000
  });

  assert.ok(Date.now() - started >= 35);
  assert.equal(result.rawOutput, rawOutput);
  assert.equal(result.exitCode, 0);
  assert.equal(await fs.readFile(outputFile, 'utf8'), rawOutput);
});

test('abort signal yields CURSOR_ABORTED not CURSOR_TIMEOUT', async () => {
  const dir = await makeTempDir('crs-cursor-abort-');
  const scriptPath = await writeFakeCursorScript(dir, 'slow-agent.mjs', TIMEOUT_SCRIPT);
  const { promptFile, outputFile } = await makePromptAndOutput(dir);
  const ac = new AbortController();

  const provider = createCursorReviewProvider({
    command: process.execPath,
    args: [scriptPath, '--output', '{outputFile}'],
    timeoutMs: 60_000,
    maxOutputChars: 100_000
  });

  const pending = provider.review({
    projectDir: dir,
    promptFile,
    outputFile,
    timeoutMs: 60_000,
    signal: ac.signal
  });

  setTimeout(() => ac.abort(), 30);

  await assert.rejects(
    () => pending,
    (err) =>
      err.code === ErrorCodes.CURSOR_ABORTED &&
      err.code !== ErrorCodes.CURSOR_TIMEOUT &&
      !String(err.message).includes('超时')
  );
});

test('timer after clean exit does not yield CURSOR_TIMEOUT', async () => {
  mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  try {
    const dir = await makeTempDir('crs-cursor-race-');
    const { promptFile, outputFile } = await makePromptAndOutput(dir);
    const child = makeFakeChild();

    const provider = createCursorReviewProvider({
      command: 'fake-cursor',
      args: [],
      timeoutMs: 50,
      maxOutputChars: 100_000,
      spawnImpl: () => child
    });

    const pending = provider.review({
      projectDir: dir,
      promptFile,
      outputFile,
      timeoutMs: 50
    });

    // Process already exited; close event not yet delivered — timer must not win.
    child.exitCode = 0;
    mock.timers.tick(50);
    child.emit('close', 0);

    const result = await pending;
    assert.equal(result.exitCode, 0);
  } finally {
    mock.timers.reset();
  }
});

test('oversized output file yields CURSOR_OUTPUT_TOO_LARGE', async () => {
  const dir = await makeTempDir('crs-cursor-outfile-');
  const scriptPath = await writeFakeCursorScript(
    dir,
    'large-out-agent.mjs',
    LARGE_OUTPUT_FILE_SCRIPT
  );
  const { promptFile, outputFile } = await makePromptAndOutput(dir);

  const provider = createCursorReviewProvider({
    command: process.execPath,
    args: [scriptPath, '--output', '{outputFile}'],
    timeoutMs: 10_000,
    maxOutputChars: 100
  });

  await assert.rejects(
    () =>
      provider.review({
        projectDir: dir,
        promptFile,
        outputFile,
        timeoutMs: 10_000
      }),
    (err) => err.code === ErrorCodes.CURSOR_OUTPUT_TOO_LARGE
  );
});
