#!/usr/bin/env node
/**
 * Re-run one review with a fixed reviewId (no HTTP server).
 * Usage: node scripts/rerun-review-id.mjs <reviewId>
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/create-app.js';
import { validateCreateReviewRequest } from '../src/request-validator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const TARGET_ID = process.argv[2];

if (!TARGET_ID) {
  console.error('Usage: node scripts/rerun-review-id.mjs <reviewId>');
  process.exit(2);
}

const app = await createApp({
  configPath: path.join(root, 'app.config.json'),
  idFactory: () => TARGET_ID
});

const body = {
  projectDir: path.join(root, 'examples', 'sample-project'),
  requirementFile: path.join(root, 'examples', 'sample-project', 'docs', 'requirement.md'),
  sourceMode: 'FULL_DIRECTORY'
};

const normalized = await validateCreateReviewRequest(body, app.config);
const { reviewId } = app.jobService.enqueue(normalized, { triggerType: 'MANUAL' });
console.log(`queued reviewId=${reviewId}`);

const deadline = Date.now() + 12 * 60 * 1000;
for (;;) {
  const job = await app.jobService.getJob(reviewId);
  console.log(`status=${job.status}`);
  if (job.status === 'SUCCEEDED' || job.status === 'FAILED') {
    const report = await app.jobService.getReport(reviewId);
    console.log(
      JSON.stringify(
        {
          reviewId: report.reviewId,
          status: report.status,
          overallRisk: report.result?.overallRisk,
          rawOverallRisk: report.ai?.rawOverallRisk,
          activeFindingCount: report.result?.activeFindingCount,
          errors: report.errors
        },
        null,
        2
      )
    );
    process.exit(report.status === 'SUCCEEDED' ? 0 : 1);
  }
  if (Date.now() > deadline) {
    console.error('timeout waiting for review');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
