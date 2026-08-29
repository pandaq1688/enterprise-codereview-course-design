import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Test-only ReviewProvider. Not a product feature.
 *
 * @param {{
 *   rawOutput: string,
 *   exitCode?: number,
 *   delayMs?: number,
 *   writeOutputFile?: boolean
 * }} options
 */
export function createFakeReviewProvider({
  rawOutput,
  exitCode = 0,
  delayMs = 0,
  writeOutputFile = false
}) {
  async function review({ outputFile }) {
    const started = Date.now();
    if (delayMs > 0) {
      await delay(delayMs);
    }
    if (writeOutputFile && outputFile) {
      await fs.writeFile(outputFile, rawOutput, 'utf8');
    }
    return {
      rawOutput,
      exitCode,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - started,
      providerMetadata: { fake: true }
    };
  }

  return { review };
}
