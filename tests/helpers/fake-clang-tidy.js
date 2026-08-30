import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-clang-tidy-script.mjs');

/**
 * @param {{ mode: 'emit' | 'fail' | 'timeout' }} options
 * @returns {{ command: string, args: string[], env: { CRS_FAKE_TIDY_MODE: string } }}
 */
export function fakeClangTidy({ mode }) {
  return {
    command: process.execPath,
    args: [scriptPath],
    env: { CRS_FAKE_TIDY_MODE: mode }
  };
}

export { scriptPath as fakeClangTidyScriptPath };
