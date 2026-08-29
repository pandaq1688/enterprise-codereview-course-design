import { spawn as defaultSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { AppError } from '../shared/app-error.js';
import { ErrorCodes } from '../shared/error-codes.js';

const PLACEHOLDERS = Object.freeze({
  '{promptFile}': 'promptFile',
  '{projectDir}': 'projectDir',
  '{outputFile}': 'outputFile'
});

function resolveArgs(args, ctx) {
  return args.map((arg) => {
    const key = PLACEHOLDERS[arg];
    return key ? ctx[key] : arg;
  });
}

function hasOutputFilePlaceholder(args) {
  return args.includes('{outputFile}');
}

function childHasExited(child) {
  if (!child) return false;
  if (child.exitCode !== null && child.exitCode !== undefined) return true;
  if (child.signalCode !== null && child.signalCode !== undefined) return true;
  return false;
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      // Best-effort cleanup.
    }
  }
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try {
      defaultSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      });
      return;
    } catch {
      // fall through
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // fall through
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // ignore
  }
}

/**
 * @param {{
 *   command: string,
 *   args: string[],
 *   timeoutMs: number,
 *   maxOutputChars: number,
 *   spawnImpl?: typeof defaultSpawn
 * }} options
 */
export function createCursorReviewProvider({
  command,
  args,
  timeoutMs: defaultTimeoutMs,
  maxOutputChars,
  spawnImpl = defaultSpawn
}) {
  async function review({ projectDir, promptFile, outputFile, timeoutMs, signal }) {
    const started = Date.now();
    const effectiveTimeout = timeoutMs ?? defaultTimeoutMs;
    const useOutputFile = hasOutputFilePlaceholder(args);
    const resolvedArgs = resolveArgs(args, { projectDir, promptFile, outputFile });

    let child;
    let timedOut = false;
    let aborted = false;
    let outputTooLarge = false;
    let stdout = '';
    let stderr = '';
    let exitCode = null;
    let spawnError = null;
    let childExited = false;

    try {
      await new Promise((resolve, reject) => {
        try {
          child = spawnImpl(command, resolvedArgs, {
            shell: false,
            windowsHide: true
          });
        } catch (err) {
          reject(
            new AppError(
              ErrorCodes.CURSOR_START_FAILED,
              `无法启动 Cursor 命令: ${command}`
            )
          );
          return;
        }

        let settled = false;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (abortHandler && signal) {
            signal.removeEventListener('abort', abortHandler);
          }
          if (err) reject(err);
          else resolve();
        };

        const onAbort = () => {
          if (settled || childExited || childHasExited(child)) return;
          aborted = true;
          killProcessTree(child);
        };

        let abortHandler;
        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            abortHandler = onAbort;
            signal.addEventListener('abort', abortHandler, { once: true });
          }
        }

        const timer = setTimeout(() => {
          if (settled || childExited || aborted || childHasExited(child)) return;
          timedOut = true;
          killProcessTree(child);
        }, effectiveTimeout);

        const append = (kind, chunk) => {
          const text = chunk.toString('utf8');
          if (kind === 'stdout') stdout += text;
          else stderr += text;
          if (stdout.length + stderr.length > maxOutputChars) {
            outputTooLarge = true;
            killProcessTree(child);
          }
        };

        child.stdout?.on('data', (chunk) => append('stdout', chunk));
        child.stderr?.on('data', (chunk) => append('stderr', chunk));

        child.on('error', (err) => {
          spawnError = err;
          finish();
        });

        child.on('close', (code) => {
          childExited = true;
          exitCode = code;
          finish();
        });
      });

      if (spawnError) {
        throw new AppError(
          ErrorCodes.CURSOR_START_FAILED,
          `无法启动 Cursor 命令: ${command}`
        );
      }
      if (aborted) {
        throw new AppError(ErrorCodes.CURSOR_ABORTED, 'Cursor 审查已取消');
      }
      if (timedOut) {
        throw new AppError(ErrorCodes.CURSOR_TIMEOUT, 'Cursor 审查超时');
      }
      if (outputTooLarge) {
        throw new AppError(
          ErrorCodes.CURSOR_OUTPUT_TOO_LARGE,
          'Cursor 输出超过限制'
        );
      }
      if (exitCode !== 0) {
        throw new AppError(
          ErrorCodes.CURSOR_EXIT_NON_ZERO,
          `Cursor 进程异常退出，退出码 ${exitCode}`
        );
      }

      let rawOutput = stdout;
      if (useOutputFile) {
        try {
          const st = await fs.stat(outputFile);
          if (st.size > maxOutputChars) {
            throw new AppError(
              ErrorCodes.CURSOR_OUTPUT_TOO_LARGE,
              'Cursor 输出超过限制'
            );
          }
          rawOutput = await fs.readFile(outputFile, 'utf8');
        } catch (err) {
          if (err instanceof AppError) throw err;
          rawOutput = '';
        }
        if (rawOutput.length > maxOutputChars) {
          throw new AppError(
            ErrorCodes.CURSOR_OUTPUT_TOO_LARGE,
            'Cursor 输出超过限制'
          );
        }
      }

      return {
        rawOutput,
        exitCode: exitCode ?? 0,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        providerMetadata: { command }
      };
    } finally {
      await safeUnlink(promptFile);
      await safeUnlink(outputFile);
    }
  }

  return { review };
}
