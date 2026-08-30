import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-workspace.js';
import { makeGitRepo, writeFile, git } from './helpers/temp-git-repo.js';
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
import { AppError } from '../src/shared/app-error.js';
import { ErrorCodes } from '../src/shared/error-codes.js';
import { analyzerRawFinding } from './helpers/policy-fixtures.js';

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

function createService({
  reportsDir,
  provider,
  idFactory,
  clock,
  config,
  remoteGitFetcher,
  analyzer,
  logger: loggerOverride
}) {
  const repository = createFileReportRepository({ reportsDir, idFactory });
  const logger =
    loggerOverride ??
    createLogger({
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
    idFactory: idFactory ?? (() => repository.createReviewId()),
    remoteGitFetcher,
    analyzer
  });
}

function analyzerEnabledConfig(reportsDir, overrides = {}) {
  return {
    ...defaultConfig(reportsDir),
    analyzer: {
      enabled: true,
      command: 'clang-tidy',
      args: [],
      timeoutMs: 60000,
      onAnalyzerError: 'skip',
      ...overrides
    }
  };
}

/**
 * @param {{
 *   findings?: object[],
 *   throwError?: AppError | null,
 *   onAnalyze?: (args: object) => void
 * }} opts
 */
function createFakeAnalyzer(opts = {}) {
  const { findings = [], throwError = null, onAnalyze } = opts;
  let analyzeCalls = 0;
  const analyzer = {
    async analyze(args) {
      analyzeCalls += 1;
      onAnalyze?.(args);
      if (throwError) throw throwError;
      return findings;
    },
    get analyzeCalls() {
      return analyzeCalls;
    }
  };
  return analyzer;
}

function remoteGitRequest(requirementFile, opts = {}) {
  const remoteUrl = opts.remoteUrl ?? 'https://github.com/org/my-repo.git';
  return {
    projectDir: null,
    requirementFile,
    sourceMode: 'REMOTE_GIT',
    remoteUrl,
    ref: opts.ref ?? 'main',
    reviewMode: opts.reviewMode ?? 'FULL_DIRECTORY',
    checklist: {
      enabled: false,
      path: null,
      includePaths: ['.'],
      excludePaths: []
    },
    projectName: 'my-repo',
    projectDirDisplay: null,
    requirementFileDisplay: toDisplayPath(requirementFile),
    checklistFileDisplay: null
  };
}

async function createFakeFetcherWithA() {
  const localDir = await makeTempDir('crs-remote-');
  await fs.writeFile(path.join(localDir, 'a.c'), 'int main() { return 0; }\n', 'utf8');
  return {
    async fetch() {
      return { localDir };
    }
  };
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

test('REMOTE_GIT: fetch then collect succeeds with sourceMode and remoteUrl in report', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { requirementFile } = await createProjectFixture();
  const remoteUrl = 'https://github.com/org/my-repo.git';
  let n = 0;
  const provider = createFakeReviewProvider({ rawOutput: HIGH_FINDING_JSON });
  const remoteGitFetcher = await createFakeFetcherWithA();
  const service = createService({
    reportsDir,
    provider,
    remoteGitFetcher,
    idFactory: () => `rg-${++n}`
  });

  const { reviewId } = service.enqueue(
    remoteGitRequest(requirementFile, { remoteUrl, reviewMode: 'FULL_DIRECTORY' }),
    { triggerType: 'MANUAL' }
  );
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'SUCCEEDED');

  const report = await service.getReport(reviewId);
  assert.equal(report.request.sourceMode, 'REMOTE_GIT');
  assert.equal(report.request.reviewMode, 'FULL_DIRECTORY');
  assert.equal(report.request.remoteUrl, remoteUrl);
  assert.ok(report.source.files.some((f) => f.path === 'a.c' || f.path.endsWith('a.c')));
});

test('REMOTE_GIT: provider receives fetched localDir as projectDir', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { requirementFile } = await createProjectFixture();
  let n = 0;
  /** @type {string | null} */
  let fetchedLocalDir = null;
  const remoteGitFetcher = {
    async fetch() {
      const localDir = await makeTempDir('crs-remote-');
      await fs.writeFile(path.join(localDir, 'a.c'), 'int main() { return 0; }\n', 'utf8');
      fetchedLocalDir = localDir;
      return { localDir };
    }
  };
  /** @type {string | null | undefined} */
  let providerProjectDir;
  const base = createFakeReviewProvider({ rawOutput: HIGH_FINDING_JSON });
  const provider = {
    async review(args) {
      providerProjectDir = args.projectDir;
      return base.review(args);
    }
  };
  const service = createService({
    reportsDir,
    provider,
    remoteGitFetcher,
    idFactory: () => `rgp-${++n}`
  });

  const { reviewId } = service.enqueue(remoteGitRequest(requirementFile), { triggerType: 'MANUAL' });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'SUCCEEDED');
  assert.notEqual(providerProjectDir, null);
  assert.equal(providerProjectDir, fetchedLocalDir);
});

test('REMOTE_GIT: fetch REMOTE_REF_NOT_FOUND yields FAILED report', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { requirementFile } = await createProjectFixture();
  let n = 0;
  const provider = createFakeReviewProvider({ rawOutput: HIGH_FINDING_JSON });
  const remoteGitFetcher = {
    async fetch() {
      throw new AppError(ErrorCodes.REMOTE_REF_NOT_FOUND, 'ref not found', []);
    }
  };
  const service = createService({
    reportsDir,
    provider,
    remoteGitFetcher,
    idFactory: () => `rgf-${++n}`
  });

  const { reviewId } = service.enqueue(remoteGitRequest(requirementFile), { triggerType: 'MANUAL' });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'FAILED');
  assert.equal(job.error.code, 'REMOTE_REF_NOT_FOUND');

  const report = await service.getReport(reviewId);
  assert.equal(report.status, 'FAILED');
  assert.equal(report.errors[0].code, 'REMOTE_REF_NOT_FOUND');
});

test('REMOTE_GIT: ephemeral fetch cleanup called once after job completes', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { requirementFile } = await createProjectFixture();
  let n = 0;
  let cleanupCalls = 0;
  const provider = createFakeReviewProvider({ rawOutput: HIGH_FINDING_JSON });
  const remoteGitFetcher = {
    async fetch() {
      const localDir = await makeTempDir('crs-ephemeral-');
      await fs.writeFile(path.join(localDir, 'a.c'), 'x\n', 'utf8');
      return {
        localDir,
        async cleanup() {
          cleanupCalls += 1;
        }
      };
    }
  };
  const service = createService({
    reportsDir,
    provider,
    remoteGitFetcher,
    idFactory: () => `rgc-${++n}`
  });

  const { reviewId } = service.enqueue(remoteGitRequest(requirementFile), { triggerType: 'MANUAL' });
  await waitUntilDone(service, reviewId);
  assert.equal(cleanupCalls, 1);
});

test('GIT_CHANGES without remoteGitFetcher behaves unchanged', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const projectDir = await makeGitRepo();
  await writeFile(projectDir, 'src/a.cpp', 'int* p = 0;\np->x;\n');
  await git(projectDir, ['add', '.']);
  await git(projectDir, ['commit', '-m', 'init']);
  await writeFile(projectDir, 'src/a.cpp', 'int x = 1;\nint* p = 0;\np->x;\n');
  const requirementFile = path.join(projectDir, 'req.md');
  await fs.writeFile(requirementFile, '# 需求\n返回 0\n', 'utf8');
  let n = 0;
  const provider = createFakeReviewProvider({ rawOutput: HIGH_FINDING_JSON });
  const service = createService({
    reportsDir,
    provider,
    idFactory: () => `gc-${++n}`
  });

  const req = normalizedRequest(projectDir, requirementFile);
  req.sourceMode = 'GIT_CHANGES';
  const { reviewId } = service.enqueue(req, { triggerType: 'MANUAL' });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'SUCCEEDED');

  const report = await service.getReport(reviewId);
  assert.equal(report.request.sourceMode, 'GIT_CHANGES');
  assert.equal(report.request.remoteUrl, null);
});

test('analyzer enabled: merges analyzer findings with AI findings', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createProjectFixture();
  let n = 0;
  const provider = createFakeReviewProvider({ rawOutput: HIGH_FINDING_JSON });
  const analyzerFinding = analyzerRawFinding({
    title: '未使用的变量',
    risk_level: 'LOW',
    description: '变量 x 未使用',
    file_path: 'src/a.cpp',
    line_start: 2,
    line_end: 2
  });
  const analyzer = createFakeAnalyzer({ findings: [analyzerFinding] });
  const service = createService({
    reportsDir,
    provider,
    analyzer,
    config: analyzerEnabledConfig(reportsDir),
    idFactory: () => `an-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'SUCCEEDED');

  const report = await service.getReport(reviewId);
  const sources = report.result.findings.map((f) => f.source);
  assert.ok(sources.includes('ai'));
  assert.ok(sources.includes('analyzer'));
  assert.equal(analyzer.analyzeCalls, 1);
});

test('analyzer ANALYZER_FAILED with onAnalyzerError skip: SUCCEEDED with AI findings and ANALYZER_SKIPPED log', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createProjectFixture();
  let n = 0;
  const provider = createFakeReviewProvider({ rawOutput: HIGH_FINDING_JSON });
  const logEntries = [];
  const logger = createLogger({
    stream: {
      write(chunk) {
        logEntries.push(JSON.parse(String(chunk)));
      }
    },
    clock: createSystemClock()
  });
  const analyzer = createFakeAnalyzer({
    throwError: new AppError(ErrorCodes.ANALYZER_FAILED, 'clang-tidy 执行失败', [])
  });
  const service = createService({
    reportsDir,
    provider,
    analyzer,
    logger,
    config: analyzerEnabledConfig(reportsDir, { onAnalyzerError: 'skip' }),
    idFactory: () => `ans-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'SUCCEEDED');

  const report = await service.getReport(reviewId);
  assert.ok(report.result.findings.length >= 1);
  assert.ok(
    logEntries.some(
      (e) =>
        e.event === ErrorCodes.ANALYZER_SKIPPED ||
        (e.errorCode === ErrorCodes.ANALYZER_SKIPPED && e.level === 'warn')
    )
  );
});

test('analyzer ANALYZER_FAILED with onAnalyzerError fail: task FAILED', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createProjectFixture();
  let n = 0;
  const provider = createFakeReviewProvider({ rawOutput: HIGH_FINDING_JSON });
  const analyzer = createFakeAnalyzer({
    throwError: new AppError(ErrorCodes.ANALYZER_FAILED, 'clang-tidy 执行失败', [])
  });
  const service = createService({
    reportsDir,
    provider,
    analyzer,
    config: analyzerEnabledConfig(reportsDir, { onAnalyzerError: 'fail' }),
    idFactory: () => `anf-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'FAILED');
  assert.equal(job.error.code, ErrorCodes.ANALYZER_FAILED);

  const report = await service.getReport(reviewId);
  assert.equal(report.errors[0].code, ErrorCodes.ANALYZER_FAILED);
});

test('analyzer null: no analyzer findings (regression)', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createProjectFixture();
  let n = 0;
  const provider = createFakeReviewProvider({ rawOutput: HIGH_FINDING_JSON });
  const service = createService({
    reportsDir,
    provider,
    analyzer: null,
    idFactory: () => `ann-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'SUCCEEDED');

  const report = await service.getReport(reviewId);
  assert.ok(report.result.findings.every((f) => f.source === 'ai' || f.source == null));
  assert.ok(!report.result.findings.some((f) => f.source === 'analyzer'));
});

test('analyzer.enabled=false: analyze not called, AI findings normal', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createProjectFixture();
  let n = 0;
  const provider = createFakeReviewProvider({ rawOutput: HIGH_FINDING_JSON });
  const analyzer = createFakeAnalyzer({
    findings: [analyzerRawFinding({ title: 'should-not-appear' })]
  });
  const service = createService({
    reportsDir,
    provider,
    analyzer,
    config: {
      ...defaultConfig(reportsDir),
      analyzer: { enabled: false }
    },
    idFactory: () => `and-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'SUCCEEDED');
  assert.equal(analyzer.analyzeCalls, 0);

  const report = await service.getReport(reviewId);
  assert.ok(report.result.findings.length >= 1);
  assert.ok(!report.result.findings.some((f) => f.source === 'analyzer'));
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

// ---------- Task 9: sharding ----------

/**
 * FakeReviewProvider variant that counts review calls, tracks max
 * concurrency, and returns per-call raw output (so each shard can return
 * distinct findings).
 *
 * @param {{
 *   rawOutputForCall?: (callNum: number, args: object) => string,
 *   delayMs?: number,
 *   throwErrorOnCall?: { call: number, error: Error } | null
 * }} opts
 */
function createShardCountingProvider(opts = {}) {
  const { rawOutputForCall, delayMs = 0, throwErrorOnCall = null } = opts;
  let calls = 0;
  let maxConcurrent = 0;
  let inFlight = 0;
  /** @type {{ promptFile: string, outputFile: string, promptText: string, files: object[] }[]} */
  const callsArgs = [];
  const provider = {
    async review(args) {
      calls += 1;
      const callNum = calls;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      let promptText = '';
      try {
        if (args?.promptFile) {
          try {
            promptText = await fs.readFile(args.promptFile, 'utf8');
          } catch {
            promptText = '';
          }
        }
        callsArgs.push({
          promptFile: args?.promptFile,
          outputFile: args?.outputFile,
          promptText,
          files: args?.files ?? []
        });
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        if (throwErrorOnCall && callNum === throwErrorOnCall.call) {
          throw throwErrorOnCall.error;
        }
        const raw =
          typeof rawOutputForCall === 'function'
            ? rawOutputForCall(callNum, args)
            : HIGH_FINDING_JSON;
        return {
          rawOutput: raw,
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 0,
          providerMetadata: { fake: true }
        };
      } finally {
        inFlight -= 1;
      }
    }
  };
  Object.defineProperty(provider, 'calls', { get: () => calls });
  Object.defineProperty(provider, 'maxConcurrent', { get: () => maxConcurrent });
  Object.defineProperty(provider, 'callsArgs', { get: () => callsArgs });
  return provider;
}

function shardFindingsJson(callNum, filePath = 'src/f0.cpp') {
  return JSON.stringify({
    summary: `shard ${callNum} summary`,
    overall_risk: 'HIGH',
    findings: [
      {
        category: 'CORRECTNESS',
        risk_level: 'HIGH',
        title: `shard-${callNum} finding`,
        description: `desc ${callNum}`,
        file_path: filePath,
        line_start: callNum,
        line_end: callNum,
        evidence: 'p->x 且 p 未判空',
        requirement_reference: '',
        fix_suggestion: '',
        fix_code: ''
      }
    ],
    evidence: [],
    recommended_actions: []
  });
}

async function createLargeProjectFixture({
  fileCount = 3,
  linesPerFile = 100,
  lineContent = 'x'.repeat(20)
}) {
  const projectDir = await makeTempDir('crs-proj-');
  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    const content = Array.from({ length: linesPerFile }, () => lineContent).join('\n') + '\n';
    await fs.writeFile(path.join(projectDir, 'src', `f${i}.cpp`), content, 'utf8');
  }
  const requirementFile = path.join(projectDir, 'req.md');
  await fs.writeFile(requirementFile, '# 需求\n返回 0\n', 'utf8');
  return { projectDir, requirementFile };
}

function shardingConfig(reportsDir, overrides = {}) {
  return {
    ...defaultConfig(reportsDir),
    sharding: {
      enabled: false,
      shardChars: 3000,
      maxShards: 20,
      maxConcurrency: 2,
      ...overrides
    }
  };
}

test('sharding: exceeds maxInputChars auto-shards, aggregates findings, review called >= 2', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createLargeProjectFixture({});
  let n = 0;
  const provider = createShardCountingProvider({
    rawOutputForCall: (callNum) => shardFindingsJson(callNum)
  });
  const config = shardingConfig(reportsDir, {
    shardChars: 3000,
    maxShards: 20,
    maxConcurrency: 2
  });
  config.review.maxInputChars = 4000; // total ~8100 > 4000 -> exceeds
  const service = createService({
    reportsDir,
    provider,
    config,
    idFactory: () => `sh-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'SUCCEEDED');
  assert.ok(provider.calls >= 2, `expected >= 2 review calls, got ${provider.calls}`);

  const report = await service.getReport(reviewId);
  const titles = report.result.findings.map((f) => f.title);
  for (let i = 1; i <= provider.calls; i++) {
    assert.ok(titles.includes(`shard-${i} finding`), `missing shard-${i} finding`);
  }
  assert.ok(Array.isArray(report.ai.shards), 'ai.shards must be array');
  assert.equal(report.ai.shards.length, provider.calls);
});

test('sharding: not exceeding + enabled=false -> single review call (regression)', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createProjectFixture();
  let n = 0;
  const provider = createShardCountingProvider({
    rawOutputForCall: () => HIGH_FINDING_JSON
  });
  const service = createService({
    reportsDir,
    provider,
    config: defaultConfig(reportsDir),
    idFactory: () => `sr-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'SUCCEEDED');
  assert.equal(provider.calls, 1);
  const report = await service.getReport(reviewId);
  assert.equal(report.ai.shards, undefined);
});

test('sharding: not exceeding + enabled=true + maxConcurrency=2 -> review called === shard count, concurrency <= 2', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createLargeProjectFixture({});
  let n = 0;
  const provider = createShardCountingProvider({
    rawOutputForCall: (callNum) => shardFindingsJson(callNum),
    delayMs: 30
  });
  const config = shardingConfig(reportsDir, {
    enabled: true,
    shardChars: 3000,
    maxShards: 20,
    maxConcurrency: 2
  });
  const service = createService({
    reportsDir,
    provider,
    config,
    idFactory: () => `se-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'SUCCEEDED');
  assert.ok(provider.calls >= 2, `expected >= 2 shards, got ${provider.calls}`);
  assert.ok(provider.maxConcurrent <= 2, `concurrency ${provider.maxConcurrent} > 2`);

  const report = await service.getReport(reviewId);
  assert.equal(report.ai.shards.length, provider.calls);
});

test('sharding: shard count > maxShards -> FAILED SHARD_LIMIT_EXCEEDED', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createLargeProjectFixture({});
  let n = 0;
  const provider = createShardCountingProvider({
    rawOutputForCall: () => HIGH_FINDING_JSON
  });
  const config = shardingConfig(reportsDir, {
    shardChars: 3000,
    maxShards: 1,
    maxConcurrency: 2
  });
  config.review.maxInputChars = 4000; // forces exceeds -> 3 shards > maxShards=1
  const service = createService({
    reportsDir,
    provider,
    config,
    idFactory: () => `sm-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'FAILED');
  assert.equal(job.error.code, ErrorCodes.SHARD_LIMIT_EXCEEDED);

  const report = await service.getReport(reviewId);
  assert.equal(report.errors[0].code, ErrorCodes.SHARD_LIMIT_EXCEEDED);
});

test('sharding: single shard provider failure -> task FAILED, error code propagated', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createLargeProjectFixture({});
  let n = 0;
  const provider = createShardCountingProvider({
    rawOutputForCall: (callNum) => shardFindingsJson(callNum),
    throwErrorOnCall: {
      call: 2,
      error: new AppError(ErrorCodes.CURSOR_TIMEOUT, '超时', [])
    }
  });
  const config = shardingConfig(reportsDir, {
    shardChars: 3000,
    maxShards: 20,
    maxConcurrency: 2
  });
  config.review.maxInputChars = 4000;
  const service = createService({
    reportsDir,
    provider,
    config,
    idFactory: () => `sf-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'FAILED');
  assert.equal(job.error.code, ErrorCodes.CURSOR_TIMEOUT);

  const report = await service.getReport(reviewId);
  assert.equal(report.errors[0].code, ErrorCodes.CURSOR_TIMEOUT);
});

test('sharding: report ai.shards entries have {index, files:[{path}], charCount}', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createLargeProjectFixture({});
  let n = 0;
  const provider = createShardCountingProvider({
    rawOutputForCall: (callNum) => shardFindingsJson(callNum)
  });
  const config = shardingConfig(reportsDir, {
    shardChars: 3000,
    maxShards: 20,
    maxConcurrency: 2
  });
  config.review.maxInputChars = 4000;
  const service = createService({
    reportsDir,
    provider,
    config,
    idFactory: () => `ss-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'SUCCEEDED');

  const report = await service.getReport(reviewId);
  const shards = report.ai.shards;
  assert.ok(Array.isArray(shards) && shards.length >= 2);
  for (const s of shards) {
    assert.ok(typeof s.index === 'number');
    assert.ok(Array.isArray(s.files) && s.files.length >= 1);
    for (const f of s.files) {
      assert.ok(typeof f.path === 'string');
    }
    assert.ok(typeof s.charCount === 'number' && s.charCount > 0);
  }
});

test('sharding: each shard receives a DISTINCT promptFile containing ONLY its own files', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createLargeProjectFixture({});
  let n = 0;
  const provider = createShardCountingProvider({
    rawOutputForCall: (callNum) => shardFindingsJson(callNum)
  });
  const config = shardingConfig(reportsDir, {
    shardChars: 3000,
    maxShards: 20,
    maxConcurrency: 2
  });
  config.review.maxInputChars = 4000;
  const service = createService({
    reportsDir,
    provider,
    config,
    idFactory: () => `sp-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'SUCCEEDED');
  assert.ok(provider.calls >= 2, `expected >= 2 shards, got ${provider.calls}`);

  const callsArgs = provider.callsArgs;
  // Distinct promptFile paths
  const promptFiles = callsArgs.map((c) => c.promptFile);
  assert.equal(new Set(promptFiles).size, promptFiles.length, 'promptFile paths must be unique');
  // Distinct outputFile paths
  const outputFiles = callsArgs.map((c) => c.outputFile);
  assert.equal(new Set(outputFiles).size, outputFiles.length, 'outputFile paths must be unique');
  // Each shard's prompt contains only its own file path, not all files
  const allPaths = callsArgs.map((c) => c.files.map((f) => f.path).sort().join(','));
  assert.equal(new Set(allPaths).size, allPaths.length, 'each shard must cover a distinct file set');
  for (const c of callsArgs) {
    const ownPaths = c.files.map((f) => f.path);
    for (const p of ownPaths) {
      assert.ok(c.promptText.includes(p), `prompt must include its file ${p}`);
    }
    // No shard prompt should mention another shard's file
    for (const other of callsArgs) {
      if (other === c) continue;
      for (const p of other.files.map((f) => f.path)) {
        assert.ok(!c.promptText.includes(p), `shard prompt must not include sibling file ${p}`);
      }
    }
  }
});

test('sharding: maxConcurrency=2 yields unique outputFile paths across concurrent shards', async () => {
  const reportsDir = await makeTempDir('crs-reports-');
  const { projectDir, requirementFile } = await createLargeProjectFixture({});
  let n = 0;
  const provider = createShardCountingProvider({
    rawOutputForCall: () => HIGH_FINDING_JSON,
    delayMs: 30
  });
  const config = shardingConfig(reportsDir, {
    shardChars: 3000,
    maxShards: 20,
    maxConcurrency: 2
  });
  config.review.maxInputChars = 4000;
  const service = createService({
    reportsDir,
    provider,
    config,
    idFactory: () => `so-${++n}`
  });

  const { reviewId } = service.enqueue(normalizedRequest(projectDir, requirementFile), {
    triggerType: 'MANUAL'
  });
  const job = await waitUntilDone(service, reviewId);
  assert.equal(job.status, 'SUCCEEDED');
  assert.ok(provider.maxConcurrent <= 2, `concurrency ${provider.maxConcurrent} > 2`);

  const outputFiles = provider.callsArgs.map((c) => c.outputFile);
  assert.equal(new Set(outputFiles).size, outputFiles.length, 'outputFile paths must be unique');
  for (const p of outputFiles) {
    assert.match(p, /shard-\d+-out\.json$/, `outputFile should be per-shard: ${p}`);
  }
});
