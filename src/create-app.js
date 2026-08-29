import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './shared/config.js';
import { createSystemClock } from './shared/clock.js';
import { createLogger } from './shared/logger.js';
import { createFileReportRepository } from './file-report-repository.js';
import { createReviewJobService } from './review-job-service.js';
import { validateCreateReviewRequest } from './request-validator.js';
import { collectGitChangedSource } from './git-changed-source-collector.js';
import { collectFullDirectorySource } from './full-directory-source-collector.js';
import { loadRequirement } from './requirement-loader.js';
import { resolveRules } from './rule-resolver.js';
import { buildPrompt } from './prompt-builder.js';
import { parseReviewOutput } from './review-result-parser.js';
import { applyPostReviewPolicy } from './post-review-policy.js';
import { createCursorReviewProvider } from './providers/cursor-review-provider.js';
import { createWebAdapter } from './web/web-adapter.js';

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

  const provider =
    overrides.provider ??
    createCursorReviewProvider({
      command: config.cursor.command,
      args: config.cursor.args,
      timeoutMs: config.cursor.timeoutMs,
      maxOutputChars: config.cursor.maxOutputChars
    });

  const ruleResolver =
    overrides.ruleResolver ??
    ((opts) => resolveRules({ ...opts, rulesDir: opts.rulesDir ?? rulesDir }));

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
      idFactory: overrides.idFactory ?? (() => repository.createReviewId())
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

  let listening = false;

  async function start() {
    if (listening) return;
    const host = config.server?.host ?? '127.0.0.1';
    const port = config.server?.port ?? 3100;
    await new Promise((resolve, reject) => {
      server.listen(port, host, (err) => (err ? reject(err) : resolve()));
    });
    listening = true;
  }

  async function stop({ waitMs = 30_000 } = {}) {
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

  return { server, jobService, config: resolvedConfig, start, stop };
}
