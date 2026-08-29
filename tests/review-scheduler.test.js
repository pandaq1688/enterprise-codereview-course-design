import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-workspace.js';
import { createFakeClock } from './helpers/fake-clock.js';
import { createFakeReviewProvider } from './helpers/fake-review-provider.js';
import { createReviewScheduler } from '../src/review-scheduler.js';
import { createReviewJobService } from '../src/review-job-service.js';
import { createFileReportRepository } from '../src/file-report-repository.js';
import { createLogger } from '../src/shared/logger.js';
import { collectFullDirectorySource } from '../src/full-directory-source-collector.js';
import { collectGitChangedSource } from '../src/git-changed-source-collector.js';
import { loadRequirement } from '../src/requirement-loader.js';
import { resolveRules } from '../src/rule-resolver.js';
import { buildPrompt } from '../src/prompt-builder.js';
import { parseReviewOutput } from '../src/review-result-parser.js';
import { applyPostReviewPolicy } from '../src/post-review-policy.js';
import { toDisplayPath } from '../src/request-validator.js';
import { REPORT_SCHEMA_VERSION } from '../src/shared/versions.js';

const INTERVAL_MS = 10 * 60 * 1000;

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
  const projectDir = await makeTempDir('crs-sched-proj-');
  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectDir, 'src', 'a.cpp'), 'int* p = 0;\np->x;\n', 'utf8');
  const requirementFile = path.join(projectDir, 'req.md');
  await fs.writeFile(requirementFile, '# 需求\n返回 0\n', 'utf8');
  return { projectDir, requirementFile };
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

function makeProfile({ projectDir, requirementFile, intervalMinutes = 10, enabled = true }) {
  return {
    profileId: 'p1',
    name: 'fixture',
    enabled,
    projectDir,
    requirementFile,
    sourceMode: 'FULL_DIRECTORY',
    checklist: {
      enabled: false,
      path: null,
      includePaths: ['.'],
      excludePaths: []
    },
    intervalMinutes
  };
}

function createCountingProvider(rawOutput, delayMs = 0) {
  let callCount = 0;
  const inner = createFakeReviewProvider({ rawOutput, delayMs });
  return {
    get callCount() {
      return callCount;
    },
    async review(args) {
      callCount += 1;
      return inner.review(args);
    }
  };
}

function createService({ reportsDir, provider, clock, idFactory }) {
  const repository = createFileReportRepository({ reportsDir, idFactory });
  const logger = createLogger({
    stream: { write() {} },
    clock
  });
  return createReviewJobService({
    config: defaultConfig(reportsDir),
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
    idFactory: idFactory ?? (() => repository.createReviewId())
  });
}

function wrapEnqueueCounter(jobService) {
  let count = 0;
  const original = jobService.enqueue.bind(jobService);
  jobService.enqueue = (req, opts) => {
    count += 1;
    return original(req, opts);
  };
  return {
    get count() {
      return count;
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

test('intervalMinutes < 5 throws at load', () => {
  assert.throws(
    () =>
      createReviewScheduler({
        profiles: [
          {
            profileId: 'bad',
            name: 'bad',
            enabled: true,
            projectDir: '/tmp',
            requirementFile: '/tmp/r.md',
            sourceMode: 'FULL_DIRECTORY',
            checklist: { enabled: false },
            intervalMinutes: 4
          }
        ],
        jobService: {},
        clock: createFakeClock(),
        stateFile: path.join(process.cwd(), 'data', 'unused-state.json'),
        computeInputHash: async () => 'x'
      }),
    /5/
  );
});

test('FakeClock scheduling: due, single-flight, SKIPPED_UNCHANGED, state reload, SCHEDULED report', async () => {
  const reportsDir = await makeTempDir('crs-sched-reports-');
  const stateDir = await makeTempDir('crs-sched-state-');
  const stateFile = path.join(stateDir, 'scheduler-state.json');
  const { projectDir, requirementFile } = await createProjectFixture();

  const clock = createFakeClock(0);
  const logLines = [];
  const logger = createLogger({
    stream: {
      write(chunk) {
        logLines.push(String(chunk));
      }
    },
    clock
  });

  const provider = createCountingProvider(HIGH_FINDING_JSON, 200);
  let n = 0;
  const jobService = createService({
    reportsDir,
    provider,
    clock,
    idFactory: () => `sched-${++n}`
  });
  const enqueues = wrapEnqueueCounter(jobService);

  const profile = makeProfile({ projectDir, requirementFile, intervalMinutes: 10 });

  const scheduler = createReviewScheduler({
    profiles: [profile],
    jobService,
    clock,
    stateFile,
    computeInputHash: (req) => jobService.computeInputHashFor(req),
    logger
  });

  // 1) advance 9 minutes → no enqueue
  clock.advance(9 * 60 * 1000);
  await scheduler.tick();
  assert.equal(enqueues.count, 0, 'should not enqueue before interval');

  // 2) advance to 10 minutes → enqueue once
  clock.advance(1 * 60 * 1000);
  await scheduler.tick();
  assert.equal(enqueues.count, 1, 'should enqueue once when due');

  const firstJobId = 'sched-1';
  const midJob = await jobService.getJob(firstJobId);
  assert.ok(midJob);
  assert.notEqual(midJob.status, 'SUCCEEDED');

  // 3) job not finished → no second enqueue (single-flight)
  await scheduler.tick();
  assert.equal(enqueues.count, 1, 'single-flight: no second enqueue while running');

  const done = await waitUntilDone(jobService, firstJobId);
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(provider.callCount, 1);

  const report = await jobService.getReport(firstJobId);
  // 6) SCHEDULED trigger + schemaVersion 1
  assert.equal(report.request.triggerType, 'SCHEDULED');
  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.equal(report.schemaVersion, 1);

  // Drain completion bookkeeping on next tick
  await scheduler.tick();

  const stateAfter = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  const lastRunAt = stateAfter.profiles.p1.lastRunAt;
  assert.ok(lastRunAt, 'lastRunAt written to state');
  const lastRunMs = Date.parse(lastRunAt);
  assert.equal(lastRunMs + INTERVAL_MS, lastRunMs + profile.intervalMinutes * 60 * 1000);

  // 4) next interval, same hash → SKIPPED, provider calls unchanged
  clock.advance(INTERVAL_MS);
  await scheduler.tick();
  assert.equal(enqueues.count, 1, 'unchanged inputHash must not enqueue');
  assert.equal(provider.callCount, 1, 'provider must not be called again');
  assert.ok(
    logLines.some((line) => {
      try {
        return JSON.parse(line).event === 'SKIPPED_UNCHANGED';
      } catch {
        return false;
      }
    }),
    'expected SKIPPED_UNCHANGED log event'
  );

  const stateSkipped = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.ok(stateSkipped.profiles.p1.lastCheckedAt);

  // 5) new Scheduler reads same stateFile; next due = lastRunAt + interval
  const clock2 = createFakeClock(lastRunMs);
  const enqueues2 = { count: 0 };
  const jobService2 = createService({
    reportsDir,
    provider: createCountingProvider(HIGH_FINDING_JSON),
    clock: clock2,
    idFactory: () => `reload-${Date.now()}`
  });
  const origEnqueue = jobService2.enqueue.bind(jobService2);
  jobService2.enqueue = (req, opts) => {
    enqueues2.count += 1;
    return origEnqueue(req, opts);
  };

  const scheduler2 = createReviewScheduler({
    profiles: [profile],
    jobService: jobService2,
    clock: clock2,
    stateFile,
    computeInputHash: (req) => jobService2.computeInputHashFor(req),
    logger: createLogger({ stream: { write() {} }, clock: clock2 })
  });

  assert.equal(
    scheduler2.getNextRunAtMs(profile.profileId),
    lastRunMs + INTERVAL_MS,
    'next run is lastRunAt + interval'
  );

  clock2.advance(INTERVAL_MS - 1);
  await scheduler2.tick();
  assert.equal(enqueues2.count, 0, 'reloaded scheduler must respect lastRunAt');

  clock2.advance(1);
  await scheduler2.tick();
  // due again but same hash → skip, still no enqueue
  assert.equal(enqueues2.count, 0, 'reloaded scheduler skips unchanged when due');
});

test('disabled profile is not scheduled', async () => {
  const reportsDir = await makeTempDir('crs-sched-dis-');
  const stateFile = path.join(await makeTempDir('crs-sched-dis-state-'), 'scheduler-state.json');
  const { projectDir, requirementFile } = await createProjectFixture();
  const clock = createFakeClock(0);
  const provider = createCountingProvider(HIGH_FINDING_JSON);
  const jobService = createService({ reportsDir, provider, clock, idFactory: () => 'd1' });
  const enqueues = wrapEnqueueCounter(jobService);

  const scheduler = createReviewScheduler({
    profiles: [makeProfile({ projectDir, requirementFile, enabled: false })],
    jobService,
    clock,
    stateFile,
    computeInputHash: (req) => jobService.computeInputHashFor(req),
    logger: createLogger({ stream: { write() {} }, clock })
  });

  clock.advance(INTERVAL_MS);
  await scheduler.tick();
  assert.equal(enqueues.count, 0);
});

test('tick failure is logged and does not throw', async () => {
  const stateFile = path.join(await makeTempDir('crs-sched-err-'), 'scheduler-state.json');
  const { projectDir, requirementFile } = await createProjectFixture();
  const clock = createFakeClock(0);
  const logLines = [];
  const logger = createLogger({
    stream: {
      write(chunk) {
        logLines.push(String(chunk));
      }
    },
    clock
  });

  const jobService = {
    enqueue() {
      throw new Error('boom');
    },
    getJob: async () => null,
    getReport: async () => null,
    computeInputHashFor: async () => 'hash-a'
  };

  const scheduler = createReviewScheduler({
    profiles: [makeProfile({ projectDir, requirementFile })],
    jobService,
    clock,
    stateFile,
    computeInputHash: async () => 'hash-a',
    logger
  });

  clock.advance(INTERVAL_MS);
  await scheduler.tick();
  assert.ok(
    logLines.some((line) => {
      try {
        const e = JSON.parse(line);
        return e.level === 'error' || e.event === 'SCHEDULER_TICK_FAILED' || e.event === 'SCHEDULER_PROFILE_FAILED';
      } catch {
        return false;
      }
    })
  );
});
