import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLocalTime } from '../src/shared/time-format.js';

test('formatLocalTime returns empty string for nullish or empty input', () => {
  assert.equal(formatLocalTime(null), '');
  assert.equal(formatLocalTime(undefined), '');
  assert.equal(formatLocalTime(''), '');
});

test('formatLocalTime returns empty string for unparseable input', () => {
  assert.equal(formatLocalTime('not-a-date'), 'not-a-date');
});

test('formatLocalTime renders a UTC offset marker for a valid timestamp', () => {
  const out = formatLocalTime('2026-08-30T08:03:28.632Z');
  assert.ok(out.length > 0);
  assert.match(out, /UTC[+-]\d{2}:\d{2}/);
  assert.equal(out.endsWith('Z'), false);
});

test('formatLocalTime produces a stable YYYY-MM-DD HH:mm:ss prefix', () => {
  const out = formatLocalTime('2026-01-01T00:00:00.000Z');
  assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC/);
});
