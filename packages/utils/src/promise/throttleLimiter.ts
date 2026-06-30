import { MetaError } from '@industry/logging/errors';

/**
 * Throttle limiter using the token bucket algorithm.
 *
 * Controls the rate at which async work is dispatched by requiring callers
 * to acquire a permit before proceeding. Permits refill at a fixed rate up
 * to a maximum capacity, preventing bursts that exceed external API limits.
 *
 * `timeoutMs` is required so callers explicitly choose a deadline that fits
 * their execution context (e.g. cron maxDuration). If a single `acquire()`
 * call cannot obtain a permit within the deadline, it throws.
 *
 * Usage:
 *   const throttle = new ThrottleLimiter({ rate: 10, timeoutMs: 720_000 });
 *   await throttle.acquire();   // waits until a permit is available
 *   await callExternalApi();
 */
export class ThrottleLimiter {
  private permits: number;

  private lastRefill: number;

  private readonly rate: number;

  private readonly capacity: number;

  private readonly timeoutMs: number;

  constructor(opts: {
    rate: number;
    timeoutMs: number;
    maxCapacity?: number;
    initialCapacity?: number;
  }) {
    this.rate = opts.rate;
    this.capacity = opts.maxCapacity ?? opts.rate;
    this.permits = opts.initialCapacity ?? this.capacity;
    this.lastRefill = Date.now();
    this.timeoutMs = opts.timeoutMs;
  }

  async acquire(): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    while (true) {
      this.refill();
      if (this.permits >= 1) {
        this.permits -= 1;
        return;
      }
      const waitMs = ((1 - this.permits) / this.rate) * 1000;
      if (Date.now() + waitMs > deadline) {
        throw new MetaError('ThrottleLimiter: timed out waiting for permit', {
          timeout: this.timeoutMs,
        });
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, waitMs);
      });
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.permits = Math.min(
      this.capacity,
      this.permits + (elapsed * this.rate) / 1000
    );
    this.lastRefill = now;
  }
}
