import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Text } from '../src/shared/hash.js';

test('sha256Text is stable for the same UTF-8 input', () => {
  const a = sha256Text('代码审查');
  const b = sha256Text('代码审查');
  assert.equal(a.length, 64);
  assert.equal(a, b);
  assert.notEqual(a, sha256Text('代码审查 '));
});
