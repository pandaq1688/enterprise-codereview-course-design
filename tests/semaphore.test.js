import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSemaphore } from '../src/semaphore.js';

test('run executes 3 async fns serially in call order when max=1', async () => {
  const sem = createSemaphore(1);
  const order = [];
  const make = (id, ms) => async () => {
    await new Promise((r) => setTimeout(r, ms));
    order.push(id);
  };
  const p1 = sem.run(make('a', 30));
  const p2 = sem.run(make('b', 5));
  const p3 = sem.run(make('c', 5));
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('max=2: first 2 run concurrently, 3rd waits; concurrency <= 2', async () => {
  const sem = createSemaphore(2);
  let active = 0;
  let maxActive = 0;
  const track = async (id) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 30));
    active -= 1;
    return id;
  };
  const p1 = sem.run(() => track('a'));
  const p2 = sem.run(() => track('b'));
  const p3 = sem.run(() => track('c'));
  const results = await Promise.all([p1, p2, p3]);
  assert.equal(maxActive, 2);
  assert.deepEqual(results, ['a', 'b', 'c']);
});

test('run returns the awaited return value of fn', async () => {
  const sem = createSemaphore(2);
  const val = await sem.run(async () => 42);
  assert.equal(val, 42);
  const obj = await sem.run(async () => ({ x: 1 }));
  assert.deepEqual(obj, { x: 1 });
});

test('fn rejection rejects run, slot is released for subsequent fns', async () => {
  const sem = createSemaphore(1);
  let afterCount = 0;
  const p1 = sem.run(async () => {
    throw new Error('boom');
  });
  const p2 = sem.run(async () => {
    afterCount += 1;
    return 'ok';
  });
  await assert.rejects(() => p1, /boom/);
  const v = await p2;
  assert.equal(v, 'ok');
  assert.equal(afterCount, 1);
});

test('throws when max is not a positive integer', () => {
  assert.throws(() => createSemaphore(0));
  assert.throws(() => createSemaphore(-1));
  assert.throws(() => createSemaphore(1.5));
  assert.throws(() => createSemaphore('x'));
});
