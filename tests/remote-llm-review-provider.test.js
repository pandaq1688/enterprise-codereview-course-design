import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRemoteLlmReviewProvider } from '../src/providers/remote-llm-review-provider.js';
import {
  createFakeHttpServer,
  chatCompletionsBody
} from './helpers/fake-http-server.js';
import { makeTempDir } from './helpers/temp-workspace.js';
import { ErrorCodes } from '../src/shared/error-codes.js';
import { AppError } from '../src/shared/app-error.js';
import { createApp } from '../src/create-app.js';
import { createReviewJobService } from '../src/review-job-service.js';
import { createFileReportRepository } from '../src/file-report-repository.js';
import { createSystemClock } from '../src/shared/clock.js';
import { createLogger } from '../src/shared/logger.js';
import { collectFullDirectorySource } from '../src/full-directory-source-collector.js';
import { collectGitChangedSource } from '../src/git-changed-source-collector.js';
import { loadRequirement } from '../src/requirement-loader.js';
import { resolveRules } from '../src/rule-resolver.js';
import { buildPrompt } from '../src/prompt-builder.js';
import { parseReviewOutput } from '../src/review-result-parser.js';
import { applyPostReviewPolicy } from '../src/post-review-policy.js';
import { toDisplayPath } from '../src/request-validator.js';
import { createFakeReviewProvider } from './helpers/fake-review-provider.js';
import { loadConfig } from '../src/shared/config.js';

const TEST_KEY = 'test-key';
const API_KEY_ENV = 'REMOTE_LLM_TEST_KEY_TASK20';

const FINDINGS_JSON = JSON.stringify({
  summary: '发现高风险问题',
  overall_risk: 'LOW',
  findings: [
    {
      category: 'CORRECTNESS',
      risk_level: 'HIGH',
      title: '空指针解引用',
      description: '在第 1 行对 p 解引用，p 未判空',
      file_path: 'src/a.cpp',
      line_start: 1,
      line_end: 1,
      evidence: 'p->x 且 p 未判空',
      requirement_reference: '',
      fix_suggestion: '先判空',
      fix_code: ''
    }
  ],
  evidence: [],
  recommended_actions: []
});

async function writePrompt(dir, text = 'review this code') {
  const promptFile = path.join(dir, 'prompt.txt');
  const outputFile = path.join(dir, 'output.json');
  await fs.writeFile(promptFile, text, 'utf8');
  await fs.writeFile(outputFile, '', 'utf8');
  return { promptFile, outputFile, projectDir: dir };
}

function makeProvider(baseUrl, overrides = {}) {
  return createRemoteLlmReviewProvider({
    baseUrl,
    model: 'review-model',
    apiKeyEnv: API_KEY_ENV,
    timeoutMs: 5_000,
    fetchImpl: globalThis.fetch.bind(globalThis),
    ...overrides
  });
}

function assertAppError(err, code) {
  assert.ok(err instanceof AppError, `expected AppError, got ${err}`);
  assert.equal(err.code, code);
}

test('合法响应 → provider.review 得到 content 字符串', async () => {
  process.env[API_KEY_ENV] = TEST_KEY;
  const server = createFakeHttpServer({
    statusCode: 200,
    body: chatCompletionsBody('hello-from-model')
  });
  const { baseUrl } = await server.listen();
  const dir = await makeTempDir('crs-remote-ok-');
  const ctx = await writePrompt(dir, 'prompt-text-abc');

  try {
    const provider = makeProvider(baseUrl);
    const result = await provider.review(ctx);

    assert.equal(result.rawOutput, 'hello-from-model');
    assert.equal(server.requests.length, 1);
    const req = server.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.authorizationStartsWithBearer, true);
    assert.ok(req.authorization.startsWith('Bearer '));
    assert.equal(req.authorization, `Bearer ${TEST_KEY}`);

    const body = JSON.parse(req.body);
    assert.equal(body.model, 'review-model');
    assert.equal(body.temperature, 0);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'prompt-text-abc' }]);
  } finally {
    await server.close();
    delete process.env[API_KEY_ENV];
  }
});

test('401 → REMOTE_LLM_AUTH_FAILED', async () => {
  process.env[API_KEY_ENV] = TEST_KEY;
  const server = createFakeHttpServer({ statusCode: 401, body: { error: 'unauthorized' } });
  const { baseUrl } = await server.listen();
  const dir = await makeTempDir('crs-remote-401-');
  const ctx = await writePrompt(dir);

  try {
    const provider = makeProvider(baseUrl);
    await assert.rejects(() => provider.review(ctx), (err) => {
      assertAppError(err, ErrorCodes.REMOTE_LLM_AUTH_FAILED);
      return true;
    });
  } finally {
    await server.close();
    delete process.env[API_KEY_ENV];
  }
});

test('429 → REMOTE_LLM_RATE_LIMITED', async () => {
  process.env[API_KEY_ENV] = TEST_KEY;
  const server = createFakeHttpServer({ statusCode: 429, body: { error: 'rate' } });
  const { baseUrl } = await server.listen();
  const dir = await makeTempDir('crs-remote-429-');
  const ctx = await writePrompt(dir);

  try {
    const provider = makeProvider(baseUrl);
    await assert.rejects(() => provider.review(ctx), (err) => {
      assertAppError(err, ErrorCodes.REMOTE_LLM_RATE_LIMITED);
      return true;
    });
  } finally {
    await server.close();
    delete process.env[API_KEY_ENV];
  }
});

test('500 → REMOTE_LLM_UNAVAILABLE', async () => {
  process.env[API_KEY_ENV] = TEST_KEY;
  const server = createFakeHttpServer({ statusCode: 500, body: { error: 'boom' } });
  const { baseUrl } = await server.listen();
  const dir = await makeTempDir('crs-remote-500-');
  const ctx = await writePrompt(dir);

  try {
    const provider = makeProvider(baseUrl);
    await assert.rejects(() => provider.review(ctx), (err) => {
      assertAppError(err, ErrorCodes.REMOTE_LLM_UNAVAILABLE);
      return true;
    });
  } finally {
    await server.close();
    delete process.env[API_KEY_ENV];
  }
});

test('不响应直到超时 → REMOTE_LLM_TIMEOUT', async () => {
  process.env[API_KEY_ENV] = TEST_KEY;
  const server = createFakeHttpServer({ hang: true });
  const { baseUrl } = await server.listen();
  const dir = await makeTempDir('crs-remote-timeout-');
  const ctx = await writePrompt(dir);

  try {
    const provider = makeProvider(baseUrl, { timeoutMs: 80 });
    await assert.rejects(() => provider.review(ctx), (err) => {
      assertAppError(err, ErrorCodes.REMOTE_LLM_TIMEOUT);
      return true;
    });
  } finally {
    await server.close();
    delete process.env[API_KEY_ENV];
  }
});

test('200 但 body 非 JSON → REMOTE_LLM_INVALID_RESPONSE', async () => {
  process.env[API_KEY_ENV] = TEST_KEY;
  const server = createFakeHttpServer({ statusCode: 200, body: 'not-json<<<' });
  const { baseUrl } = await server.listen();
  const dir = await makeTempDir('crs-remote-badjson-');
  const ctx = await writePrompt(dir);

  try {
    const provider = makeProvider(baseUrl);
    await assert.rejects(() => provider.review(ctx), (err) => {
      assertAppError(err, ErrorCodes.REMOTE_LLM_INVALID_RESPONSE);
      return true;
    });
  } finally {
    await server.close();
    delete process.env[API_KEY_ENV];
  }
});

async function createProjectFixture() {
  const projectDir = await makeTempDir('crs-remote-proj-');
  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectDir, 'src', 'a.cpp'), 'int* p = 0;\np->x;\n', 'utf8');
  const requirementFile = path.join(projectDir, 'req.md');
  await fs.writeFile(requirementFile, '# 需求\n返回 0\n', 'utf8');
  return { projectDir, requirementFile };
}

function normalizedRequest(projectDir, requirementFile) {
  return {
    projectDir,
    requirementFile,
    sourceMode: 'FULL_DIRECTORY',
    checklist: {
      enabled: false,
      path: null,
      includePaths: ['.'],
      excludePaths: []
    },
    projectName: path.basename(projectDir),
    projectDirDisplay: toDisplayPath(projectDir),
    requirementFileDisplay: toDisplayPath(requirementFile),
    checklistFileDisplay: null
  };
}

function defaultJobConfig(reportsDir) {
  return {
    review: {
      maxFiles: 50,
      maxFileChars: 80000,
      maxInputChars: 240000,
      maxRequirementChars: 50000
    },
    cursor: {
      timeoutMs: 600000,
      maxOutputChars: 2000000
    },
    reports: {
      dir: reportsDir,
      includeAbsolutePaths: false
    },
    ai: {
      provider: 'fake'
    }
  };
}

async function waitUntilDone(service, reviewId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await service.getJob(reviewId);
    if (job && (job.status === 'SUCCEEDED' || job.status === 'FAILED')) {
      return job;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for job ${reviewId}`);
}

function createService({ reportsDir, provider, logChunks }) {
  const repository = createFileReportRepository({ reportsDir });
  const clock = createSystemClock();
  const logger = createLogger({
    stream: {
      write(chunk) {
        if (logChunks) logChunks.push(String(chunk));
      }
    },
    clock
  });
  return createReviewJobService({
    config: defaultJobConfig(reportsDir),
    gitChangedCollector: collectGitChangedSource,
    fullDirectoryCollector: collectFullDirectorySource,
    requirementLoader: loadRequirement,
    ruleResolver: resolveRules,
    promptBuilder: buildPrompt,
    provider,
    parser: parseReviewOutput,
    policy: applyPostReviewPolicy,
    repository,
    clock,
    logger,
    idFactory: () => repository.createReviewId()
  });
}

test('同一 Fake 文本经 JobService 得到与 Fake 路径相同的 policy 结果', async () => {
  process.env[API_KEY_ENV] = TEST_KEY;
  const server = createFakeHttpServer({
    statusCode: 200,
    body: chatCompletionsBody(FINDINGS_JSON)
  });
  const { baseUrl } = await server.listen();
  const { projectDir, requirementFile } = await createProjectFixture();
  const reportsRemote = await makeTempDir('crs-remote-reports-');
  const reportsFake = await makeTempDir('crs-fake-reports-');

  try {
    const remoteProvider = makeProvider(baseUrl);
    const fakeProvider = createFakeReviewProvider({ rawOutput: FINDINGS_JSON });

    const remoteSvc = createService({ reportsDir: reportsRemote, provider: remoteProvider });
    const fakeSvc = createService({ reportsDir: reportsFake, provider: fakeProvider });

    const { reviewId: remoteId } = remoteSvc.enqueue(
      normalizedRequest(projectDir, requirementFile),
      { triggerType: 'MANUAL' }
    );
    const { reviewId: fakeId } = fakeSvc.enqueue(
      normalizedRequest(projectDir, requirementFile),
      { triggerType: 'MANUAL' }
    );

    const remoteJob = await waitUntilDone(remoteSvc, remoteId);
    const fakeJob = await waitUntilDone(fakeSvc, fakeId);
    assert.equal(remoteJob.status, 'SUCCEEDED');
    assert.equal(fakeJob.status, 'SUCCEEDED');

    const remoteReport = await remoteSvc.getReport(remoteId);
    const fakeReport = await fakeSvc.getReport(fakeId);

    assert.equal(remoteReport.result.overallRisk, fakeReport.result.overallRisk);
    assert.equal(remoteReport.result.overallRisk, 'HIGH');
    assert.equal(remoteReport.ai.rawOverallRisk, fakeReport.ai.rawOverallRisk);
    assert.equal(remoteReport.result.activeFindingCount, fakeReport.result.activeFindingCount);
    assert.equal(remoteReport.result.findings.length, fakeReport.result.findings.length);
  } finally {
    await server.close();
    delete process.env[API_KEY_ENV];
  }
});

test('logger/report 不含 test-key 与 Authorization', async () => {
  process.env[API_KEY_ENV] = TEST_KEY;
  const server = createFakeHttpServer({
    statusCode: 200,
    body: chatCompletionsBody(FINDINGS_JSON)
  });
  const { baseUrl } = await server.listen();
  const { projectDir, requirementFile } = await createProjectFixture();
  const reportsDir = await makeTempDir('crs-remote-noleak-');
  const logChunks = [];

  try {
    const provider = makeProvider(baseUrl);
    const service = createService({ reportsDir, provider, logChunks });
    const { reviewId } = service.enqueue(
      normalizedRequest(projectDir, requirementFile),
      { triggerType: 'MANUAL' }
    );
    const job = await waitUntilDone(service, reviewId);
    assert.equal(job.status, 'SUCCEEDED');

    const report = await service.getReport(reviewId);
    const reportJson = JSON.stringify(report);
    const logs = logChunks.join('');

    assert.ok(!reportJson.includes(TEST_KEY), 'report must not contain API key');
    assert.ok(!reportJson.includes('Authorization'), 'report must not contain Authorization');
    assert.ok(!logs.includes(TEST_KEY), 'logs must not contain API key');
    assert.ok(!logs.includes('Authorization'), 'logs must not contain Authorization');
    assert.ok(!logs.includes(`Bearer ${TEST_KEY}`));
  } finally {
    await server.close();
    delete process.env[API_KEY_ENV];
  }
});

function minimalAppConfig(allowedRoot, ai) {
  return {
    server: { host: '127.0.0.1', port: 0 },
    security: { allowedRoots: [allowedRoot] },
    review: {
      maxFiles: 50,
      maxFileChars: 80000,
      maxInputChars: 240000,
      maxRequirementChars: 50000,
      allowedExtensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hxx', '.java']
    },
    cursor: {
      command: 'cursor-agent',
      args: [
        '--prompt-file',
        '{promptFile}',
        '--workspace',
        '{projectDir}',
        '--output',
        '{outputFile}'
      ],
      timeoutMs: 600000,
      maxOutputChars: 2000000
    },
    reports: { dir: path.join(allowedRoot, 'reports'), includeAbsolutePaths: false },
    checklist: {
      enabled: false,
      path: './docs/rules/review-checklist.md',
      includePaths: ['.'],
      excludePaths: []
    },
    ai,
    scheduler: { stateFile: './data/scheduler-state.json', profiles: [] }
  };
}

test('createApp: provider=remote 且 env 缺失 → 启动 throw（不打印 key 值）', async () => {
  const missingEnv = 'REMOTE_LLM_API_KEY_TASK20_MISSING';
  delete process.env[missingEnv];
  const root = await makeTempDir('crs-remote-app-missing-');

  await assert.rejects(
    () =>
      createApp({
        config: minimalAppConfig(root, {
          provider: 'remote',
          remote: {
            baseUrl: 'http://127.0.0.1:9',
            model: 'review-model',
            apiKeyEnv: missingEnv,
            timeoutMs: 600000
          }
        })
      }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /环境变量|API Key|远程/);
      assert.ok(!err.message.includes(TEST_KEY));
      assert.ok(!/=\s*\S+/.test(err.message) || err.message.includes(missingEnv));
      return true;
    }
  );
});

test('createApp: provider=cursor 忽略 remote env 缺失', async () => {
  const missingEnv = 'REMOTE_LLM_API_KEY_TASK20_CURSOR_IGNORE';
  delete process.env[missingEnv];
  const root = await makeTempDir('crs-remote-app-cursor-');

  const app = await createApp({
    config: minimalAppConfig(root, {
      provider: 'cursor',
      remote: {
        baseUrl: 'http://127.0.0.1:9',
        model: 'review-model',
        apiKeyEnv: missingEnv,
        timeoutMs: 600000
      }
    }),
    provider: createFakeReviewProvider({ rawOutput: FINDINGS_JSON })
  });

  assert.ok(app);
  assert.equal(app.config.ai.provider, 'cursor');
});

test('loadConfig: provider=remote 且 env 缺失 → throw（不打印 key 值）', async () => {
  const missingEnv = 'REMOTE_LLM_API_KEY_TASK20_LOADCFG';
  delete process.env[missingEnv];
  const dir = await makeTempDir('crs-remote-loadcfg-');
  const cfgPath = path.join(dir, 'app.config.json');
  await fs.writeFile(
    cfgPath,
    JSON.stringify({
      security: { allowedRoots: [dir] },
      ai: {
        provider: 'remote',
        remote: {
          baseUrl: 'https://api.example.com',
          model: 'review-model',
          apiKeyEnv: missingEnv,
          timeoutMs: 600000
        }
      }
    }),
    'utf8'
  );

  await assert.rejects(
    () => loadConfig(cfgPath),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /环境变量|API Key|远程/);
      assert.ok(!err.message.includes(TEST_KEY));
      return true;
    }
  );
});
