import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planShards } from '../src/shard-planner.js';
import { AppError } from '../src/shared/app-error.js';
import { ErrorCodes } from '../src/shared/error-codes.js';

function file(path) {
  return { path };
}

test('total chars < shardChars → single shard with all files, truncated false', () => {
  const files = [file('a.js'), file('b.js')];
  const contents = { 'a.js': 'hello', 'b.js': 'world' };
  const result = planShards({ files, contents, shardChars: 100, maxShards: 10 });

  assert.equal(result.truncated, false);
  assert.equal(result.shards.length, 1);
  assert.equal(result.shards[0].index, 0);
  assert.deepEqual(result.shards[0].files, files);
  assert.equal(result.shards[0].charCount, 10);
});

test('total chars > shardChars → multiple shards, each within budget, all files covered in order', () => {
  const files = [file('a.js'), file('b.js'), file('c.js')];
  const contents = { 'a.js': 'aa', 'b.js': 'bb', 'c.js': 'ccc' };
  const result = planShards({ files, contents, shardChars: 5, maxShards: 10 });

  assert.equal(result.truncated, false);
  assert.equal(result.shards.length, 2);
  assert.equal(result.shards[0].charCount, 4);
  assert.equal(result.shards[1].charCount, 3);
  for (const shard of result.shards) {
    assert.ok(shard.charCount <= 5);
  }
  const covered = result.shards.flatMap((s) => s.files.map((f) => f.path));
  assert.deepEqual(covered, ['a.js', 'b.js', 'c.js']);
  assert.equal(result.shards[0].files[0].path, 'a.js');
  assert.equal(result.shards[0].files[1].path, 'b.js');
  assert.equal(result.shards[1].files[0].path, 'c.js');
});

test('single file > shardChars → own shard, charCount exceeds budget, truncated true', () => {
  const files = [file('big.js'), file('small.js')];
  const contents = { 'big.js': 'x'.repeat(20), 'small.js': 'ok' };
  const result = planShards({ files, contents, shardChars: 10, maxShards: 10 });

  assert.equal(result.truncated, true);
  assert.equal(result.shards.length, 2);
  assert.deepEqual(result.shards[0].files, [file('big.js')]);
  assert.equal(result.shards[0].charCount, 20);
  assert.ok(result.shards[0].charCount > 10);
  assert.deepEqual(result.shards[1].files, [file('small.js')]);
});

test('shard count > maxShards → throws SHARD_LIMIT_EXCEEDED AppError', () => {
  const files = [file('a.js'), file('b.js'), file('c.js')];
  const contents = { 'a.js': 'aaa', 'b.js': 'bbb', 'c.js': 'ccc' };

  assert.throws(
    () => planShards({ files, contents, shardChars: 3, maxShards: 2 }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, ErrorCodes.SHARD_LIMIT_EXCEEDED);
      assert.equal(err.message, '分片数超过上限');
      assert.deepEqual(err.details, ['shards=3', 'maxShards=2']);
      return true;
    }
  );
});

test('empty file list → { shards: [], truncated: false }', () => {
  const result = planShards({ files: [], contents: {}, shardChars: 100, maxShards: 10 });
  assert.deepEqual(result, { shards: [], truncated: false });
});

test('missing content for file → treated as 0 chars, no throw', () => {
  const files = [file('missing.js'), file('present.js')];
  const contents = { 'present.js': 'hi' };
  const result = planShards({ files, contents, shardChars: 100, maxShards: 10 });

  assert.equal(result.truncated, false);
  assert.equal(result.shards.length, 1);
  assert.deepEqual(result.shards[0].files, files);
  assert.equal(result.shards[0].charCount, 2);
});
