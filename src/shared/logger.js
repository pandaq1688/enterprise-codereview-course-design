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
   * @param {{
   *   level?: string,
   *   event?: string,
   *   reviewId?: string,
   *   stage?: string,
   *   durationMs?: number,
   *   errorCode?: string,
   *   message?: string
   * }} entry
   */
  function log(entry = {}) {
    const line = JSON.stringify({
      timestamp: clock.now().toISOString(),
      level: entry.level ?? 'info',
      event: entry.event ?? null,
      reviewId: entry.reviewId ?? null,
      stage: entry.stage ?? null,
      durationMs: entry.durationMs ?? null,
      errorCode: entry.errorCode ?? null,
      message: entry.message ?? null
    });
    stream.write(`${line}\n`);
  }

  return { log };
}
