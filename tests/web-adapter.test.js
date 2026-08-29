import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-workspace.js';
import { createWebAdapter } from '../src/web/web-adapter.js';
import { validateCreateReviewRequest } from '../src/request-validator.js';
import { ErrorCodes } from '../src/shared/error-codes.js';

/**
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {{ body?: string, headers?: Record<string, string> }} [opts]
 */
function request(server, method, urlPath, opts = {}) {
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const headers = { ...(opts.headers ?? {}) };
  const body = opts.body ?? null;
  if (body != null && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (body != null && !headers['Content-Length'] && !headers['content-length']) {
    headers['Content-Length'] = Buffer.byteLength(body);
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
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: raw
          });
        });
      }
    );
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * @param {http.Server} server
 */
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });
  return server;
}

/**
 * @param {http.Server} server
 */
async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function setupAllowedProject() {
  const root = await makeTempDir('crs-web-root-');
  const projectDir = path.join(root, 'workspaces', 'demo');
  await fs.mkdir(projectDir, { recursive: true });
  const requirementFile = path.join(projectDir, 'docs', 'requirement.md');
  await fs.mkdir(path.dirname(requirementFile), { recursive: true });
  await fs.writeFile(requirementFile, '# req\n', 'utf8');
  return { root, projectDir, requirementFile };
}

function makeConfig(root, reportsDir) {
  return {
    security: { allowedRoots: [root] },
    reports: { dir: reportsDir, includeAbsolutePaths: false },
    checklist: {
      enabled: false,
      path: null,
      includePaths: ['.'],
      excludePaths: []
    },
    review: {
      maxFiles: 50,
      maxFileChars: 80000,
      maxInputChars: 240000,
      maxRequirementChars: 50000
    },
    server: { host: '127.0.0.1', port: 0 }
  };
}

function makeFakeJobService({ reviewId = 'fixed-review-id' } = {}) {
  /** @type {Map<string, object>} */
  const jobs = new Map();
  /** @type {object[]} */
  const reports = [];
  let accepting = true;
  let queueLength = 0;
  let currentReviewId = null;

  return {
    enqueue(normalizedRequest, { triggerType }) {
      queueLength += 1;
      const job = {
        reviewId,
        status: 'QUEUED',
        createdAt: '2026-01-01T00:00:00.000Z',
        completedAt: null,
        durationMs: null,
        triggerType,
        error: null,
        request: normalizedRequest
      };
      jobs.set(reviewId, job);
      return { reviewId, status: 'QUEUED' };
    },
    async getJob(id) {
      return jobs.get(id) ?? null;
    },
    async listReports() {
      return reports.map((r) => ({
        createdAt: r.createdAt,
        projectName: r.request?.projectName,
        sourceMode: r.request?.sourceMode,
        status: r.status,
        overallRisk: r.result?.overallRisk,
        activeFindingCount: r.result?.activeFindingCount,
        exemptedFindingCount: r.result?.exemptedFindingCount,
        durationMs: r.durationMs,
        reviewId: r.reviewId
      }));
    },
    async getReport(id) {
      const found = reports.find((r) => r.reviewId === id);
      if (!found) {
        const err = new Error('not found');
        throw err;
      }
      return found;
    },
    getHealthSnapshot() {
      return { accepting, queueLength, currentReviewId };
    },
    /** @param {object} report */
    _addReport(report) {
      reports.push(report);
      jobs.set(report.reviewId, {
        reviewId: report.reviewId,
        status: report.status,
        createdAt: report.createdAt,
        completedAt: report.completedAt ?? null,
        durationMs: report.durationMs ?? null,
        triggerType: report.request?.triggerType ?? null,
        error: report.errors?.[0] ?? null
      });
    },
    _setHealth({ accepting: a, queueLength: q, currentReviewId: c } = {}) {
      if (a !== undefined) accepting = a;
      if (q !== undefined) queueLength = q;
      if (c !== undefined) currentReviewId = c;
    }
  };
}

test('POST /api/reviews with invalid body returns 400 INVALID_REQUEST', async () => {
  const { root } = await setupAllowedProject();
  const reportsDir = await makeTempDir('crs-web-reports-');
  const jobService = makeFakeJobService();
  const server = createWebAdapter({
    jobService,
    config: makeConfig(root, reportsDir),
    validateRequest: validateCreateReviewRequest
  });
  await listen(server);
  try {
    const res = await request(server, 'POST', '/api/reviews', {
      body: JSON.stringify({ sourceMode: 'FULL_DIRECTORY' })
    });
    assert.equal(res.statusCode, 400);
    const json = JSON.parse(res.body);
    assert.equal(json.error.code, ErrorCodes.INVALID_REQUEST);
    assert.ok(typeof json.error.message === 'string');
    assert.ok(Array.isArray(json.error.details));
  } finally {
    await close(server);
  }
});

test('POST /api/reviews with valid body returns 202 QUEUED', async () => {
  const { root, projectDir, requirementFile } = await setupAllowedProject();
  const reportsDir = await makeTempDir('crs-web-reports-');
  const jobService = makeFakeJobService({ reviewId: 'fixed-review-id' });
  const server = createWebAdapter({
    jobService,
    config: makeConfig(root, reportsDir),
    validateRequest: validateCreateReviewRequest
  });
  await listen(server);
  try {
    const res = await request(server, 'POST', '/api/reviews', {
      body: JSON.stringify({
        projectDir,
        requirementFile,
        sourceMode: 'FULL_DIRECTORY'
      })
    });
    assert.equal(res.statusCode, 202);
    const json = JSON.parse(res.body);
    assert.deepEqual(json, { reviewId: 'fixed-review-id', status: 'QUEUED' });
  } finally {
    await close(server);
  }
});

test('GET /api/health has status fields and omits secrets', async () => {
  const { root } = await setupAllowedProject();
  const reportsDir = await makeTempDir('crs-web-reports-');
  const jobService = makeFakeJobService();
  jobService._setHealth({
    accepting: true,
    queueLength: 2,
    currentReviewId: 'job-1'
  });
  const config = makeConfig(root, reportsDir);
  config.security.allowedRoots = [root, path.join(root, 'secret-root')];
  const server = createWebAdapter({
    jobService,
    config,
    validateRequest: validateCreateReviewRequest
  });
  await listen(server);
  try {
    const res = await request(server, 'GET', '/api/health');
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.status, 'ok');
    assert.equal(json.queueLength, 2);
    assert.equal(json.currentReviewId, 'job-1');
    assert.equal(json.accepting, true);
    const raw = res.body;
    assert.equal(raw.includes('allowedRoots'), false);
    assert.equal(raw.includes('secret-root'), false);
    assert.equal(raw.includes(root), false);
    assert.equal(raw.includes('REMOTE_LLM_API_KEY'), false);
    assert.equal(raw.includes('process.env'), false);
  } finally {
    await close(server);
  }
});

test('GET / serves form with §13.3 field names and history table', async () => {
  const { root } = await setupAllowedProject();
  const reportsDir = await makeTempDir('crs-web-reports-');
  const jobService = makeFakeJobService();
  jobService._addReport({
    reviewId: 'hist-1',
    createdAt: '2026-01-02T00:00:00.000Z',
    status: 'SUCCEEDED',
    durationMs: 10,
    request: { projectName: 'demo<script>', sourceMode: 'GIT_CHANGES' },
    result: {
      overallRisk: 'LOW',
      activeFindingCount: 0,
      exemptedFindingCount: 1
    }
  });
  const server = createWebAdapter({
    jobService,
    config: makeConfig(root, reportsDir),
    validateRequest: validateCreateReviewRequest
  });
  await listen(server);
  try {
    const res = await request(server, 'GET', '/');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] ?? '', /text\/html/);
    assert.match(res.body, /name="projectDir"/);
    assert.match(res.body, /name="requirementFile"/);
    assert.match(res.body, /name="sourceMode"/);
    assert.match(res.body, /name="checklist\.enabled"/);
    assert.match(res.body, /name="checklist\.path"/);
    assert.match(res.body, /name="checklist\.includePaths"/);
    assert.match(res.body, /demo&lt;script&gt;/);
    assert.match(res.body, /hist-1/);
  } finally {
    await close(server);
  }
});

test('GET /jobs/:id page polls /api/jobs/:id', async () => {
  const { root } = await setupAllowedProject();
  const reportsDir = await makeTempDir('crs-web-reports-');
  const jobService = makeFakeJobService({ reviewId: 'poll-me' });
  jobService.enqueue(
    { projectName: 'x', projectDir: root, requirementFile: root, sourceMode: 'FULL_DIRECTORY' },
    { triggerType: 'MANUAL' }
  );
  const server = createWebAdapter({
    jobService,
    config: makeConfig(root, reportsDir),
    validateRequest: validateCreateReviewRequest
  });
  await listen(server);
  try {
    const res = await request(server, 'GET', '/jobs/poll-me');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /\/api\/jobs\/poll-me/);
    assert.match(res.body, /poll-me/);
  } finally {
    await close(server);
  }
});

test('GET /api/jobs/:id returns job status', async () => {
  const { root } = await setupAllowedProject();
  const reportsDir = await makeTempDir('crs-web-reports-');
  const jobService = makeFakeJobService({ reviewId: 'job-api' });
  jobService.enqueue(
    { projectName: 'x', projectDir: root, requirementFile: root, sourceMode: 'FULL_DIRECTORY' },
    { triggerType: 'MANUAL' }
  );
  const server = createWebAdapter({
    jobService,
    config: makeConfig(root, reportsDir),
    validateRequest: validateCreateReviewRequest
  });
  await listen(server);
  try {
    const res = await request(server, 'GET', '/api/jobs/job-api');
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.reviewId, 'job-api');
    assert.equal(json.status, 'QUEUED');
  } finally {
    await close(server);
  }
});

test('GET /api/reports and /api/reports/:id', async () => {
  const { root } = await setupAllowedProject();
  const reportsDir = await makeTempDir('crs-web-reports-');
  const jobService = makeFakeJobService();
  const report = {
    reviewId: 'rep-1',
    createdAt: '2026-01-03T00:00:00.000Z',
    status: 'SUCCEEDED',
    durationMs: 5,
    request: { projectName: 'p', sourceMode: 'FULL_DIRECTORY' },
    result: { overallRisk: 'MEDIUM', activeFindingCount: 2, exemptedFindingCount: 0, findings: [] }
  };
  jobService._addReport(report);
  const server = createWebAdapter({
    jobService,
    config: makeConfig(root, reportsDir),
    validateRequest: validateCreateReviewRequest
  });
  await listen(server);
  try {
    const list = await request(server, 'GET', '/api/reports');
    assert.equal(list.statusCode, 200);
    const summaries = JSON.parse(list.body);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].reviewId, 'rep-1');

    const one = await request(server, 'GET', '/api/reports/rep-1');
    assert.equal(one.statusCode, 200);
    assert.equal(JSON.parse(one.body).reviewId, 'rep-1');
  } finally {
    await close(server);
  }
});

test('GET /reports/:id escapes echoed content; file routes serve or 404', async () => {
  const { root } = await setupAllowedProject();
  const reportsDir = await makeTempDir('crs-web-reports-');
  const jobService = makeFakeJobService();
  const report = {
    reviewId: 'web-rep',
    createdAt: '2026-01-04T00:00:00.000Z',
    completedAt: '2026-01-04T00:00:01.000Z',
    status: 'SUCCEEDED',
    durationMs: 1,
    request: {
      projectName: 'proj<img>',
      sourceMode: 'GIT_CHANGES',
      projectDirDisplay: 'a/b'
    },
    result: {
      overallRisk: 'LOW',
      activeFindingCount: 0,
      exemptedFindingCount: 0,
      findings: []
    },
    errors: []
  };
  jobService._addReport(report);

  const reportDir = path.join(reportsDir, 'web-rep');
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, 'report.json'), JSON.stringify(report), 'utf8');
  await fs.writeFile(path.join(reportDir, 'report.html'), '<html>file</html>', 'utf8');

  const server = createWebAdapter({
    jobService,
    config: makeConfig(root, reportsDir),
    validateRequest: validateCreateReviewRequest
  });
  await listen(server);
  try {
    const page = await request(server, 'GET', '/reports/web-rep');
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /proj&lt;img&gt;/);
    assert.equal(page.body.includes('<img>'), false);

    const html = await request(server, 'GET', '/reports/web-rep/report.html');
    assert.equal(html.statusCode, 200);
    assert.equal(html.body, '<html>file</html>');

    const json = await request(server, 'GET', '/reports/web-rep/report.json');
    assert.equal(json.statusCode, 200);
    assert.equal(JSON.parse(json.body).reviewId, 'web-rep');

    const missing = await request(server, 'GET', '/reports/missing/report.html');
    assert.equal(missing.statusCode, 404);
  } finally {
    await close(server);
  }
});

test('POST /api/reviews accepts form fields with checklist.includePaths CSV', async () => {
  const { root, projectDir, requirementFile } = await setupAllowedProject();
  const reportsDir = await makeTempDir('crs-web-reports-');
  /** @type {object|null} */
  let enqueued = null;
  const jobService = makeFakeJobService({ reviewId: 'form-id' });
  const originalEnqueue = jobService.enqueue.bind(jobService);
  jobService.enqueue = (req, opts) => {
    enqueued = req;
    return originalEnqueue(req, opts);
  };

  const checklistPath = path.join(root, 'checklists', 'review-checklist.md');
  await fs.mkdir(path.dirname(checklistPath), { recursive: true });
  await fs.writeFile(checklistPath, '# checklist\n', 'utf8');

  const server = createWebAdapter({
    jobService,
    config: makeConfig(root, reportsDir),
    validateRequest: validateCreateReviewRequest
  });
  await listen(server);
  try {
    const body = new URLSearchParams({
      projectDir,
      requirementFile,
      sourceMode: 'FULL_DIRECTORY',
      'checklist.enabled': 'true',
      'checklist.path': checklistPath,
      'checklist.includePaths': 'src,lib'
    }).toString();
    const res = await request(server, 'POST', '/api/reviews', {
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    assert.equal(res.statusCode, 202);
    assert.ok(enqueued);
    assert.equal(enqueued.checklist.enabled, true);
    assert.deepEqual(enqueued.checklist.includePaths, ['src', 'lib']);
  } finally {
    await close(server);
  }
});
