/**
 * Fake go vet CLI for tests.
 * Modes via CRS_FAKE_GOVET_MODE: emit | fail
 */
const mode = process.env.CRS_FAKE_GOVET_MODE || 'emit';
const fileArg = process.argv[process.argv.length - 1] || 'main.go';

if (mode === 'fail') {
  console.error('go vet failed');
  process.exit(2);
}

console.error(`${fileArg}:12:2: unreachable code`);
process.exit(1);
