/**
 * Controllable clock for scheduler tests.
 * @param {number} [startMs=0]
 */
export function createFakeClock(startMs = 0) {
  return {
    nowMs: startMs,
    now() {
      return new Date(this.nowMs);
    },
    advance(ms) {
      this.nowMs += ms;
    }
  };
}
