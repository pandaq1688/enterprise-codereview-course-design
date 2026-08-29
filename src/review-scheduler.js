import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { toDisplayPath } from './request-validator.js';

const MIN_INTERVAL_MINUTES = 5;

/**
 * @param {object} profile
 */
function assertProfileInterval(profile) {
  const minutes = Number(profile?.intervalMinutes);
  if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES) {
    throw new Error(`intervalMinutes 必须 >= ${MIN_INTERVAL_MINUTES}（profileId=${profile?.profileId ?? '?'}）`);
  }
}

/**
 * @param {object} profile
 */
function profileToNormalizedRequest(profile) {
  const checklist = profile.checklist ?? {
    enabled: false,
    path: null,
    includePaths: ['.'],
    excludePaths: []
  };
  return {
    projectDir: profile.projectDir,
    requirementFile: profile.requirementFile,
    sourceMode: profile.sourceMode,
    checklist: {
      enabled: Boolean(checklist.enabled),
      path: checklist.path ?? null,
      includePaths: Array.isArray(checklist.includePaths) ? checklist.includePaths : ['.'],
      excludePaths: Array.isArray(checklist.excludePaths) ? checklist.excludePaths : []
    },
    projectName: path.basename(profile.projectDir),
    projectDirDisplay: toDisplayPath(profile.projectDir),
    requirementFileDisplay: toDisplayPath(profile.requirementFile),
    checklistFileDisplay: checklist.path ? toDisplayPath(checklist.path) : null
  };
}

/**
 * @param {unknown} parsed
 */
function normalizeState(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { profiles: {} };
  }
  const profiles = parsed.profiles;
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    return { profiles: {} };
  }
  return { profiles: { ...profiles } };
}

/**
 * @param {string} stateFile
 */
function readStateSync(stateFile) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
  } catch {
    return { profiles: {} };
  }
}

/**
 * @param {string} stateFile
 */
async function readState(stateFile) {
  try {
    const text = await fsp.readFile(stateFile, 'utf8');
    return normalizeState(JSON.parse(text));
  } catch {
    return { profiles: {} };
  }
}

/**
 * Atomic write: tmp + rename (replace existing on Windows).
 * @param {string} stateFile
 * @param {object} state
 */
async function writeStateAtomic(stateFile, state) {
  const dir = path.dirname(stateFile);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  await fsp.writeFile(tmp, payload, 'utf8');
  try {
    await fsp.rename(tmp, stateFile);
  } catch (err) {
    if (err && (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EACCES')) {
      await fsp.rm(stateFile, { force: true }).catch(() => {});
      await fsp.rename(tmp, stateFile);
    } else {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}

/**
 * @param {{
 *   profiles: object[],
 *   jobService: {
 *     enqueue: Function,
 *     getJob: Function,
 *     getReport: Function
 *   },
 *   clock: { now(): Date },
 *   stateFile: string,
 *   computeInputHash: (normalizedRequest: object) => Promise<string>,
 *   logger?: { log: Function }
 * }} deps
 */
export function createReviewScheduler(deps) {
  const { profiles, jobService, clock, stateFile, computeInputHash, logger } = deps;

  if (!Array.isArray(profiles)) {
    throw new Error('profiles 必须是数组');
  }
  for (const profile of profiles) {
    assertProfileInterval(profile);
  }

  /** @type {Map<string, string>} profileId → in-flight reviewId */
  const inFlight = new Map();
  /** @type {Map<string, number>} */
  const nextRunCache = new Map();
  /** Prevent overlapping tick() reentrancy (e.g. slow hash vs 30s interval). */
  let tickRunning = false;

  function log(entry) {
    if (logger && typeof logger.log === 'function') {
      logger.log(entry);
    }
  }

  function getProfileState(state, profileId) {
    if (!state.profiles[profileId]) {
      state.profiles[profileId] = {
        lastRunAt: null,
        lastCheckedAt: null,
        lastSuccessInputHash: null
      };
    }
    return state.profiles[profileId];
  }

  function lastRunAtMs(profileState) {
    if (!profileState?.lastRunAt) return 0;
    const ms = Date.parse(profileState.lastRunAt);
    return Number.isFinite(ms) ? ms : 0;
  }

  function refreshNextRunCache(state) {
    for (const profile of profiles) {
      const ps = state.profiles[profile.profileId];
      const base = lastRunAtMs(ps);
      nextRunCache.set(profile.profileId, base + Number(profile.intervalMinutes) * 60 * 1000);
    }
  }

  refreshNextRunCache(readStateSync(stateFile));

  /**
   * @param {string} profileId
   * @returns {number}
   */
  function getNextRunAtMs(profileId) {
    if (nextRunCache.has(profileId)) {
      return nextRunCache.get(profileId);
    }
    const profile = profiles.find((p) => p.profileId === profileId);
    return Number(profile?.intervalMinutes ?? 0) * 60 * 1000;
  }

  async function settleInFlight(profileId, state) {
    const reviewId = inFlight.get(profileId);
    if (!reviewId) return;
    const job = await jobService.getJob(reviewId);
    if (!job) {
      inFlight.delete(profileId);
      return;
    }
    if (job.status !== 'SUCCEEDED' && job.status !== 'FAILED') {
      return;
    }
    inFlight.delete(profileId);
    if (job.status === 'SUCCEEDED') {
      try {
        const report = await jobService.getReport(reviewId);
        const hash = report?.source?.inputHash ?? null;
        const ps = getProfileState(state, profileId);
        if (hash) {
          ps.lastSuccessInputHash = hash;
        }
      } catch (err) {
        log({
          level: 'error',
          event: 'SCHEDULER_PROFILE_FAILED',
          message: err instanceof Error ? err.message : String(err),
          projectName: profileId
        });
      }
    }
  }

  /**
   * @param {object} profile
   * @param {object} state
   */
  async function tickProfile(profile, state) {
    if (!profile.enabled) return;

    await settleInFlight(profile.profileId, state);

    if (inFlight.has(profile.profileId)) {
      return;
    }

    const ps = getProfileState(state, profile.profileId);
    const now = clock.now();
    const nowMs = now.getTime();
    const intervalMs = Number(profile.intervalMinutes) * 60 * 1000;
    const dueAt = lastRunAtMs(ps) + intervalMs;
    nextRunCache.set(profile.profileId, dueAt);

    if (nowMs < dueAt) {
      return;
    }

    const normalized = profileToNormalizedRequest(profile);
    let inputHash;
    try {
      inputHash = await computeInputHash(normalized);
    } catch (err) {
      log({
        level: 'error',
        event: 'SCHEDULER_PROFILE_FAILED',
        message: err instanceof Error ? err.message : String(err),
        projectName: path.basename(profile.projectDir)
      });
      ps.lastCheckedAt = now.toISOString();
      return;
    }

    ps.lastCheckedAt = now.toISOString();

    if (ps.lastSuccessInputHash && inputHash === ps.lastSuccessInputHash) {
      log({
        level: 'info',
        event: 'SKIPPED_UNCHANGED',
        message: `profile ${profile.profileId} unchanged`,
        projectName: path.basename(profile.projectDir)
      });
      return;
    }

    try {
      const { reviewId } = jobService.enqueue(normalized, { triggerType: 'SCHEDULED' });
      inFlight.set(profile.profileId, reviewId);
      ps.lastRunAt = now.toISOString();
      nextRunCache.set(profile.profileId, nowMs + intervalMs);
    } catch (err) {
      log({
        level: 'error',
        event: 'SCHEDULER_PROFILE_FAILED',
        message: err instanceof Error ? err.message : String(err),
        projectName: path.basename(profile.projectDir)
      });
    }
  }

  async function tick() {
    if (tickRunning) {
      return;
    }
    tickRunning = true;
    try {
      const state = await readState(stateFile);
      refreshNextRunCache(state);

      for (const profile of profiles) {
        try {
          await tickProfile(profile, state);
        } catch (err) {
          log({
            level: 'error',
            event: 'SCHEDULER_PROFILE_FAILED',
            message: err instanceof Error ? err.message : String(err),
            projectName: profile?.name ?? profile?.profileId ?? null
          });
        }
      }

      await writeStateAtomic(stateFile, state);
      refreshNextRunCache(state);
    } catch (err) {
      log({
        level: 'error',
        event: 'SCHEDULER_TICK_FAILED',
        message: err instanceof Error ? err.message : String(err)
      });
    } finally {
      tickRunning = false;
    }
  }

  return {
    tick,
    getNextRunAtMs
  };
}
