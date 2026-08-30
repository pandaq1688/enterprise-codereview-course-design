/**
 * Test-only semaphore.
 *
 * @param {number} max
 */
export function createSemaphore(max) {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error('semaphore max 必须 >=1');
  }
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    const task = queue.shift();
    active += 1;
    Promise.resolve()
      .then(() => task.run())
      .then(
        (v) => {
          active -= 1;
          task.resolve(v);
          next();
        },
        (e) => {
          active -= 1;
          task.reject(e);
          next();
        }
      );
  };
  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ run: fn, resolve, reject });
        next();
      });
    }
  };
}
