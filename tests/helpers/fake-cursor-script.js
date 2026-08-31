import fs from 'node:fs/promises';
import path from 'node:path';

/** Scripts written into a temp dir and spawned by CursorReviewProvider tests. */

export const SUCCESS_SCRIPT = `import fs from 'node:fs';
const output = process.argv[process.argv.indexOf('--output') + 1];
fs.writeFileSync(output, '{"summary":"ok","overall_risk":"LOW","findings":[]}');
`;

export const TIMEOUT_SCRIPT = `import { setTimeout } from 'node:timers/promises';
await setTimeout(60_000);
`;

export const EXIT_NON_ZERO_SCRIPT = `process.stderr.write('fake-agent boom details');
process.exit(2);
`;

/** Fails on attempt 1 (exit 1 + stderr), succeeds on later attempts. */
export const FLAKY_THEN_OK_SCRIPT = `import fs from 'node:fs';
const attempt = process.env.CRS_CURSOR_ATTEMPT || '1';
const output = process.argv[process.argv.indexOf('--output') + 1];
if (attempt === '1') {
  process.stderr.write('transient agent failure');
  process.exit(1);
}
fs.writeFileSync(output, '{"summary":"ok","overall_risk":"LOW","findings":[]}');
`;

export const LARGE_STDOUT_SCRIPT = `process.stdout.write('x'.repeat(1000));
`;

export const LARGE_OUTPUT_FILE_SCRIPT = `import fs from 'node:fs';
const output = process.argv[process.argv.indexOf('--output') + 1];
fs.writeFileSync(output, 'y'.repeat(1000));
`;

/**
 * @param {string} dir
 * @param {string} name
 * @param {string} source
 * @returns {Promise<string>} absolute path to written script
 */
export async function writeFakeCursorScript(dir, name, source) {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, source, 'utf8');
  return filePath;
}
