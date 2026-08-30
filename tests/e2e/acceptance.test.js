import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../../src/create-app.js';
import { createSystemClock } from '../../src/shared/clock.js';
import { createLogger } from '../../src/shared/logger.js';
import { ErrorCodes } from '../../src/shared/error-codes.js';
import {
  FAKE_OK_JSON,
  CHECKLIST_MARKER,
  createE2eConfig,
  createRecordingFakeProvider,
  createGitChangesFixture,
  createFullDirectoryFixture,
  createChecklistFixture,
  createPathOutsideFixture,
  createRemoteGitFixture,
  createFakeAnalyzer,
  createShardFixture,
  createShardCountingProvider,
  realTempDir
} from '../helpers/e2e-fixtures.js';
import { createFakeReviewProvider } from '../helpers/fake-review-provider.js';
import { createReviewJobService } from '../../src/review-job-service.js';
import { createFileReportRepository } from '../../src/file-report-repository.js';
import { collectFullDirectorySource } from '../../src/full-directory-source-collector.js';
import { collectGitChangedSource } from '../../src/git-changed-source-collector.js';
import { loadRequirement } from '../../src/requirement-loader.js';
import { resolveRules } from '../../src/rule-resolver.js';
import { buildPrompt } from '../../src/prompt-builder.js';
import { parseReviewOutput } from '../../src/review-result-parser.js';
import { applyPostReviewPolicy } from '../../src/post-review-policy.js';
import { toDisplayPath } from '../../src/request-validator.js';

/**
 * @param {import('node:http').Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {{ body?: object }} [opts]
 */
function request(server, method, urlPath, opts = {}) {
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const body = opts.body != null ? JSON.stringify(opts.body) : null;
  /** @type {Record<string, string>} */
  const headers = {};
  if (body != null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(Buffer.byteLength(body));
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode, body: raw, json });
        });
      }
    );
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * @param {import('node:http').Server} server
 * @param {string} reviewId
 * @param {number} [timeoutMs]
 */
async function pollUntilDone(server, reviewId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(server, 'GET', `/api/jobs/${reviewId}`);
    if (res.statusCode === 200 && res.json) {
      const status = res.json.status;
      if (status === 'SUCCEEDED' || status === 'FAILED') {
        return res.json;
      }
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`timeout waiting for job ${reviewId}`);
}

async function startApp({ allowedRoot, reportsDir, provider, configExtras = {}, analyzer, remoteGitFetcher, allowedRoots }) {
  const config = createE2eConfig({ allowedRoot, reportsDir, extras: configExtras });
  const quietLogger = createLogger({
    stream: { write() {} },
    clock: createSystemClock()
  });
  const app = await createApp({
    config,
    provider,
    logger: quietLogger,
    ...(analyzer ? { analyzer } : {}),
    ...(remoteGitFetcher ? { remoteGitFetcher } : {})
  });
  await app.start();
  return app;
}

test('AC-01: Git changes closed loop with GLOBAL+CPP, reports, SUCCEEDED', async () => {
  const fixture = await createGitChangesFixture();
  const provider = createRecordingFakeProvider({ rawOutput: FAKE_OK_JSON });
  const app = await startApp({
    allowedRoot: fixture.allowedRoot,
    reportsDir: fixture.reportsDir,
    provider
  });

  try {
    const created = await request(app.server, 'POST', '/api/reviews', {
      body: {
        projectDir: fixture.projectDir,
        requirementFile: fixture.requirementFile,
        sourceMode: 'GIT_CHANGES',
        checklist: { enabled: false }
      }
    });
    assert.equal(created.statusCode, 202);
    assert.equal(created.json.status, 'QUEUED');
    const reviewId = created.json.reviewId;
    assert.match(reviewId, /^[0-9a-f-]{36}$/i);

    const job = await pollUntilDone(app.server, reviewId);
    assert.equal(job.status, 'SUCCEEDED');

    const reportRes = await request(app.server, 'GET', `/api/reports/${reviewId}`);
    assert.equal(reportRes.statusCode, 200);
    const report = reportRes.json;
    const paths = report.source.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['src/base.cpp', 'src/staged.cpp', 'src/untracked.cpp']);
    const ruleTypes = report.rules.map((r) => r.ruleType).sort();
    assert.ok(ruleTypes.includes('GLOBAL'));
    assert.ok(ruleTypes.includes('CPP'));

    await fs.access(path.join(fixture.reportsDir, reviewId, 'report.json'));
    await fs.access(path.join(fixture.reportsDir, reviewId, 'report.html'));
  } finally {
    await app.stop({ waitMs: 5_000 });
  }
});

test('AC-02: full directory mixes languages; unsupported note.md not in prompt', async () => {
  const fixture = await createFullDirectoryFixture();
  const provider = createRecordingFakeProvider({ rawOutput: FAKE_OK_JSON });
  const app = await startApp({
    allowedRoot: fixture.allowedRoot,
    reportsDir: fixture.reportsDir,
    provider
  });

  try {
    const created = await request(app.server, 'POST', '/api/reviews', {
      body: {
        projectDir: fixture.projectDir,
        requirementFile: fixture.requirementFile,
        sourceMode: 'FULL_DIRECTORY',
        checklist: { enabled: false }
      }
    });
    assert.equal(created.statusCode, 202);
    const job = await pollUntilDone(app.server, created.json.reviewId);
    assert.equal(job.status, 'SUCCEEDED');

    const reportRes = await request(app.server, 'GET', `/api/reports/${created.json.reviewId}`);
    const report = reportRes.json;
    const paths = report.source.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['src/A.java', 'src/a.cpp']);
    assert.equal(paths.includes('note.md'), false);
    const ruleTypes = report.rules.map((r) => r.ruleType).sort();
    assert.deepEqual(ruleTypes, ['CPP', 'GLOBAL', 'JAVA']);

    assert.ok(provider.calls.length >= 1);
    const promptText = provider.calls[0].promptText;
    assert.equal(promptText.includes('note.md'), false);
    assert.ok(promptText.includes('src/a.cpp'));
    assert.ok(promptText.includes('src/A.java'));
  } finally {
    await app.stop({ waitMs: 5_000 });
  }
});

test('AC-03: checklist include/exclude and disable; config has no global-review path field', async () => {
  const fixture = await createChecklistFixture();
  const provider = createRecordingFakeProvider({ rawOutput: FAKE_OK_JSON });
  const app = await startApp({
    allowedRoot: fixture.allowedRoot,
    reportsDir: fixture.reportsDir,
    provider,
    configExtras: {
      checklist: {
        enabled: true,
        path: fixture.checklistFile,
        includePaths: ['src'],
        excludePaths: ['src/generated']
      }
    }
  });

  try {
    assert.equal(
      JSON.stringify(app.config).includes('global-review.md'),
      false,
      'config must not expose global-review.md path override fields'
    );

    const created = await request(app.server, 'POST', '/api/reviews', {
      body: {
        projectDir: fixture.projectDir,
        requirementFile: fixture.requirementFile,
        sourceMode: 'FULL_DIRECTORY',
        checklist: {
          enabled: true,
          path: fixture.checklistFile,
          includePaths: ['src'],
          excludePaths: ['src/generated']
        }
      }
    });
    assert.equal(created.statusCode, 202);
    const job = await pollUntilDone(app.server, created.json.reviewId);
    assert.equal(job.status, 'SUCCEEDED');

    const reportRes = await request(app.server, 'GET', `/api/reports/${created.json.reviewId}`);
    const checklistRule = reportRes.json.rules.find((r) => r.ruleType === 'CHECKLIST');
    assert.ok(checklistRule);
    assert.deepEqual(checklistRule.matchedFiles, ['src/a.cpp']);

    assert.ok(provider.calls[0].promptText.includes(CHECKLIST_MARKER));

    const created2 = await request(app.server, 'POST', '/api/reviews', {
      body: {
        projectDir: fixture.projectDir,
        requirementFile: fixture.requirementFile,
        sourceMode: 'FULL_DIRECTORY',
        checklist: { enabled: false }
      }
    });
    assert.equal(created2.statusCode, 202);
    const job2 = await pollUntilDone(app.server, created2.json.reviewId);
    assert.equal(job2.status, 'SUCCEEDED');
    assert.ok(provider.calls.length >= 2);
    assert.equal(provider.calls[1].promptText.includes(CHECKLIST_MARKER), false);
  } finally {
    await app.stop({ waitMs: 5_000 });
  }
});

test('AC-04: project path outside allowedRoots returns 400 PATH_OUTSIDE_ALLOWED_ROOT; symlink escape if possible', async () => {
  const fixture = await createPathOutsideFixture();
  const provider = createRecordingFakeProvider({ rawOutput: FAKE_OK_JSON });
  const app = await startApp({
    allowedRoot: fixture.allowedRoot,
    reportsDir: fixture.reportsDir,
    provider
  });

  try {
    const outside = await request(app.server, 'POST', '/api/reviews', {
      body: {
        projectDir: fixture.outsideProjectDir,
        requirementFile: fixture.outsideRequirementFile,
        sourceMode: 'FULL_DIRECTORY',
        checklist: { enabled: false }
      }
    });
    assert.equal(outside.statusCode, 400);
    assert.equal(outside.json.error.code, ErrorCodes.PATH_OUTSIDE_ALLOWED_ROOT);

    const link = path.join(fixture.allowedRoot, 'escape-link');
    try {
      await fs.symlink(fixture.outsideProjectDir, link, 'dir');
    } catch {
      // Plan-allowed: skip symlink branch when the OS denies symlink creation.
      return;
    }

    const escaped = await request(app.server, 'POST', '/api/reviews', {
      body: {
        projectDir: link,
        requirementFile: path.join(link, 'docs', 'requirement.md'),
        sourceMode: 'FULL_DIRECTORY',
        checklist: { enabled: false }
      }
    });
    assert.ok(escaped.statusCode >= 400 && escaped.statusCode < 500);
    assert.ok(
      escaped.json.error.code === ErrorCodes.PATH_SYMLINK_ESCAPE ||
        escaped.json.error.code === ErrorCodes.PATH_OUTSIDE_ALLOWED_ROOT
    );
  } finally {
    await app.stop({ waitMs: 5_000 });
  }
});

const AC06_FAKE_JSON = JSON.stringify({
  summary: 'AC-06 mixed findings',
  overall_risk: 'CRITICAL',
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
    },
    {
      category: 'CORRECTNESS',
      risk_level: 'MEDIUM',
      title: '可能存在隐患',
      description: '这里可能有空指针问题',
      file_path: 'src/a.cpp',
      line_start: 1,
      line_end: 1,
      evidence: '',
      requirement_reference: '',
      fix_suggestion: '',
      fix_code: ''
    },
    {
      category: 'CORRECTNESS',
      risk_level: 'CRITICAL',
      title: '越界文件问题',
      description: '不在本次选中范围内的文件',
      file_path: 'src/other.cpp',
      line_start: 1,
      line_end: 1,
      evidence: 'other()',
      requirement_reference: '',
      fix_suggestion: '',
      fix_code: ''
    },
    {
      category: 'CORRECTNESS',
      risk_level: 'MEDIUM',
      title: '空 指针 解引用',
      description: '重复项：与首项同类问题',
      file_path: 'src/a.cpp',
      line_start: 1,
      line_end: 1,
      evidence: 'p->y',
      requirement_reference: '',
      fix_suggestion: '',
      fix_code: ''
    },
    {
      category: 'CORRECTNESS',
      risk_level: 'FOO',
      title: '非法风险等级样例',
      description: '风险字段为非法枚举 FOO',
      file_path: 'src/a.cpp',
      line_start: 2,
      line_end: 2,
      evidence: 'int x = 1',
      requirement_reference: '',
      fix_suggestion: '',
      fix_code: ''
    }
  ],
  evidence: [],
  recommended_actions: []
});

test('AC-05: invalid AI JSON yields FAILED AI_OUTPUT_INVALID_JSON, empty findings, rawOutput kept', async () => {
  const fixture = await createFullDirectoryFixture();
  const provider = createRecordingFakeProvider({ rawOutput: 'not-json{{{' });
  const app = await startApp({
    allowedRoot: fixture.allowedRoot,
    reportsDir: fixture.reportsDir,
    provider
  });

  try {
    const created = await request(app.server, 'POST', '/api/reviews', {
      body: {
        projectDir: fixture.projectDir,
        requirementFile: fixture.requirementFile,
        sourceMode: 'FULL_DIRECTORY',
        checklist: { enabled: false }
      }
    });
    assert.equal(created.statusCode, 202);
    const job = await pollUntilDone(app.server, created.json.reviewId);
    assert.equal(job.status, 'FAILED');
    assert.equal(job.error.code, ErrorCodes.AI_OUTPUT_INVALID_JSON);

    const reportRes = await request(app.server, 'GET', `/api/reports/${created.json.reviewId}`);
    assert.equal(reportRes.statusCode, 200);
    const report = reportRes.json;
    assert.equal(report.status, 'FAILED');
    assert.equal(report.errors[0].code, ErrorCodes.AI_OUTPUT_INVALID_JSON);
    assert.deepEqual(report.result.findings, []);
    assert.ok(report.ai.rawOutput);
    assert.ok(report.ai.rawOutput.includes('not-json'));
  } finally {
    await app.stop({ waitMs: 5_000 });
  }
});

test('AC-06: policy statuses/policyIds; overallRisk from active primary findings only', async () => {
  const fixture = await createFullDirectoryFixture();
  const provider = createRecordingFakeProvider({ rawOutput: AC06_FAKE_JSON });
  const app = await startApp({
    allowedRoot: fixture.allowedRoot,
    reportsDir: fixture.reportsDir,
    provider
  });

  try {
    const created = await request(app.server, 'POST', '/api/reviews', {
      body: {
        projectDir: fixture.projectDir,
        requirementFile: fixture.requirementFile,
        sourceMode: 'FULL_DIRECTORY',
        checklist: { enabled: false }
      }
    });
    assert.equal(created.statusCode, 202);
    const job = await pollUntilDone(app.server, created.json.reviewId);
    assert.equal(job.status, 'SUCCEEDED');

    const reportRes = await request(app.server, 'GET', `/api/reports/${created.json.reviewId}`);
    const findings = reportRes.json.result.findings;
    assert.ok(findings.length >= 5);

    const byTitle = (t) => findings.find((f) => f.title === t || f.title?.includes?.(t));
    const valid = byTitle('空指针解引用');
    const speculative = byTitle('可能存在隐患');
    const oos = byTitle('越界文件问题');
    const dup = findings.find((f) => f.status === 'MERGED');
    const foo = byTitle('非法风险等级样例');

    assert.ok(valid);
    assert.notEqual(valid.status, 'EXEMPTED');
    assert.notEqual(valid.status, 'MERGED');
    assert.equal(valid.finalRisk, 'HIGH');
    assert.ok(valid.decisions.some((d) => d.policyId === 'PF-001'));

    assert.ok(speculative);
    assert.equal(speculative.status, 'EXEMPTED');
    assert.ok(speculative.decisions.some((d) => d.policyId === 'PF-004' && d.action === 'EXEMPTED'));

    assert.ok(oos);
    assert.equal(oos.status, 'EXEMPTED');
    assert.ok(oos.decisions.some((d) => d.policyId === 'PF-002' && d.action === 'EXEMPTED'));

    assert.ok(dup);
    assert.ok(dup.decisions.some((d) => d.policyId === 'PF-009' && d.action === 'MERGED'));

    assert.ok(foo);
    assert.ok(foo.decisions.some((d) => d.policyId === 'PF-001' && d.action === 'CORRECTED'));
    assert.equal(foo.finalRisk, 'LOW');

    assert.equal(reportRes.json.result.overallRisk, 'HIGH');
    assert.equal(reportRes.json.ai.rawOverallRisk, 'CRITICAL');
  } finally {
    await app.stop({ waitMs: 5_000 });
  }
});

test('AC-07: report.json keeps raw script text; report.html escapes it', async () => {
  const fixture = await createFullDirectoryFixture();
  const xssDesc = '触发 <script>alert(1)</script> 注入';
  const fakeJson = JSON.stringify({
    summary: 'AC-07 xss',
    overall_risk: 'LOW',
    findings: [
      {
        category: 'CORRECTNESS',
        risk_level: 'LOW',
        title: 'XSS sample',
        description: xssDesc,
        file_path: 'src/a.cpp',
        line_start: 1,
        line_end: 1,
        evidence: 'int x = 1',
        requirement_reference: '',
        fix_suggestion: '',
        fix_code: ''
      }
    ],
    evidence: [],
    recommended_actions: []
  });
  const provider = createRecordingFakeProvider({ rawOutput: fakeJson });
  const app = await startApp({
    allowedRoot: fixture.allowedRoot,
    reportsDir: fixture.reportsDir,
    provider
  });

  try {
    const created = await request(app.server, 'POST', '/api/reviews', {
      body: {
        projectDir: fixture.projectDir,
        requirementFile: fixture.requirementFile,
        sourceMode: 'FULL_DIRECTORY',
        checklist: { enabled: false }
      }
    });
    assert.equal(created.statusCode, 202);
    const job = await pollUntilDone(app.server, created.json.reviewId);
    assert.equal(job.status, 'SUCCEEDED');
    const reviewId = created.json.reviewId;

    const reportRes = await request(app.server, 'GET', `/api/reports/${reviewId}`);
    const finding = reportRes.json.result.findings.find((f) => f.title === 'XSS sample');
    assert.ok(finding);
    assert.equal(finding.description, xssDesc);
    assert.ok(finding.description.includes('<script>'));

    const htmlPath = path.join(fixture.reportsDir, reviewId, 'report.html');
    const html = await fs.readFile(htmlPath, 'utf8');
    assert.equal(html.includes('<script>alert(1)</script>'), false);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  } finally {
    await app.stop({ waitMs: 5_000 });
  }
});

function createJobServiceForAc08({ reportsDir, provider, idFactory }) {
  const repository = createFileReportRepository({ reportsDir, idFactory });
  const quietLogger = createLogger({
    stream: { write() {} },
    clock: createSystemClock()
  });
  const service = createReviewJobService({
    config: {
      review: {
        maxFiles: 50,
        maxFileChars: 80000,
        maxInputChars: 240000,
        maxRequirementChars: 50000
      },
      cursor: { timeoutMs: 600000, maxOutputChars: 2000000 },
      reports: { dir: reportsDir, includeAbsolutePaths: false },
      ai: { provider: 'fake' }
    },
    gitChangedCollector: collectGitChangedSource,
    fullDirectoryCollector: collectFullDirectorySource,
    requirementLoader: loadRequirement,
    ruleResolver: resolveRules,
    promptBuilder: buildPrompt,
    provider,
    parser: parseReviewOutput,
    policy: applyPostReviewPolicy,
    repository,
    clock: createSystemClock(),
    logger: quietLogger,
    idFactory: idFactory ?? (() => repository.createReviewId())
  });
  return { service, repository };
}

test('AC-08: restart keeps listSummaries report; in-memory QUEUED is not resurrected', async () => {
  const fixture = await createFullDirectoryFixture();
  let n = 0;
  const provider = createFakeReviewProvider({ rawOutput: FAKE_OK_JSON });
  const { service: service1, repository } = createJobServiceForAc08({
    reportsDir: fixture.reportsDir,
    provider,
    idFactory: () => `ac08-${++n}`
  });

  const normalized = {
    projectDir: fixture.projectDir,
    requirementFile: fixture.requirementFile,
    sourceMode: 'FULL_DIRECTORY',
    checklist: { enabled: false, path: null, includePaths: ['.'], excludePaths: [] },
    projectName: path.basename(fixture.projectDir),
    projectDirDisplay: toDisplayPath(fixture.projectDir),
    requirementFileDisplay: toDisplayPath(fixture.requirementFile),
    checklistFileDisplay: null
  };

  const { reviewId: doneId } = service1.enqueue(normalized, { triggerType: 'MANUAL' });
  const deadline = Date.now() + 10_000;
  let doneJob;
  while (Date.now() < deadline) {
    doneJob = await service1.getJob(doneId);
    if (doneJob && (doneJob.status === 'SUCCEEDED' || doneJob.status === 'FAILED')) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.equal(doneJob.status, 'SUCCEEDED');

  const slow = createFakeReviewProvider({ rawOutput: FAKE_OK_JSON, delayMs: 60_000 });
  const { service: serviceSlow } = createJobServiceForAc08({
    reportsDir: fixture.reportsDir,
    provider: slow,
    idFactory: () => `ac08-q-${++n}`
  });
  const queued = serviceSlow.enqueue(normalized, { triggerType: 'MANUAL' });
  assert.equal(queued.status, 'QUEUED');
  const queuedId = queued.reviewId;

  // Simulate restart: new job service only sharing reportsDir (drop in-memory jobs).
  const { service: service2, repository: repo2 } = createJobServiceForAc08({
    reportsDir: fixture.reportsDir,
    provider: createFakeReviewProvider({ rawOutput: FAKE_OK_JSON }),
    idFactory: () => `ac08-r-${++n}`
  });

  const summaries = await repo2.listSummaries();
  assert.ok(
    summaries.some((s) => s.reviewId === doneId),
    'listSummaries must retain saved report after restart'
  );

  const resurrected = await service2.getJob(queuedId);
  assert.ok(
    resurrected == null || resurrected.status !== 'QUEUED',
    'in-memory QUEUED job must not appear as QUEUED after restart'
  );
  assert.equal(
    summaries.some((s) => s.reviewId === queuedId && s.status === 'QUEUED'),
    false
  );

  // Abort the discarded slow worker so the test process does not wait on delayMs.
  serviceSlow.pauseAccepting();
  await serviceSlow.waitForIdle(100);
  assert.ok(repository);
});

// ---------------------------------------------------------------------------
// AC-10: Remote Git fetch (§21). Uses a local bare repo as the remote and the
// real remote-git-fetcher in ephemeral mode; no real network.
// ---------------------------------------------------------------------------

test('AC-10: REMOTE_GIT clone path → SUCCEEDED, source.files contains a.c', async () => {
  const fixture = await createRemoteGitFixture();
  const realTmp = await realTempDir();
  const provider = createRecordingFakeProvider({ rawOutput: FAKE_OK_JSON });
  const app = await startApp({
    allowedRoot: fixture.allowedRoot,
    reportsDir: fixture.reportsDir,
    provider,
    configExtras: {
      security: { allowedRoots: [fixture.allowedRoot, realTmp] },
      remoteGit: { ephemeral: true, fetchRetries: 0 }
    }
  });

  try {
    const remoteUrl = fixture.bare.replace(/\\/g, '/');
    const created = await request(app.server, 'POST', '/api/reviews', {
      body: {
        sourceMode: 'REMOTE_GIT',
        remoteUrl,
        ref: fixture.headRef,
        reviewMode: 'FULL_DIRECTORY',
        requirementFile: fixture.requirementFile,
        checklist: { enabled: false }
      }
    });
    assert.equal(created.statusCode, 202);
    const reviewId = created.json.reviewId;

    const job = await pollUntilDone(app.server, reviewId);
    assert.equal(job.status, 'SUCCEEDED');

    const reportRes = await request(app.server, 'GET', `/api/reports/${reviewId}`);
    assert.equal(reportRes.statusCode, 200);
    const report = reportRes.json;
    assert.equal(report.request.sourceMode, 'REMOTE_GIT');
    assert.equal(report.request.reviewMode, 'FULL_DIRECTORY');
    assert.equal(report.request.remoteUrl, remoteUrl);
    const paths = report.source.files.map((f) => f.path).sort();
    assert.ok(paths.includes('a.c'), `expected a.c in ${JSON.stringify(paths)}`);
  } finally {
    await app.stop({ waitMs: 5_000 });
  }
});

test('AC-10: REMOTE_GIT missing ref → FAILED REMOTE_REF_NOT_FOUND', async () => {
  const fixture = await createRemoteGitFixture();
  const realTmp = await realTempDir();
  const provider = createRecordingFakeProvider({ rawOutput: FAKE_OK_JSON });
  const app = await startApp({
    allowedRoot: fixture.allowedRoot,
    reportsDir: fixture.reportsDir,
    provider,
    configExtras: {
      security: { allowedRoots: [fixture.allowedRoot, realTmp] },
      remoteGit: { ephemeral: true, fetchRetries: 0 }
    }
  });

  try {
    const remoteUrl = fixture.bare.replace(/\\/g, '/');
    const created = await request(app.server, 'POST', '/api/reviews', {
      body: {
        sourceMode: 'REMOTE_GIT',
        remoteUrl,
        ref: 'does-not-exist',
        reviewMode: 'FULL_DIRECTORY',
        requirementFile: fixture.requirementFile,
        checklist: { enabled: false }
      }
    });
    assert.equal(created.statusCode, 202);
    const job = await pollUntilDone(app.server, created.json.reviewId);
    assert.equal(job.status, 'FAILED');
    assert.equal(job.error.code, ErrorCodes.REMOTE_REF_NOT_FOUND);

    const reportRes = await request(app.server, 'GET', `/api/reports/${created.json.reviewId}`);
    assert.equal(reportRes.statusCode, 200);
    assert.equal(reportRes.json.status, 'FAILED');
    assert.equal(reportRes.json.errors[0].code, ErrorCodes.REMOTE_REF_NOT_FOUND);
  } finally {
    await app.stop({ waitMs: 5_000 });
  }
});

// ---------------------------------------------------------------------------
// AC-11: External static analyzer (§22). FakeAnalyzer stands in for clang-tidy
// via overrides.analyzer; no real process spawn, no real LLM.
// ---------------------------------------------------------------------------

const AC11_AI_JSON = JSON.stringify({
  summary: 'AC-11 ai finding',
  overall_risk: 'LOW',
  findings: [
    {
      category: 'CORRECTNESS',
      risk_level: 'LOW',
      title: 'ai-finding',
      description: 'AI 发现的问题',
      file_path: 'src/a.cpp',
      line_start: 1,
      line_end: 1,
      evidence: 'int x = 1',
      requirement_reference: '',
      fix_suggestion: '',
      fix_code: ''
    }
  ],
  evidence: [],
  recommended_actions: []
});

/**
 * Build a fake analyzer finding shaped like the real clang-tidy analyzer's
 * (post-fix) output so the analyzer→PostReviewPolicy integration is exercised.
 * Mirrors src/clang-tidy-analyzer.js: policy-compatible fields plus legacy
 * severity/location/message kept for existing unit-test assertions.
 */
function fakeAnalyzerFinding({ file = 'src/a.cpp', line = 1, ruleId = 'misc-unused' } = {}) {
  return {
    source: 'analyzer',
    analyzerId: 'clang-tidy',
    ruleId,
    category: 'MAINTAINABILITY',
    risk_level: 'LOW',
    title: 'unused variable',
    description: 'unused variable',
    file_path: file,
    line_start: line,
    line_end: line,
    evidence: '',
    severity: 'minor',
    location: { file, line, column: 5 },
    message: 'unused variable'
  };
}

test('AC-11: analyzer finding coexists with AI finding in report', async () => {
  const fixture = await createFullDirectoryFixture();
  const provider = createRecordingFakeProvider({ rawOutput: AC11_AI_JSON });
  const analyzer = createFakeAnalyzer({ findings: [fakeAnalyzerFinding()] });
  const app = await startApp({
    allowedRoot: fixture.allowedRoot,
    reportsDir: fixture.reportsDir,
    provider,
    configExtras: { analyzer: { enabled: true, onAnalyzerError: 'skip' } },
    analyzer
  });

  try {
    const created = await request(app.server, 'POST', '/api/reviews', {
      body: {
        projectDir: fixture.projectDir,
        requirementFile: fixture.requirementFile,
        sourceMode: 'FULL_DIRECTORY',
        checklist: { enabled: false }
      }
    });
    assert.equal(created.statusCode, 202);
    const job = await pollUntilDone(app.server, created.json.reviewId);
    assert.equal(job.status, 'SUCCEEDED');

    const reportRes = await request(app.server, 'GET', `/api/reports/${created.json.reviewId}`);
    const findings = reportRes.json.result.findings;
    const aiFinding = findings.find((f) => f.title === 'ai-finding' && f.source !== 'analyzer');
    const analyzerFinding = findings.find(
      (f) => f.source === 'analyzer' && f.analyzerId === 'clang-tidy' && f.ruleId === 'misc-unused'
    );
    assert.ok(aiFinding, 'AI finding must be present');
    assert.ok(analyzerFinding, 'analyzer finding must be present and active');
    assert.equal(analyzerFinding.status !== 'EXEMPTED' && analyzerFinding.status !== 'MERGED', true);
  } finally {
    await app.stop({ waitMs: 5_000 });
  }
});

test('AC-11: onAnalyzerError=fail + analyzer throws → FAILED ANALYZER_FAILED', async () => {
  const fixture = await createFullDirectoryFixture();
  const provider = createRecordingFakeProvider({ rawOutput: AC11_AI_JSON });
  const analyzer = createFakeAnalyzer({ findings: [], throwOnce: true });
  const app = await startApp({
    allowedRoot: fixture.allowedRoot,
    reportsDir: fixture.reportsDir,
    provider,
    configExtras: { analyzer: { enabled: true, onAnalyzerError: 'fail' } },
    analyzer
  });

  try {
    const created = await request(app.server, 'POST', '/api/reviews', {
      body: {
        projectDir: fixture.projectDir,
        requirementFile: fixture.requirementFile,
        sourceMode: 'FULL_DIRECTORY',
        checklist: { enabled: false }
      }
    });
    assert.equal(created.statusCode, 202);
    const job = await pollUntilDone(app.server, created.json.reviewId);
    assert.equal(job.status, 'FAILED');
    assert.equal(job.error.code, ErrorCodes.ANALYZER_FAILED);

    const reportRes = await request(app.server, 'GET', `/api/reports/${created.json.reviewId}`);
    assert.equal(reportRes.json.errors[0].code, ErrorCodes.ANALYZER_FAILED);
  } finally {
    await app.stop({ waitMs: 5_000 });
  }
});

// ---------------------------------------------------------------------------
// AC-12: Large-project sharding (§23). FakeReviewProvider counts review calls
// and tracks concurrency; no real LLM.
// ---------------------------------------------------------------------------

test('AC-12: exceeding maxInputChars with sharding disabled auto-shards; review calls >= 2; ai.shards present', async () => {
  // 3 files, each 250 chars → numbered ~257 each → total ~771 > maxInputChars(500).
  // shardChars=200 → each file exceeds budget → 3 single-file shards.
  const fixture = await createShardFixture({ fileCount: 3, charsPerFile: 250 });
  const provider = createShardCountingProvider();
  const app = await startApp({
    allowedRoot: fixture.allowedRoot,
    reportsDir: fixture.reportsDir,
    provider,
    configExtras: {
      review: { maxFiles: 50, maxFileChars: 80000, maxInputChars: 500, maxRequirementChars: 50000 },
      sharding: { enabled: false, shardChars: 200, maxShards: 20, maxConcurrency: 1 }
    }
  });

  try {
    const created = await request(app.server, 'POST', '/api/reviews', {
      body: {
        projectDir: fixture.projectDir,
        requirementFile: fixture.requirementFile,
        sourceMode: 'FULL_DIRECTORY',
        checklist: { enabled: false }
      }
    });
    assert.equal(created.statusCode, 202);
    const job = await pollUntilDone(app.server, created.json.reviewId);
    assert.equal(job.status, 'SUCCEEDED');

    const reportRes = await request(app.server, 'GET', `/api/reports/${created.json.reviewId}`);
    const report = reportRes.json;
    assert.ok(Array.isArray(report.ai.shards), 'ai.shards must be present');
    assert.ok(report.ai.shards.length >= 2, `expected >=2 shards, got ${report.ai.shards.length}`);
    assert.equal(report.ai.shards.length, provider.calls.length);
    // Aggregated findings: one per shard, all active.
    const shardFindings = report.result.findings.filter((f) =>
      /^shard-finding-\d+$/.test(f.title ?? '')
    );
    assert.equal(shardFindings.length, provider.calls.length);
  } finally {
    await app.stop({ waitMs: 5_000 });
  }
});

test('AC-12: sharding enabled + maxConcurrency=2 non-exceeding → review calls === shard count, concurrency <= 2', async () => {
  // 3 files, each 150 chars → numbered ~157 each → total ~471 < maxInputChars(5000).
  // sharding.enabled=true forces planning; shardChars=200 → 3 shards.
  const fixture = await createShardFixture({ fileCount: 3, charsPerFile: 150 });
  const provider = createShardCountingProvider();
  const app = await startApp({
    allowedRoot: fixture.allowedRoot,
    reportsDir: fixture.reportsDir,
    provider,
    configExtras: {
      review: { maxFiles: 50, maxFileChars: 80000, maxInputChars: 5000, maxRequirementChars: 50000 },
      sharding: { enabled: true, shardChars: 200, maxShards: 20, maxConcurrency: 2 }
    }
  });

  try {
    const created = await request(app.server, 'POST', '/api/reviews', {
      body: {
        projectDir: fixture.projectDir,
        requirementFile: fixture.requirementFile,
        sourceMode: 'FULL_DIRECTORY',
        checklist: { enabled: false }
      }
    });
    assert.equal(created.statusCode, 202);
    const job = await pollUntilDone(app.server, created.json.reviewId);
    assert.equal(job.status, 'SUCCEEDED');

    const reportRes = await request(app.server, 'GET', `/api/reports/${created.json.reviewId}`);
    const report = reportRes.json;
    assert.ok(Array.isArray(report.ai.shards) && report.ai.shards.length >= 2);
    assert.equal(report.ai.shards.length, provider.calls.length);
    assert.ok(provider.maxConcurrency() <= 2, `maxConcurrency=${provider.maxConcurrency()}`);
  } finally {
    await app.stop({ waitMs: 5_000 });
  }
});

test('AC-12: shard count > maxShards → FAILED SHARD_LIMIT_EXCEEDED', async () => {
  // 5 files, each 10 chars → each > shardChars(5) → 5 single-file shards > maxShards(2).
  const fixture = await createShardFixture({ fileCount: 5, charsPerFile: 10 });
  const provider = createShardCountingProvider();
  const app = await startApp({
    allowedRoot: fixture.allowedRoot,
    reportsDir: fixture.reportsDir,
    provider,
    configExtras: {
      review: { maxFiles: 50, maxFileChars: 80000, maxInputChars: 5000, maxRequirementChars: 50000 },
      sharding: { enabled: true, shardChars: 5, maxShards: 2, maxConcurrency: 1 }
    }
  });

  try {
    const created = await request(app.server, 'POST', '/api/reviews', {
      body: {
        projectDir: fixture.projectDir,
        requirementFile: fixture.requirementFile,
        sourceMode: 'FULL_DIRECTORY',
        checklist: { enabled: false }
      }
    });
    assert.equal(created.statusCode, 202);
    const job = await pollUntilDone(app.server, created.json.reviewId);
    assert.equal(job.status, 'FAILED');
    assert.equal(job.error.code, ErrorCodes.SHARD_LIMIT_EXCEEDED);

    const reportRes = await request(app.server, 'GET', `/api/reports/${created.json.reviewId}`);
    assert.equal(reportRes.json.errors[0].code, ErrorCodes.SHARD_LIMIT_EXCEEDED);
  } finally {
    await app.stop({ waitMs: 5_000 });
  }
});
