import { execFile as cb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
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

  async function runOne(filePath, outputFile, cwd) {
    const finalArgs = args.map((a) => a.replace('{file}', filePath).replace('{outputFile}', outputFile));
    return execFile(command, finalArgs, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      ...(cwd ? { cwd } : {})
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

      const ext = path.extname(f.path).toLowerCase();
      if (!C_CPP.has(ext)) continue;

      // Write the --export-fixes file to the OS temp dir (not projectDir) so a
      // real clang-tidy run never leaves .clang-tidy-fixes-*.yaml behind in
      // the user's project tree. The file is best-effort unlinked after the
      // run; cwd stays projectDir so relative-path echo behavior is preserved.
      const outputFile = path.join(
        os.tmpdir(),
        'crs-clang-tidy-fixes-' + Buffer.from(f.path).toString('hex').slice(0, 12) + '.yaml'
      );

      try {
        // Run clang-tidy with cwd=projectDir and the relative path so it finds
        // the file and echoes relative paths in its warnings; the resulting
        // file_path then matches the relative paths used by PostReviewPolicy.
        const res = await runOne(f.path, outputFile, projectDir);
        for (const line of String(res.stdout + '\n' + res.stderr).split(/\r?\n/)) {
          const p = parseLine(line);
          if (p) {
            // Emit policy-compatible fields (file_path/line_start/risk_level/
            // title/description/evidence/category) so analyzer findings flow
            // through PostReviewPolicy.normalizeFinding and survive PF-002
            // (scope) instead of being exempted on an empty filePath. The
            // legacy severity/location/message fields are kept for existing
            // unit-test assertions and downstream consumers.
            out.push({
              id: `${analyzerId}:${p.ruleId ?? 'clang-tidy'}:${p.file}:${p.line}`,
              source: 'analyzer',
              analyzerId,
              ruleId: p.ruleId,
              category: 'MAINTAINABILITY',
              risk_level: p.severity === 'major' ? 'MEDIUM' : 'LOW',
              title: p.message,
              description: p.message,
              file_path: p.file,
              line_start: p.line,
              line_end: p.line,
              evidence: '',
              severity: p.severity,
              location: { file: p.file, line: p.line, column: p.column },
              message: p.message
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
      } finally {
        // Best-effort cleanup of the export-fixes temp file; never let an
        // unlink failure mask the real result or abort the loop.
        await fs.unlink(outputFile).catch(() => {});
      }
    }

    return out;
  }

  return { analyze };
}
