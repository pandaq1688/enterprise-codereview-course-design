/**
 * JSON-lines logger. Never write absolute paths — use projectName in messages.
 *
 * @param {{
 *   stream?: { write(chunk: string): unknown },
 *   clock: { now(): Date }
 * }} opts
 */
export function createLogger({ stream = process.stdout, clock }) {
  /**
   * Replace absolute filesystem paths in a log message.
   * @param {string} message
   * @param {string | null | undefined} projectName
   */
  function redactAbsolutePaths(message, projectName) {
    const replacement =
      projectName != null && String(projectName).length > 0 ? String(projectName) : '***';
    let s = String(message);
    // Windows drive paths (C:\... or C:/...)
    s = s.replace(/[A-Za-z]:[\\/][^\s"']+/g, replacement);
    // UNC paths
    s = s.replace(/\\\\[^\s"']+/g, replacement);
    // POSIX absolute paths with at least one directory segment
    s = s.replace(/(?<![A-Za-z0-9:])\/(?:[\w.-]+\/)+[\w.-]*/g, replacement);
    return s;
  }

  /**
   * @param {{
   *   level?: string,
   *   event?: string,
   *   reviewId?: string,
   *   stage?: string,
   *   durationMs?: number,
   *   errorCode?: string,
   *   message?: string,
   *   projectName?: string
   * }} entry
   */
  function log(entry = {}) {
    let message = entry.message ?? null;
    if (message != null) {
      message = redactAbsolutePaths(message, entry.projectName);
    }
    const line = JSON.stringify({
      timestamp: clock.now().toISOString(),
      level: entry.level ?? 'info',
      event: entry.event ?? null,
      reviewId: entry.reviewId ?? null,
      stage: entry.stage ?? null,
      durationMs: entry.durationMs ?? null,
      errorCode: entry.errorCode ?? null,
      message
    });
    stream.write(`${line}\n`);
  }

  return { log };
}
