import fs from 'node:fs';
import { setTimeout } from 'node:timers/promises';

const marker = process.env.CRS_FAKE_TIDY_MARKER;
if (marker) {
  fs.writeFileSync(marker, 'spawned');
}

const mode = process.env.CRS_FAKE_TIDY_MODE ?? 'emit';

if (mode === 'emit') {
  console.error('a.c:3:5: warning: unused variable [misc-unused]');
  process.exit(0);
}

if (mode === 'fail') {
  console.error('error: boom');
  process.exit(1);
}

if (mode === 'timeout') {
  await setTimeout(60_000);
  process.exit(0);
}

console.error(`unknown CRS_FAKE_TIDY_MODE: ${mode}`);
process.exit(2);
