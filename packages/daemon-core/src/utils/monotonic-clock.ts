/**
 * A monotonically non-decreasing timestamp latch.
 *
 * Holds the most recent timestamp it has been given. Updating with an older
 * timestamp than the current value is a no-op, so the value only ever moves
 * forward. The initial value is 0, representing "never updated".
 *
 * Used to track the last activity time of a single source (relay connection,
 * WebSocket server, IPC channel). JS runs on a single thread, so the
 * `Math.max` guard is what makes concurrent/out-of-order `update` calls safe
 *
 * Note: the stored value is monotonic, but the default source is the wall
 * clock (`Date.now()`), so it is not immune to system clock adjustments.
 */
export class MonotonicClock {
  private latestMs = 0;

  /**
   * Advances the clock to the given timestamp (defaults to now). Timestamps
   * older than the current value are ignored to keep the value monotonic.
   */
  update(timestampMs: number = Date.now()): void {
    this.latestMs = Math.max(this.latestMs, timestampMs);
  }

  /**
   * Returns the latest recorded timestamp (ms), or 0 if never updated.
   */
  now(): number {
    return this.latestMs;
  }
}
