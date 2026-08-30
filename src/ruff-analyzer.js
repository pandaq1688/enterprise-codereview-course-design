import { execFile as cb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { AppError } from './shared/app-error.js';
import { ErrorCodes } from './shared/error-codes.js';

const execFile = promisify(cb);

function logAnalyzerSkipped(logger, message) {
  if (!logger) return;
  if (typeof logger.log === 'function') {
    logger.log({
      level: 'warn',
      event: ErrorCodes.ANALYZER_SKIPPED,
      errorCode: ErrorCodes.ANALYZER_SKIPPED,
      message
    });
    return;
  }
  logger.warn?.(`[${ErrorCodes.ANALYZER_SKIPPED}] ${message}`);
}

/**
 * Parse ruff --output-format=json diagnostics into policy-compatible findings.
 * @param {string} stdout
 * @param {string} analyzerId
 */
export function parseRuffJson(stdout, analyzerId = 'ruff') {
  let rows;
  try {
    rows = JSON.parse(String(stdout || '[]'));
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const file = String(row.filename ?? row.file ?? '').replace(/\\/g, '/');
    const line = Number(row.location?.row ?? row.location?.line ?? row.row ?? 1);
    const col = Number(row.location?.column ?? row.column ?? 1);
    const ruleId = row.code ?? row.rule ?? null;
    const message = row.message ?? row.body ?? 'ruff diagnostic';
    return {
      id: `${analyzerId}:${ruleId ?? 'ruff'}:${file}:${line}`,
      source: 'analyzer',
      analyzerId,
      ruleId,
      category: 'MAINTAINABILITY',
      risk_level: 'LOW',
      title: message,
      description: message,
      file_path: file,
      line_start: line,
      line_end: line,
      evidence: '',
      severity: 'minor',
      location: { file, line, column: col },
      message
    };
  });
}

export function createRuffAnalyzer({
  command = 'ruff',
  args = ['check', '--output-format=json', '{file}'],
  timeoutMs = 300000,
  onAnalyzerError = 'skip',
  logger = null
} = {}) {
  const analyzerId = 'ruff';

  async function runOne(filePath, cwd, signal) {
    const finalArgs = args.map((a) => a.replaceAll('{file}', filePath));
    return execFile(command, finalArgs, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      ...(cwd ? { cwd } : {}),
      ...(signal ? { signal } : {})
    });
  }

  async function analyze({ projectDir, files, signal }) {
    if (signal?.aborted) {
      logAnalyzerSkipped(logger, '分析器已中止，跳过');
      return [];
    }
    const out = [];
    for (const f of files) {
      if (signal?.aborted) {
        logAnalyzerSkipped(logger, '分析器已中止，跳过');
        return out;
      }
      if (path.extname(f.path).toLowerCase() !== '.py') continue;
      try {
        const res = await runOne(f.path, projectDir, signal);
        out.push(...parseRuffJson(res.stdout, analyzerId));
      } catch (err) {
        if (signal?.aborted) {
          logAnalyzerSkipped(logger, '分析器已中止，跳过');
          return out;
        }
        // ruff exits non-zero when diagnostics found — still parse stdout
        if (err && typeof err === 'object' && 'stdout' in err && err.stdout) {
          const parsed = parseRuffJson(err.stdout, analyzerId);
          if (parsed.length > 0) {
            out.push(...parsed);
            continue;
          }
        }
        const isTimeout =
          err.code === 'ETIMEDOUT' || err.killed === true || /timeout/i.test(String(err.message || ''));
        if (onAnalyzerError === 'fail' || isTimeout) {
          throw new AppError(ErrorCodes.ANALYZER_FAILED, 'ruff 执行失败', [f.path, String(err.message ?? err)]);
        }
        logAnalyzerSkipped(logger, `跳过 ${f.path}：${err.message ?? err}`);
      }
    }
    return out;
  }

  return { analyze, analyzerId };
}
