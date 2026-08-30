import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-workspace.js';
import { loadConfig } from '../src/shared/config.js';
import { ErrorCodes } from '../src/shared/error-codes.js';

async function writeTempConfig(dir, obj) {
  const file = path.join(dir, 'app.config.json');
  await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
  return file;
}

function baseConfig(overrides = {}) {
  return {
    server: { host: '127.0.0.1', port: 3100 },
    security: { allowedRoots: [path.resolve('/tmp/allowed-root-placeholder')] },
    review: {
      maxFiles: 50,
      maxFileChars: 80000,
      maxInputChars: 240000,
      maxRequirementChars: 50000,
      allowedExtensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hxx', '.java']
    },
    cursor: {
      command: 'cursor-agent',
      args: ['--prompt-file', '{promptFile}', '--workspace', '{projectDir}', '--output', '{outputFile}'],
      timeoutMs: 600000,
      maxOutputChars: 2000000
    },
    reports: { dir: './data/reports', includeAbsolutePaths: false },
    checklist: {
      enabled: true,
      path: './docs/rules/review-checklist.md',
      includePaths: ['.'],
      excludePaths: []
    },
    ai: {
      provider: 'cursor',
      remote: {
        baseUrl: 'https://api.example.com',
        model: 'review-model',
        apiKeyEnv: 'REMOTE_LLM_API_KEY',
        timeoutMs: 600000
      }
    },
    scheduler: {
      stateFile: './data/scheduler-state.json',
      profiles: []
    },
    ...overrides
  };
}

test('loadConfig throws Chinese error when file does not exist', async () => {
  const dir = await makeTempDir('crs-cfg-');
  const missing = path.join(dir, 'missing.json');
  await assert.rejects(
    () => loadConfig(missing),
    (err) => typeof err.message === 'string' && /配置/.test(err.message)
  );
});

test('loadConfig throws Chinese error when JSON is invalid', async () => {
  const dir = await makeTempDir('crs-cfg-');
  const file = path.join(dir, 'bad.json');
  await fs.writeFile(file, '{not-json', 'utf8');
  await assert.rejects(
    () => loadConfig(file),
    (err) => typeof err.message === 'string' && (/JSON|配置/.test(err.message))
  );
});

test('loadConfig throws Chinese error when allowedRoots is empty', async () => {
  const dir = await makeTempDir('crs-cfg-');
  const file = await writeTempConfig(dir, baseConfig({
    security: { allowedRoots: [] }
  }));
  await assert.rejects(
    () => loadConfig(file),
    (err) => typeof err.message === 'string' && /allowedRoots|根目录/.test(err.message)
  );
});

test('loadConfig rejects external fixed-rule path overrides like rules.globalPath', async () => {
  const dir = await makeTempDir('crs-cfg-');
  const root = await makeTempDir('crs-root-');
  const file = await writeTempConfig(dir, baseConfig({
    security: { allowedRoots: [root] },
    rules: { globalPath: './evil-global.md' }
  }));
  await assert.rejects(
    () => loadConfig(file),
    (err) => typeof err.message === 'string' && /规则/.test(err.message)
  );
});

test('loadConfig applies defaults and keeps cursor.args as array', async () => {
  const dir = await makeTempDir('crs-cfg-');
  const root = await makeTempDir('crs-root-');
  const file = await writeTempConfig(dir, {
    security: { allowedRoots: [root] },
    cursor: {
      command: 'cursor-agent',
      args: ['--prompt-file', '{promptFile}']
    }
  });
  const config = await loadConfig(file);
  assert.equal(config.review.maxFiles, 50);
  assert.equal(config.review.maxFileChars, 80000);
  assert.equal(config.review.maxInputChars, 240000);
  assert.equal(config.review.maxRequirementChars, 50000);
  assert.ok(Array.isArray(config.cursor.args));
  assert.deepEqual(config.cursor.args, ['--prompt-file', '{promptFile}']);
  assert.ok(config.security.allowedRoots.length >= 1);
  assert.equal(config.ai.provider, 'cursor');
  assert.ok(Array.isArray(config.scheduler.profiles));
});

test('loadConfig reads app.config.example.json shape', async () => {
  const examplePath = path.resolve('app.config.example.json');
  const config = await loadConfig(examplePath);
  assert.equal(config.server.port, 3100);
  assert.ok(config.security.allowedRoots.length >= 1);
  assert.ok(Array.isArray(config.cursor.args));
  assert.equal(config.ai.provider, 'cursor');
  assert.equal(config.scheduler.stateFile, './data/scheduler-state.json');
});

test('loadConfig applies remoteGit/analyzer/sharding defaults', async () => {
  const dir = await makeTempDir('crs-cfg-');
  const root = await makeTempDir('crs-root-');
  const file = await writeTempConfig(dir, baseConfig({
    security: { allowedRoots: [root] }
  }));
  const config = await loadConfig(file);
  assert.equal(config.remoteGit.workspaceDir, './data/remotes');
  assert.equal(config.remoteGit.ephemeral, false);
  assert.equal(config.remoteGit.fetchRetries, 3);
  assert.equal(config.analyzer.enabled, false);
  assert.equal(config.analyzer.tool, 'clang-tidy');
  assert.equal(config.analyzer.onAnalyzerError, 'skip');
  assert.equal(config.sharding.enabled, false);
  assert.equal(config.sharding.shardChars, 120000);
  assert.equal(config.sharding.maxShards, 20);
  assert.equal(config.sharding.maxConcurrency, 1);
});

test('loadConfig rejects invalid onAnalyzerError', async () => {
  const dir = await makeTempDir('crs-cfg-');
  const root = await makeTempDir('crs-root-');
  const file = await writeTempConfig(dir, baseConfig({
    security: { allowedRoots: [root] },
    analyzer: { onAnalyzerError: 'ignore' }
  }));
  await assert.rejects(
    () => loadConfig(file),
    (err) => typeof err.message === 'string' && /onAnalyzerError|skip|fail/.test(err.message)
  );
});

test('loadConfig rejects sharding values that are not >=1 integers', async () => {
  const dir = await makeTempDir('crs-cfg-');
  const root = await makeTempDir('crs-root-');

  for (const [field, value] of [
    ['shardChars', 0],
    ['shardChars', 1.5],
    ['maxShards', 0],
    ['maxConcurrency', -1]
  ]) {
    const file = await writeTempConfig(dir, baseConfig({
      security: { allowedRoots: [root] },
      sharding: { [field]: value }
    }));
    await assert.rejects(
      () => loadConfig(file),
      (err) => typeof err.message === 'string' && /sharding|整数|>=1/.test(err.message)
    );
  }
});

test('ErrorCodes includes remoteGit/analyzer/sharding error constants', () => {
  assert.equal(ErrorCodes.REMOTE_FETCH_FAILED, 'REMOTE_FETCH_FAILED');
  assert.equal(ErrorCodes.REMOTE_AUTH_FAILED, 'REMOTE_AUTH_FAILED');
  assert.equal(ErrorCodes.REMOTE_REF_NOT_FOUND, 'REMOTE_REF_NOT_FOUND');
  assert.equal(ErrorCodes.ANALYZER_SKIPPED, 'ANALYZER_SKIPPED');
  assert.equal(ErrorCodes.ANALYZER_FAILED, 'ANALYZER_FAILED');
  assert.equal(ErrorCodes.SHARD_LIMIT_EXCEEDED, 'SHARD_LIMIT_EXCEEDED');
});
