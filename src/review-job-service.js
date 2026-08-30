import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from './shared/app-error.js';
import { ErrorCodes } from './shared/error-codes.js';
import { sha256Text } from './shared/hash.js';
import { PROMPT_SCHEMA_VERSION, REPORT_SCHEMA_VERSION } from './shared/versions.js';
import { createSemaphore } from './semaphore.js';
import { planShards } from './shard-planner.js';

const RISK_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
function maxRisk(a, b) {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

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
    code: ErrorCodes.INTERNAL_ERROR,
    message: '服务器内部错误',
    details: []
  };
}

/**
 * @param {object} config
 * @returns {number | undefined}
 */
function resolveReviewTimeoutMs(config) {
  if (config?.ai?.provider === 'remote') {
    return config.ai?.remote?.timeoutMs;
  }
  return config?.cursor?.timeoutMs;
}

function logAnalyzerSkipped(logger, reviewId) {
  const message = '静态分析器失败，已跳过';
  if (!logger) return;
  if (typeof logger.log === 'function') {
    logger.log({
      level: 'warn',
      event: ErrorCodes.ANALYZER_SKIPPED,
      reviewId,
      stage: 'FILTERING',
      errorCode: ErrorCodes.ANALYZER_SKIPPED,
      message
    });
    return;
  }
  logger.warn?.(`[${ErrorCodes.ANALYZER_SKIPPED}] ${message}`);
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
    idFactory,
    remoteGitFetcher,
    analyzer
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

    let projectDir = normalizedRequest.projectDir;
    let innerSourceMode = normalizedRequest.sourceMode;
    let fetchedCleanup = null;

    if (normalizedRequest.sourceMode === 'REMOTE_GIT') {
      if (!remoteGitFetcher) {
        throw new AppError(ErrorCodes.INVALID_REQUEST, '未配置远程 Git 拉取', []);
      }
      const fetched = await remoteGitFetcher.fetch({
        remoteUrl: normalizedRequest.remoteUrl,
        ref: normalizedRequest.ref
      });
      projectDir = fetched.localDir;
      fetchedCleanup = fetched.cleanup ?? null;
      innerSourceMode = normalizedRequest.reviewMode;
    }

    const collectOpts = {
      projectDir,
      maxFiles: Infinity,
      maxFileChars: Infinity,
      maxInputChars: Infinity
    };

    const source =
      innerSourceMode === 'GIT_CHANGES'
        ? await gitChangedCollector(collectOpts)
        : await fullDirectoryCollector(collectOpts);

    const { rules } = await ruleResolver({
      projectDir,
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

    return { requirement, source, rules, inputHash, fetchedCleanup, projectDir };
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
      triggerType: job.triggerType,
      reviewMode: req.reviewMode ?? null,
      remoteUrl: req.remoteUrl ?? null
    };
    if (includeAbs) {
      request.projectDir = req.projectDir ?? job.effectiveProjectDir ?? null;
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
    /** @type {string[]} */
    let shardCleanupFiles = [];
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
      job._fetchedCleanup = collected.fetchedCleanup ?? null;
      job.effectiveProjectDir = collected.projectDir;
      // Ruling: source-limit enforcement moved from collectors into JobService.
      // Collectors were called with relaxed (Infinity) limits, so they never
      // throw on source count/size. Exceeding limits now auto-shards.
      const limits = config.review;
      const totalCharacters = collected.source.files.reduce(
        (s, f) => s + String(collected.source.contents?.[f.path] ?? '').length,
        0
      );
      const exceeds =
        collected.source.files.length > limits.maxFiles ||
        totalCharacters > limits.maxInputChars;

      let shards = null;
      if (exceeds || config.sharding?.enabled) {
        const planned = planShards({
          files: collected.source.files,
          contents: collected.source.contents,
          shardChars: config.sharding.shardChars,
          maxShards: config.sharding.maxShards
        });
        shards = planned.shards;
      }

      const isSharded = shards && shards.length > 1;

      // Single-call path uses one prompt built from ALL files. The sharded path
      // builds one prompt per shard from ONLY that shard's files (token-budget
      // reduction) and gives each shard its own promptFile/outputFile (no race
      // when maxConcurrency > 1).
      /** @type {{ shard: object, promptFile: string, outputFile: string }[]} */
      let shardJobs = [];
      if (!isSharded) {
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
      } else {
        shardJobs = shards.map((shard) => ({
          shard,
          promptFile: path.join(
            os.tmpdir(),
            `crs-${job.reviewId}-shard-${shard.index}-prompt.txt`
          ),
          outputFile: path.join(
            os.tmpdir(),
            `crs-${job.reviewId}-shard-${shard.index}-out.json`
          )
        }));
        for (const shj of shardJobs) {
          const shardPrompt = promptBuilder({
            requirementText: collected.requirement.text,
            sourceMode: job.request.sourceMode,
            files: shj.shard.files,
            contents: collected.source.contents,
            rules: collected.rules
          });
          await fs.writeFile(shj.promptFile, shardPrompt.text, 'utf8');
          shardCleanupFiles.push(shj.promptFile, shj.outputFile);
        }
      }

      setStatus(job, 'REVIEWING');
      logger.log({
        level: 'info',
        event: 'JOB_STAGE',
        reviewId: job.reviewId,
        stage: 'REVIEWING',
        message: job.request.projectName
      });

      let providerResult;
      let parsed;
      let rawOutput;
      let aiShards;

      if (isSharded) {
        const sem = createSemaphore(config.sharding.maxConcurrency);
        const shardResults = await Promise.all(
          shardJobs.map(({ shard, promptFile: shardPromptFile, outputFile: shardOutputFile }) =>
            sem.run(() =>
              provider.review({
                projectDir: job.effectiveProjectDir,
                promptFile: shardPromptFile,
                outputFile: shardOutputFile,
                timeoutMs: resolveReviewTimeoutMs(config),
                signal: currentAbort.signal,
                files: shard.files
              })
            )
          )
        );
        job._shards = shards;

        setStatus(job, 'FILTERING');
        const allFindings = [];
        const allRecommendedActions = [];
        const allEvidence = [];
        let mergedSummary = '';
        let mergedOverallRisk = 'LOW';
        let totalDurationMs = 0;
        let mergedExitCode = 0;
        let mergedModel = null;
        const rawOutputs = [];
        const stderrParts = [];
        let parseError = null;
        for (const res of shardResults) {
          const shardRaw = truncate(res.rawOutput ?? '', maxOutputChars);
          rawOutputs.push(shardRaw);
          stderrParts.push(res.stderr ?? '');
          totalDurationMs += res.durationMs ?? 0;
          if (res.exitCode) mergedExitCode = res.exitCode;
          mergedModel = mergedModel ?? res.providerMetadata?.model ?? null;
          try {
            const shardParsed = parser(shardRaw);
            allFindings.push(...shardParsed.findings);
            if (shardParsed.summary) mergedSummary = mergedSummary || shardParsed.summary;
            mergedOverallRisk = maxRisk(mergedOverallRisk, shardParsed.overall_risk);
            allRecommendedActions.push(...(shardParsed.recommended_actions ?? []));
            allEvidence.push(...(shardParsed.evidence ?? []));
          } catch (err) {
            parseError = err;
            break;
          }
        }
        providerResult = {
          rawOutput: rawOutputs.join('\n--- shard ---\n'),
          durationMs: totalDurationMs,
          exitCode: mergedExitCode,
          stderr: stderrParts.join('\n'),
          providerMetadata: { model: mergedModel }
        };
        rawOutput = truncate(providerResult.rawOutput ?? '', maxOutputChars);
        aiShards = shards.map((s) => ({
          index: s.index,
          files: s.files.map((f) => ({ path: f.path })),
          charCount: s.charCount
        }));
        if (parseError) {
          const entry = toErrorEntry(parseError);
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
        parsed = {
          summary: mergedSummary,
          overall_risk: mergedOverallRisk,
          findings: allFindings,
          evidence: allEvidence,
          recommended_actions: allRecommendedActions
        };
      } else {
        try {
          providerResult = await provider.review({
            projectDir: job.effectiveProjectDir,
            promptFile,
            outputFile,
            timeoutMs: resolveReviewTimeoutMs(config),
            signal: currentAbort.signal
          });
        } catch (err) {
          const entry = toErrorEntry(err);
          const errRawOutput =
            err && typeof err === 'object' && 'rawOutput' in err
              ? truncate(/** @type {{ rawOutput?: string }} */ (err).rawOutput, maxOutputChars)
              : '';
          await persistReport(
            job,
            collected,
            emptyAi({
              durationMs: Math.max(0, clock.now().getTime() - started.getTime()),
              rawOutput: errRawOutput,
              stderrSummary: truncate(err instanceof Error ? err.message : String(err), 2000)
            }),
            emptyResult(),
            [entry],
            'FAILED'
          );
          return;
        }

        rawOutput = truncate(providerResult.rawOutput ?? '', maxOutputChars);

        setStatus(job, 'FILTERING');
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
      }

      const aiFindings = parsed.findings;
      let mergedRaw = aiFindings;
      if (analyzer && config.analyzer?.enabled) {
        try {
          const analyzerFindings = await analyzer.analyze({
            projectDir: job.effectiveProjectDir,
            files: collected.source.files,
            signal: currentAbort.signal
          });
          mergedRaw = [...aiFindings, ...analyzerFindings];
        } catch (err) {
          if (
            err instanceof AppError &&
            err.code === ErrorCodes.ANALYZER_FAILED &&
            config.analyzer?.onAnalyzerError === 'skip'
          ) {
            logAnalyzerSkipped(logger, job.reviewId);
            mergedRaw = aiFindings;
          } else {
            throw err;
          }
        }
      }

      const policyResult = policy({
        rawFindings: mergedRaw,
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
        stderrSummary: truncate(providerResult.stderr ?? '', 2000),
        ...(aiShards ? { shards: aiShards } : {})
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
      for (const p of [promptFile, outputFile, ...shardCleanupFiles]) {
        if (!p) continue;
        try {
          await fs.unlink(p);
        } catch {
          // best-effort; Cursor provider may already have removed them
        }
      }
      if (job._fetchedCleanup) {
        try {
          await job._fetchedCleanup();
        } catch {
          // best-effort ephemeral workspace cleanup
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
