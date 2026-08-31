import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveAnalyzersList } from './shared/config.js';
import { createSystemClock } from './shared/clock.js';
import { createLogger } from './shared/logger.js';
import { createFileReportRepository } from './file-report-repository.js';
import { createReviewJobService } from './review-job-service.js';
import { createReviewScheduler } from './review-scheduler.js';
import { validateCreateReviewRequest } from './request-validator.js';
import { collectGitChangedSource } from './git-changed-source-collector.js';
import { collectFullDirectorySource } from './full-directory-source-collector.js';
import { loadRequirement } from './requirement-loader.js';
import { resolveRules } from './rule-resolver.js';
import { buildPrompt } from './prompt-builder.js';
import { parseReviewOutput } from './review-result-parser.js';
import { applyPostReviewPolicy } from './post-review-policy.js';
import { createCursorReviewProvider } from './providers/cursor-review-provider.js';
import { createRemoteLlmReviewProvider } from './providers/remote-llm-review-provider.js';
import { createRemoteGitFetcher } from './remote-git-fetcher.js';
import { createClangTidyAnalyzer } from './clang-tidy-analyzer.js';
import { createRuffAnalyzer } from './ruff-analyzer.js';
import { createGoVetAnalyzer } from './go-vet-analyzer.js';
import { createWebAdapter } from './web/web-adapter.js';

/**
 * @param {object} entry
 * @param {object|null} logger
 */
function createAnalyzerFromEntry(entry, logger) {
  const common = {
    command: entry.command,
    args: entry.args,
    timeoutMs: entry.timeoutMs,
    onAnalyzerError: entry.onAnalyzerError,
    logger
  };
  if (entry.id === 'ruff') return createRuffAnalyzer(common);
  if (entry.id === 'go-vet') return createGoVetAnalyzer(common);
  return createClangTidyAnalyzer(common);
}

/**
 * @param {object} config
 * @param {object|null} logger
 * @returns {object[]}
 */
function buildAnalyzersFromConfig(config, logger) {
  return resolveAnalyzersList(config)
    .filter((a) => a.enabled)
    .map((a) => createAnalyzerFromEntry(a, logger));
}


/**
 * @param {object} config
 */
function assertRemoteApiKeyPresent(config) {
  if (config.ai?.provider !== 'remote') return;
  const envName = config.ai?.remote?.apiKeyEnv;
  if (!envName || typeof envName !== 'string') {
    throw new Error('远程大模型未配置 apiKeyEnv 环境变量名');
  }
  if (!process.env[envName]) {
    throw new Error(`远程大模型 API Key 环境变量未设置: ${envName}`);
  }
}

/**
 * @param {object} config
 */
function createConfiguredProvider(config) {
  if (config.ai?.provider === 'remote') {
    assertRemoteApiKeyPresent(config);
    const remote = config.ai.remote;
    return createRemoteLlmReviewProvider({
      baseUrl: remote.baseUrl,
      model: remote.model,
      apiKeyEnv: remote.apiKeyEnv,
      timeoutMs: remote.timeoutMs
    });
  }
  return createCursorReviewProvider({
    command: config.cursor.command,
    args: config.cursor.args,
    timeoutMs: config.cursor.timeoutMs,
    maxOutputChars: config.cursor.maxOutputChars,
    maxRetries: typeof config.cursor.maxRetries === 'number' ? config.cursor.maxRetries : 1
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', 'app.config.json');
const DEFAULT_RULES_DIR = path.resolve(__dirname, '..', 'docs', 'rules');

/**
 * @param {object} [overrides]
 * @returns {Promise<{
 *   server: import('node:http').Server,
 *   jobService: object,
 *   config: object,
 *   start: () => Promise<void>,
 *   stop: (opts?: { waitMs?: number }) => Promise<void>
 * }>}
 */
export async function createApp(overrides = {}) {
  const configPath = overrides.configPath ?? DEFAULT_CONFIG_PATH;
  const config = overrides.config ?? (await loadConfig(configPath));

  const reportsDir = path.resolve(config.reports?.dir ?? './data/reports');
  const rulesDir = overrides.rulesDir ?? DEFAULT_RULES_DIR;

  const clock = overrides.clock ?? createSystemClock();
  const logger = overrides.logger ?? createLogger({ clock });
  const repository =
    overrides.repository ??
    createFileReportRepository({
      reportsDir,
      ...(overrides.idFactory ? { idFactory: overrides.idFactory } : {})
    });

  if (!overrides.provider) {
    assertRemoteApiKeyPresent(config);
  }

  const provider = overrides.provider ?? createConfiguredProvider(config);

  const remoteGitFetcher =
    overrides.remoteGitFetcher ??
    createRemoteGitFetcher({
      workspaceDir: path.resolve(config.remoteGit?.workspaceDir ?? './data/remotes'),
      ephemeral: Boolean(config.remoteGit?.ephemeral),
      fetchRetries: config.remoteGit?.fetchRetries ?? 3,
      credentials: config.remoteGit?.credentials ?? {
        type: 'https',
        tokenEnv: '',
        usernameEnv: ''
      },
      allowedRoots: config.security.allowedRoots,
      logger
    });

  const ruleResolver =
    overrides.ruleResolver ??
    ((opts) => resolveRules({ ...opts, rulesDir: opts.rulesDir ?? rulesDir }));

  const analyzers =
    overrides.analyzers ??
    (overrides.analyzer
      ? [overrides.analyzer]
      : buildAnalyzersFromConfig(config, logger));

  const jobService =
    overrides.jobService ??
    createReviewJobService({
      config: { ...config, reports: { ...config.reports, dir: reportsDir } },
      gitChangedCollector: overrides.gitChangedCollector ?? collectGitChangedSource,
      fullDirectoryCollector: overrides.fullDirectoryCollector ?? collectFullDirectorySource,
      requirementLoader: overrides.requirementLoader ?? loadRequirement,
      ruleResolver,
      promptBuilder: overrides.promptBuilder ?? buildPrompt,
      provider,
      parser: overrides.parser ?? parseReviewOutput,
      policy: overrides.policy ?? applyPostReviewPolicy,
      repository,
      clock,
      logger,
      idFactory: overrides.idFactory ?? (() => repository.createReviewId()),
      remoteGitFetcher,
      analyzers,
      analyzer: analyzers[0] ?? null
    });

  const validateRequest = overrides.validateRequest ?? validateCreateReviewRequest;

  const resolvedConfig = {
    ...config,
    reports: { ...config.reports, dir: reportsDir }
  };

  const server =
    overrides.server ??
    createWebAdapter({
      jobService,
      config: resolvedConfig,
      validateRequest
    });

  const schedulerProfiles = Array.isArray(config.scheduler?.profiles)
    ? config.scheduler.profiles
    : [];
  const schedulerStateFile = path.resolve(
    config.scheduler?.stateFile ?? './data/scheduler-state.json'
  );

  /** @type {ReturnType<typeof createReviewScheduler> | null} */
  let scheduler = null;
  if (schedulerProfiles.length > 0) {
    scheduler = createReviewScheduler({
      profiles: schedulerProfiles,
      jobService,
      clock,
      stateFile: schedulerStateFile,
      computeInputHash: (normalizedRequest) => jobService.computeInputHashFor(normalizedRequest),
      logger
    });
  }

  let listening = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let schedulerTimer = null;

  async function start() {
    if (listening) return;
    const host = config.server?.host ?? '127.0.0.1';
    const port = config.server?.port ?? 3100;
    await new Promise((resolve, reject) => {
      server.listen(port, host, (err) => (err ? reject(err) : resolve()));
    });
    listening = true;

    if (scheduler && schedulerTimer == null) {
      schedulerTimer = setInterval(() => {
        void scheduler.tick().catch((err) => {
          logger.log({
            level: 'error',
            event: 'SCHEDULER_TICK_FAILED',
            message: err instanceof Error ? err.message : String(err)
          });
        });
      }, 30_000);
    }
  }

  async function stop({ waitMs = 30_000 } = {}) {
    if (schedulerTimer != null) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
    if (typeof jobService.pauseAccepting === 'function') {
      jobService.pauseAccepting();
    }
    if (typeof jobService.waitForIdle === 'function') {
      await jobService.waitForIdle(waitMs);
    }
    if (listening) {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      listening = false;
    }
  }

  return { server, jobService, config: resolvedConfig, scheduler, start, stop };
}
