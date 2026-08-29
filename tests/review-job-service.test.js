import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-workspace.js';
import { createFakeReviewProvider } from './helpers/fake-review-provider.js';
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

const HIGH_FINDING_JSON = JSON.stringify({
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

async function createProjectFixture() {
  const projectDir = await makeTempDir('crs-proj-');
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

function defaultConfig(reportsDir) {
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

function createService({ reportsDir, provider, idFactory, clock, config }) {
  const repository = createFileReportRepository({ reportsDir, idFactory });
  const logger = createLogger({
    stream: { write() {} },
    clock: clock ?? createSystemClock()
  });
  return createReviewJobService({
    config: config ?? defaultConfig(reportsDir),
    gitChangedCollector: collectGitChangedSource,
    fullDirectoryCollector: collectFullDirectorySource,
    requirementLoader: loadRequirement,
    ruleResolver: resolveRules,
    promptBuilder: buildPrompt,
    provider,
    parser: parseReviewOutput,
    policy: applyPostReviewPolicy,
    repository,
    clock: clock ?? createSystemClock(),
    logger,
    idFactory: idFactory ?? (() => repository.createReviewId())
  });
}

async function waitUntilDone(service, reviewId, timeoutMs = 10000) {
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

test('happy path: SUCCEEDED report with policy overallRisk and ai.rawOverallRisk', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createProjectFixture();
  let n = 0;
  const provider = createFakeReviewProvider({ rawOutput: HIGH_FINDING_JSON });
  const service = createService({
    reportsDir,
    provider,
    idFactory: () => `rev-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'SUCCEEDED');

  const report = await service.getReport(reviewId);
  assert.equal(report.status, 'SUCCEEDED');
  assert.equal(report.request.triggerType, 'MANUAL');
  assert.equal(report.ai.rawOverallRisk, 'LOW');
  assert.notEqual(report.result.overallRisk, report.ai.rawOverallRisk);
  assert.equal(report.result.overallRisk, 'HIGH');
  assert.ok(report.result.findings.length >= 1);

  await fs.access(path.join(reportsDir, reviewId, 'report.json'));
  await fs.access(path.join(reportsDir, reviewId, 'report.html'));
});

test('invalid AI JSON yields FAILED with AI_OUTPUT_INVALID_JSON and empty findings', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createProjectFixture();
  let n = 0;
  const provider = createFakeReviewProvider({ rawOutput: 'not-json' });
  const service = createService({
    reportsDir,
    provider,
    idFactory: () => `bad-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'FAILED');
  // In-memory getJob must expose errors[0] (not only repository fallback)
  assert.ok(job.error, 'getJob must set error for in-memory FAILED jobs');
  assert.equal(job.error.code, 'AI_OUTPUT_INVALID_JSON');

  const report = await service.getReport(reviewId);
  assert.equal(report.status, 'FAILED');
  assert.equal(report.errors[0].code, 'AI_OUTPUT_INVALID_JSON');
  assert.deepEqual(report.result.findings, []);
  assert.equal(report.ai.rawOutput, 'not-json');
});

test('processes only one review at a time (concurrency 1)', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const fixtures = [await createProjectFixture(), await createProjectFixture()];
  let n = 0;
  let inFlight = 0;
  let overlap = false;

  const base = createFakeReviewProvider({ rawOutput: HIGH_FINDING_JSON, delayMs: 80 });
  const provider = {
    async review(args) {
      inFlight += 1;
      if (inFlight > 1) overlap = true;
      try {
        return await base.review(args);
      } finally {
        inFlight -= 1;
      }
    }
  };

  const service = createService({
    reportsDir,
    provider,
    idFactory: () => `conc-${++n}`
  });

  const a = service.enqueue(normalizedRequest(fixtures[0].projectDir, fixtures[0].requirementFile), {
    triggerType: 'MANUAL'
  });
  const b = service.enqueue(normalizedRequest(fixtures[1].projectDir, fixtures[1].requirementFile), {
    triggerType: 'MANUAL'
  });

  await waitUntilDone(service, a.reviewId);
  await waitUntilDone(service, b.reviewId);
  assert.equal(overlap, false);
});

test('provider=remote uses ai.remote.timeoutMs not cursor.timeoutMs', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createProjectFixture();
  let n = 0;
  /** @type {number | undefined} */
  let seenTimeout;
  const base = createFakeReviewProvider({ rawOutput: HIGH_FINDING_JSON });
  const provider = {
    async review(args) {
      seenTimeout = args.timeoutMs;
      return base.review(args);
    }
  };
  const config = {
    ...defaultConfig(reportsDir),
    cursor: { timeoutMs: 111_111, maxOutputChars: 2000000 },
    ai: {
      provider: 'remote',
      remote: { timeoutMs: 222_222 }
    }
  };
  const service = createService({
    reportsDir,
    provider,
    config,
    idFactory: () => `to-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  await waitUntilDone(service, reviewId);
  assert.equal(seenTimeout, 222_222);
});

test('provider=cursor uses cursor.timeoutMs', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createProjectFixture();
  let n = 0;
  /** @type {number | undefined} */
  let seenTimeout;
  const base = createFakeReviewProvider({ rawOutput: HIGH_FINDING_JSON });
  const provider = {
    async review(args) {
      seenTimeout = args.timeoutMs;
      return base.review(args);
    }
  };
  const config = {
    ...defaultConfig(reportsDir),
    cursor: { timeoutMs: 333_333, maxOutputChars: 2000000 },
    ai: {
      provider: 'cursor',
      remote: { timeoutMs: 444_444 }
    }
  };
  const service = createService({
    reportsDir,
    provider,
    config,
    idFactory: () => `toc-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  await waitUntilDone(service, reviewId);
  assert.equal(seenTimeout, 333_333);
});

test('unexpected non-AppError failures map to INTERNAL_ERROR with generic Chinese message', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createProjectFixture();
  let n = 0;
  const provider = {
    async review() {
      throw new Error('secret internal stacktrace xyz');
    }
  };
  const service = createService({
    reportsDir,
    provider,
    idFactory: () => `ie-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'FAILED');
  assert.equal(job.error.code, 'INTERNAL_ERROR');
  assert.match(job.error.message, /[\u4e00-\u9fff]/);
  assert.ok(!job.error.message.includes('secret'));
  assert.ok(!job.error.message.includes('stacktrace'));

  const report = await service.getReport(reviewId);
  assert.equal(report.errors[0].code, 'INTERNAL_ERROR');
  assert.ok(!report.errors[0].message.includes('secret'));
});
