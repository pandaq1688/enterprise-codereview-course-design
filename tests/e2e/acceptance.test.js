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
  createPathOutsideFixture
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

async function startApp({ allowedRoot, reportsDir, provider, configExtras = {} }) {
  const config = createE2eConfig({ allowedRoot, reportsDir, extras: configExtras });
  const quietLogger = createLogger({
    stream: { write() {} },
    clock: createSystemClock()
  });
  const app = await createApp({ config, provider, logger: quietLogger });
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
