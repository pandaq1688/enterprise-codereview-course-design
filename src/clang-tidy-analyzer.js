import { execFile as cb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { AppError } from './shared/app-error.js';
import { ErrorCodes } from './shared/error-codes.js';

const execFile = promisify(cb);
const C_CPP = new Set(['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp']);
const SEVERITY_MAP = { warning: 'minor', error: 'major' };

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

function parseLine(line) {
  const m = String(line).match(/^([^:]+):(\d+):(\d+):\s*(\w+):\s*(.+?)(?:\s\[([^\]]+)\])?\s*$/);
  if (!m) return null;
  const [, file, ln, col, sev, msg, rule] = m;
  const ruleId = rule || null;
  const severity = SEVERITY_MAP[sev] ?? 'minor';
  return { file, line: Number(ln), column: Number(col), severity, message: msg, ruleId };
}

export function createClangTidyAnalyzer({
  command = 'clang-tidy',
  args = [],
  timeoutMs = 300000,
  onAnalyzerError = 'skip',
  logger = null
} = {}) {
  const analyzerId = 'clang-tidy';

  async function runOne(filePath, outputFile) {
    const finalArgs = args.map((a) => a.replace('{file}', filePath).replace('{outputFile}', outputFile));
    return execFile(command, finalArgs, { windowsHide: true, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
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

      const ext = path.extname(f.path).toLowerCase();
      if (!C_CPP.has(ext)) continue;

      const outputFile = path.join(
        projectDir,
        '.clang-tidy-fixes-' + Buffer.from(f.path).toString('hex').slice(0, 12) + '.yaml'
      );

      try {
        const res = await runOne(f.path, outputFile);
        for (const line of String(res.stdout + '\n' + res.stderr).split(/\r?\n/)) {
          const p = parseLine(line);
          if (p) {
            out.push({
              id: `${analyzerId}:${p.ruleId ?? 'clang-tidy'}:${p.file}:${p.line}`,
              severity: p.severity,
              category: p.ruleId ?? 'clang-tidy',
              message: p.message,
              location: { file: p.file, line: p.line, column: p.column },
              source: 'analyzer',
              analyzerId,
              ruleId: p.ruleId
            });
          }
        }
      } catch (err) {
        if (signal?.aborted) {
          logAnalyzerSkipped(logger, '分析器已中止，跳过');
          return out;
        }

        const isTimeout =
          err.code === 'ETIMEDOUT' || err.killed === true || /timeout/i.test(String(err.message || ''));
        if (onAnalyzerError === 'fail' || isTimeout) {
          throw new AppError(ErrorCodes.ANALYZER_FAILED, 'clang-tidy 执行失败', [f.path, String(err.message ?? err)]);
        }
        logAnalyzerSkipped(logger, `跳过 ${f.path}：${err.message ?? err}`);
      }
    }

    return out;
  }

  return { analyze };
}
