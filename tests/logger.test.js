import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createLogger } from '../src/shared/logger.js';

function captureLogger(clock = { now: () => new Date('2026-08-30T00:00:00.000Z') }) {
  /** @type {string[]} */
  const lines = [];
  const logger = createLogger({
    stream: {
      write(chunk) {
        lines.push(String(chunk));
      }
    },
    clock
  });
  return { logger, lines };
}

test('redacts absolute path in message to projectName when provided', () => {
  const { logger, lines } = captureLogger();
  const abs = path.resolve('C:\\Users\\secret\\project\\src\\a.cpp');
  logger.log({
    level: 'error',
    event: 'review.failed',
    message: `failed reading ${abs}`,
    projectName: 'demo-proj'
  });

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.message.includes(abs), false);
  assert.ok(
    entry.message.includes('demo-proj'),
    `expected projectName in redacted message, got: ${entry.message}`
  );
});

test('redacts absolute path in message to *** when projectName missing', () => {
  const { logger, lines } = captureLogger();
  const abs = path.join(path.resolve('/tmp'), 'crs-secret', 'file.cpp');
  logger.log({
    level: 'warn',
    event: 'path.leak',
    message: `touch ${abs}`
  });

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.message.includes(abs), false);
  assert.ok(
    entry.message.includes('***'),
    `expected *** redaction, got: ${entry.message}`
  );
});
