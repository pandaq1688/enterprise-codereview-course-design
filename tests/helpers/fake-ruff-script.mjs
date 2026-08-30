/**
 * Fake ruff CLI for tests.
 * Modes via CRS_FAKE_RUFF_MODE: emit | fail
 */
const mode = process.env.CRS_FAKE_RUFF_MODE || 'emit';
const fileArg = process.argv.find((a) => a.endsWith('.py')) || 'a.py';

if (mode === 'fail') {
  console.error('ruff failed');
  process.exit(2);
}

const payload = [
  {
    code: 'F401',
    message: 'unused import',
    filename: fileArg.replace(/\\/g, '/').split('/').pop() === fileArg ? fileArg : fileArg,
    location: { row: 1, column: 1 },
    end_location: { row: 1, column: 8 }
  }
];
// Prefer relative path as passed
payload[0].filename = process.argv[process.argv.length - 1] || fileArg;
console.log(JSON.stringify(payload));
process.exit(0);
