/**
 * @param {{ now?: () => Date }} [overrides]
 */
export function createSystemClock(overrides = {}) {
  return {
    now() {
      return overrides.now ? overrides.now() : new Date();
    }
  };
}
