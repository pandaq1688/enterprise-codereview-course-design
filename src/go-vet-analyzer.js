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
 * Parse go vet style diagnostics: `file:line:col: message`
 * @param {string} text
 * @param {string} analyzerId
 */
export function parseGoVetOutput(text, analyzerId = 'go-vet') {
  const out = [];
  const re = /^(.+?):(\d+)(?::(\d+))?:\s*(.+)$/;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = re.exec(line);
    if (!m) continue;
    const file = m[1].replace(/\\/g, '/');
    const ln = Number(m[2]);
    const col = m[3] ? Number(m[3]) : 1;
    const message = m[4];
    out.push({
      id: `${analyzerId}:govet:${file}:${ln}:${message.slice(0, 40)}`,
      source: 'analyzer',
      analyzerId,
      ruleId: 'go-vet',
      category: 'CORRECTNESS',
      risk_level: 'MEDIUM',
      title: message,
      description: message,
      file_path: file,
      line_start: ln,
      line_end: ln,
      evidence: '',
      severity: 'major',
      location: { file, line: ln, column: col },
      message
    });
  }
  return out;
}

export function createGoVetAnalyzer({
  command = 'go',
  args = ['vet', '{file}'],
  timeoutMs = 300000,
  onAnalyzerError = 'skip',
  logger = null
} = {}) {
  const analyzerId = 'go-vet';

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
      if (path.extname(f.path).toLowerCase() !== '.go') continue;
      try {
        const res = await runOne(f.path, projectDir, signal);
        out.push(...parseGoVetOutput(`${res.stdout}\n${res.stderr}`, analyzerId));
      } catch (err) {
        if (signal?.aborted) {
          logAnalyzerSkipped(logger, '分析器已中止，跳过');
          return out;
        }
        // go vet exits non-zero when issues found — parse stderr/stdout
        if (err && typeof err === 'object') {
          const text = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
          const parsed = parseGoVetOutput(text, analyzerId);
          if (parsed.length > 0) {
            out.push(...parsed);
            continue;
          }
        }
        const isTimeout =
          err.code === 'ETIMEDOUT' || err.killed === true || /timeout/i.test(String(err.message || ''));
        if (onAnalyzerError === 'fail' || isTimeout) {
          throw new AppError(ErrorCodes.ANALYZER_FAILED, 'go vet 执行失败', [f.path, String(err.message ?? err)]);
        }
        logAnalyzerSkipped(logger, `跳过 ${f.path}：${err.message ?? err}`);
      }
    }
    return out;
  }

  return { analyze, analyzerId };
}
