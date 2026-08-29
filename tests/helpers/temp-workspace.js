import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function makeTempDir(prefix = 'crs-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
