import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from './shared/app-error.js';
import { ErrorCodes } from './shared/error-codes.js';
import { sha256Text } from './shared/hash.js';
import { PROMPT_SCHEMA_VERSION, REPORT_SCHEMA_VERSION } from './shared/versions.js';

/**
 * @param {{
 *   sourceMode: string,
 *   requirementText: string,
 *   files: Array<{ path: string }>,
 *   contents: Record<string, string>,
 *   rules: Array<{ ruleType: string, content: string }>
 * }} input
 * @returns {string}
 */
export function computeStableInputHash({ sourceMode, requirementText, files, contents, rules }) {
  const payload = {
    sourceMode,
    requirementText,
    files: (files ?? []).map((f) => ({
      path: f.path,
      content: contents?.[f.path] ?? ''
    })),
    rules: (rules ?? []).map((r) => ({
      ruleType: r.ruleType,
      content: r.content
    })),
    promptSchemaVersion: PROMPT_SCHEMA_VERSION
  };
  return sha256Text(JSON.stringify(payload));
}

/**
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function truncate(text, maxChars) {
  if (text == null) return '';
  const s = String(text);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

/**
 * @param {unknown} err
 * @returns {{ code: string, message: string, details: unknown[] }}
 */
function toErrorEntry(err) {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, details: err.details ?? [] };
  }
  return {
    code: ErrorCodes.INVALID_REQUEST,
    message: err instanceof Error ? err.message : String(err),
    details: []
  };
}

/**
 * @param {object} deps
 */
export function createReviewJobService(deps) {
  const {
    config,
    gitChangedCollector,
    fullDirectoryCollector,
    requirementLoader,
    ruleResolver,
    promptBuilder,
    provider,
    parser,
    policy,
    repository,
    clock,
    logger,
    idFactory
  } = deps;

  /** @type {Map<string, object>} */
  const jobs = new Map();
  /** @type {object[]} */
  const manualQueue = [];
  /** @type {object[]} */
  const scheduledQueue = [];

  let accepting = true;
  let workerRunning = false;
  /** @type {AbortController | null} */
  let currentAbort = null;
  /** @type {string | null} */
  let currentReviewId = null;

  function setStatus(job, status) {
    job.status = status;
    job.updatedAt = clock.now().toISOString();
  }

  /**
   * @param {object} normalizedRequest
   */
  async function collectInputs(normalizedRequest) {
    const limits = config.review;
    const requirement = await requirementLoader({
      filePath: normalizedRequest.requirementFile,
      maxChars: limits.maxRequirementChars
    });

    const collectOpts = {
      projectDir: normalizedRequest.projectDir,
      maxFiles: limits.maxFiles,
      maxFileChars: limits.maxFileChars,
      maxInputChars: limits.maxInputChars
    };

    const source =
      normalizedRequest.sourceMode === 'GIT_CHANGES'
        ? await gitChangedCollector(collectOpts)
        : await fullDirectoryCollector(collectOpts);

    const { rules } = await ruleResolver({
      projectDir: normalizedRequest.projectDir,
      files: source.files,
      checklist: normalizedRequest.checklist
    });

    const inputHash = computeStableInputHash({
      sourceMode: normalizedRequest.sourceMode,
      requirementText: requirement.text,
      files: source.files,
      contents: source.contents,
      rules
    });

    return { requirement, source, rules, inputHash };
  }

  /**
   * @param {object} normalizedRequest
   * @returns {Promise<string>}
   */
  async function computeInputHashFor(normalizedRequest) {
    const { inputHash } = await collectInputs(normalizedRequest);
    return inputHash;
  }

  /**
   * @param {object} job
   * @param {object} collected
   * @param {object} aiPart
   * @param {object} resultPart
   * @param {object[]} errors
   * @param {string} status
   */
  function buildReport(job, collected, aiPart, resultPart, errors, status) {
    const includeAbs = config.reports?.includeAbsolutePaths === true;
    const req = job.request;
    const request = {
      projectName: req.projectName,
      projectDirDisplay: req.projectDirDisplay,
      sourceMode: req.sourceMode,
      requirementFileDisplay: req.requirementFileDisplay,
      checklistEnabled: Boolean(req.checklist?.enabled),
      checklistFileDisplay: req.checklistFileDisplay,
      checklistIncludePaths: req.checklist?.includePaths ?? [],
      checklistExcludePaths: req.checklist?.excludePaths ?? [],
      triggerType: job.triggerType
    };
    if (includeAbs) {
      request.projectDir = req.projectDir;
      request.requirementFile = req.requirementFile;
      if (req.checklist?.path) {
        request.checklistPath = req.checklist.path;
      }
    }

    const sourceFiles = (collected?.source?.files ?? []).map((f) => ({
      path: f.path,
      language: f.language,
      status: f.status,
      contentHash: f.contentHash,
      changedLines: f.changedLines
    }));

    const rules = (collected?.rules ?? []).map((r) => ({
      ruleId: r.ruleId,
      ruleType: r.ruleType,
      builtIn: r.builtIn,
      contentHash: r.contentHash,
      matchPaths: r.matchPaths,
      matchedFiles: r.matchedFiles
    }));

    const completedAt = clock.now().toISOString();
    const createdAt = job.createdAt;
    const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(createdAt));

    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      reviewId: job.reviewId,
      status,
      createdAt,
      completedAt,
      durationMs,
      request,
      source: {
        inputHash: collected?.inputHash ?? '',
        fileCount: sourceFiles.length,
        totalCharacters: collected?.source?.totalCharacters ?? 0,
        files: sourceFiles
      },
      rules,
      ai: aiPart,
      result: resultPart,
      errors
    };
  }

  function emptyResult(summary = '') {
    return {
      summary,
      overallRisk: 'LOW',
      activeFindingCount: 0,
      exemptedFindingCount: 0,
      mergedFindingCount: 0,
      findings: [],
      recommendedActions: []
    };
  }

  function emptyAi(overrides = {}) {
    return {
      provider: config.ai?.provider ?? 'unknown',
      durationMs: 0,
      exitCode: null,
      model: null,
      rawOverallRisk: null,
      rawOutput: '',
      stderrSummary: '',
      ...overrides
    };
  }

  /**
   * @param {object} job
   * @param {object | null} collected
   * @param {object} aiPart
   * @param {object} resultPart
   * @param {object[]} errors
   * @param {string} status
   */
  async function persistReport(job, collected, aiPart, resultPart, errors, status) {
    setStatus(job, 'REPORTING');
    const report = buildReport(job, collected, aiPart, resultPart, errors, status);
    try {
      await repository.save(report);
      setStatus(job, status);
      job.completedAt = report.completedAt;
      job.durationMs = report.durationMs;
      if (status === 'FAILED' && Array.isArray(errors) && errors.length > 0) {
        job.error = {
          code: errors[0].code,
          message: errors[0].message,
          details: errors[0].details ?? []
        };
      }
      return report;
    } catch (err) {
      setStatus(job, 'FAILED');
      const entry = toErrorEntry(err);
      logger.log({
        level: 'error',
        event: 'REPORT_WRITE_FAILED',
        reviewId: job.reviewId,
        stage: 'REPORTING',
        errorCode: entry.code,
        message: `report write failed for ${job.request.projectName}`
      });
      job.error = entry;
      throw err;
    }
  }

  /**
   * @param {object} job
   */
  async function processJob(job) {
    const started = clock.now();
    let collected = null;
    let promptFile = null;
    let outputFile = null;
    const maxOutputChars = config.cursor?.maxOutputChars ?? 2_000_000;
    currentReviewId = job.reviewId;
    currentAbort = new AbortController();

    try {
      setStatus(job, 'COLLECTING');
      logger.log({
        level: 'info',
        event: 'JOB_STAGE',
        reviewId: job.reviewId,
        stage: 'COLLECTING',
        message: job.request.projectName
      });

      collected = await collectInputs(job.request);
      const prompt = promptBuilder({
        requirementText: collected.requirement.text,
        sourceMode: job.request.sourceMode,
        files: collected.source.files,
        contents: collected.source.contents,
        rules: collected.rules
      });

      promptFile = path.join(os.tmpdir(), `crs-${job.reviewId}-prompt.txt`);
      outputFile = path.join(os.tmpdir(), `crs-${job.reviewId}-out.json`);
      await fs.writeFile(promptFile, prompt.text, 'utf8');

      setStatus(job, 'REVIEWING');
      logger.log({
        level: 'info',
        event: 'JOB_STAGE',
        reviewId: job.reviewId,
        stage: 'REVIEWING',
        message: job.request.projectName
      });

      let providerResult;
      try {
        providerResult = await provider.review({
          projectDir: job.request.projectDir,
          promptFile,
          outputFile,
          timeoutMs: config.cursor?.timeoutMs,
          signal: currentAbort.signal
        });
      } catch (err) {
        const entry = toErrorEntry(err);
        const rawOutput =
          err && typeof err === 'object' && 'rawOutput' in err
            ? truncate(/** @type {{ rawOutput?: string }} */ (err).rawOutput, maxOutputChars)
            : '';
        await persistReport(
          job,
          collected,
          emptyAi({
            durationMs: Math.max(0, clock.now().getTime() - started.getTime()),
            rawOutput,
            stderrSummary: truncate(err instanceof Error ? err.message : String(err), 2000)
          }),
          emptyResult(),
          [entry],
          'FAILED'
        );
        return;
      }

      const rawOutput = truncate(providerResult.rawOutput ?? '', maxOutputChars);

      setStatus(job, 'FILTERING');
      let parsed;
      try {
        parsed = parser(rawOutput);
      } catch (err) {
        const entry = toErrorEntry(err);
        await persistReport(
          job,
          collected,
          emptyAi({
            durationMs: providerResult.durationMs ?? 0,
            exitCode: providerResult.exitCode ?? null,
            rawOutput,
            stderrSummary: truncate(providerResult.stderr ?? '', 2000)
          }),
          emptyResult(),
          [entry],
          'FAILED'
        );
        return;
      }

      const policyResult = policy({
        rawFindings: parsed.findings,
        selectedFiles: collected.source.files,
        sourceMode: job.request.sourceMode
      });

      const ts = clock.now().toISOString();
      for (const finding of policyResult.findings) {
        for (const decision of finding.decisions ?? []) {
          decision.timestamp = ts;
        }
      }

      const resultPart = {
        summary: parsed.summary,
        overallRisk: policyResult.overallRisk,
        activeFindingCount: policyResult.activeFindingCount,
        exemptedFindingCount: policyResult.exemptedFindingCount,
        mergedFindingCount: policyResult.mergedFindingCount,
        findings: policyResult.findings,
        recommendedActions: parsed.recommended_actions ?? []
      };

      const aiPart = emptyAi({
        durationMs: providerResult.durationMs ?? 0,
        exitCode: providerResult.exitCode ?? null,
        model: providerResult.providerMetadata?.model ?? null,
        rawOverallRisk: parsed.overall_risk,
        rawOutput,
        stderrSummary: truncate(providerResult.stderr ?? '', 2000)
      });

      await persistReport(job, collected, aiPart, resultPart, [], 'SUCCEEDED');
    } catch (err) {
      if (job.status === 'FAILED' && job.error?.code === ErrorCodes.REPORT_WRITE_FAILED) {
        return;
      }
      if (job.status === 'FAILED') {
        return;
      }
      const entry = toErrorEntry(err);
      try {
        await persistReport(
          job,
          collected,
          emptyAi({
            durationMs: Math.max(0, clock.now().getTime() - started.getTime()),
            stderrSummary: truncate(entry.message, 2000)
          }),
          emptyResult(),
          [entry],
          'FAILED'
        );
      } catch {
        // REPORT_WRITE_FAILED already handled inside persistReport
      }
    } finally {
      currentReviewId = null;
      currentAbort = null;
      for (const p of [promptFile, outputFile]) {
        if (!p) continue;
        try {
          await fs.unlink(p);
        } catch {
          // best-effort; Cursor provider may already have removed them
        }
      }
      logger.log({
        level: 'info',
        event: 'JOB_DONE',
        reviewId: job.reviewId,
        stage: job.status,
        durationMs: Math.max(0, clock.now().getTime() - started.getTime()),
        message: job.request.projectName
      });
    }
  }

  async function runWorker() {
    if (workerRunning) return;
    workerRunning = true;
    try {
      while (true) {
        const next = manualQueue.shift() ?? scheduledQueue.shift();
        if (!next) break;
        await processJob(next);
      }
    } finally {
      workerRunning = false;
      if (manualQueue.length > 0 || scheduledQueue.length > 0) {
        queueMicrotask(() => {
          void runWorker();
        });
      }
    }
  }

  /**
   * @param {object} normalizedRequest
   * @param {{ triggerType: 'MANUAL' | 'SCHEDULED' }} opts
   */
  function enqueue(normalizedRequest, { triggerType }) {
    if (!accepting) {
      throw new AppError(ErrorCodes.INVALID_REQUEST, '服务已停止接受新任务', []);
    }
    if (triggerType !== 'MANUAL' && triggerType !== 'SCHEDULED') {
      throw new AppError(ErrorCodes.INVALID_REQUEST, 'triggerType 非法', []);
    }

    const reviewId = idFactory();
    const createdAt = clock.now().toISOString();
    const job = {
      reviewId,
      status: 'QUEUED',
      createdAt,
      updatedAt: createdAt,
      triggerType,
      request: normalizedRequest
    };
    jobs.set(reviewId, job);

    if (triggerType === 'MANUAL') {
      manualQueue.push(job);
    } else {
      scheduledQueue.push(job);
    }

    queueMicrotask(() => {
      void runWorker();
    });

    return { reviewId, status: 'QUEUED' };
  }

  /**
   * @param {string} reviewId
   */
  async function getJob(reviewId) {
    const mem = jobs.get(reviewId);
    if (mem) {
      return {
        reviewId: mem.reviewId,
        status: mem.status,
        createdAt: mem.createdAt,
        completedAt: mem.completedAt ?? null,
        durationMs: mem.durationMs ?? null,
        triggerType: mem.triggerType,
        error: mem.error ?? null
      };
    }
    try {
      const report = await repository.read(reviewId);
      return {
        reviewId: report.reviewId,
        status: report.status,
        createdAt: report.createdAt,
        completedAt: report.completedAt ?? null,
        durationMs: report.durationMs ?? null,
        triggerType: report.request?.triggerType ?? null,
        error: report.errors?.[0] ?? null
      };
    } catch {
      return null;
    }
  }

  async function listReports() {
    return repository.listSummaries();
  }

  /**
   * @param {string} reviewId
   */
  async function getReport(reviewId) {
    return repository.read(reviewId);
  }

  function pauseAccepting() {
    accepting = false;
  }

  /**
   * @param {number} ms
   */
  async function waitForIdle(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!workerRunning && manualQueue.length === 0 && scheduledQueue.length === 0 && !currentReviewId) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    if (currentAbort) {
      currentAbort.abort();
    }
    const graceDeadline = Date.now() + 5_000;
    while (Date.now() < graceDeadline) {
      if (!workerRunning && manualQueue.length === 0 && scheduledQueue.length === 0 && !currentReviewId) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    return false;
  }

  return {
    enqueue,
    getJob,
    listReports,
    getReport,
    pauseAccepting,
    waitForIdle,
    computeInputHashFor,
    /** @internal test/health helpers */
    getHealthSnapshot() {
      return {
        accepting,
        queueLength: manualQueue.length + scheduledQueue.length,
        currentReviewId
      };
    }
  };
}
