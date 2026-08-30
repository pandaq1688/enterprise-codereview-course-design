import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-workspace.js';
import { createFileReportRepository } from '../src/file-report-repository.js';

test('atomically writes json and html and lists newest first', async () => {
  const dir = await makeTempDir();
  let n = 0;
  const repo = createFileReportRepository({
    reportsDir: dir,
    idFactory: () => `id-${++n}`
  });
  const id = repo.createReviewId();
  await repo.save({
    schemaVersion: 1,
    reviewId: id,
    status: 'SUCCEEDED',
    createdAt: '2026-08-29T01:00:00.000Z',
    completedAt: '2026-08-29T01:00:01.000Z',
    durationMs: 1000,
    request: { projectName: 'p', sourceMode: 'GIT_CHANGES' },
    source: { files: [], inputHash: 'x', fileCount: 0, totalCharacters: 0 },
    rules: [],
    ai: {},
    result: { summary: 'ok', overallRisk: 'LOW', activeFindingCount: 0, exemptedFindingCount: 0, mergedFindingCount: 0, findings: [], recommendedActions: [] },
    errors: []
  });
  const json = JSON.parse(await fs.readFile(path.join(dir, id, 'report.json'), 'utf8'));
  assert.equal(json.reviewId, id);
  assert.equal(json.schemaVersion, 1);
  await fs.access(path.join(dir, id, 'report.html'));
  const list = await repo.listSummaries();
  assert.equal(list[0].reviewId, id);
});

test('save replaces an existing report directory for the same reviewId', async () => {
  const dir = await makeTempDir();
  const reviewId = '012237d6-4a2b-4c61-9e31-1f2f3262a302';
  const repo = createFileReportRepository({
    reportsDir: dir,
    idFactory: () => reviewId
  });
  const base = {
    schemaVersion: 1,
    reviewId,
    createdAt: '2026-08-30T01:05:02.668Z',
    completedAt: '2026-08-30T01:05:02.764Z',
    durationMs: 96,
    request: { projectName: 'sample-project', sourceMode: 'FULL_DIRECTORY' },
    source: { files: [], inputHash: 'x', fileCount: 0, totalCharacters: 0 },
    rules: [],
    ai: {},
    result: {
      summary: '',
      overallRisk: 'LOW',
      activeFindingCount: 0,
      exemptedFindingCount: 0,
      mergedFindingCount: 0,
      findings: [],
      recommendedActions: []
    },
    errors: []
  };
  await repo.save({ ...base, status: 'FAILED', errors: [{ code: 'CURSOR_EXIT_NON_ZERO', message: 'fail', details: [] }] });
  await repo.save({
    ...base,
    status: 'SUCCEEDED',
    durationMs: 60000,
    completedAt: '2026-08-30T01:09:12.714Z',
    result: {
      ...base.result,
      summary: 'ok',
      overallRisk: 'HIGH',
      activeFindingCount: 3
    },
    errors: []
  });
  const json = JSON.parse(await fs.readFile(path.join(dir, reviewId, 'report.json'), 'utf8'));
  assert.equal(json.status, 'SUCCEEDED');
  assert.equal(json.result.activeFindingCount, 3);
  assert.equal(json.errors.length, 0);
  await fs.access(path.join(dir, reviewId, 'report.html'));
});
