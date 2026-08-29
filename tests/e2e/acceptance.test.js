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
