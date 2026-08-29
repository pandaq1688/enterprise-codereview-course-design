import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  LARGE_STDOUT_SCRIPT,
  writeFakeCursorScript
} from './helpers/fake-cursor-script.js';
import { ErrorCodes } from '../src/shared/error-codes.js';

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

test('non-zero exit yields CURSOR_EXIT_NON_ZERO', async () => {
  const dir = await makeTempDir('crs-cursor-exit-');
  const scriptPath = await writeFakeCursorScript(dir, 'fail-agent.mjs', EXIT_NON_ZERO_SCRIPT);
  const { promptFile, outputFile } = await makePromptAndOutput(dir);

  const provider = createCursorReviewProvider({
    command: process.execPath,
    args: [scriptPath],
    timeoutMs: 10_000,
    maxOutputChars: 100_000
  });

  await assert.rejects(
    () =>
      provider.review({
        projectDir: dir,
        promptFile,
        outputFile,
        timeoutMs: 10_000
      }),
    (err) => err.code === ErrorCodes.CURSOR_EXIT_NON_ZERO
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
