export class ReconnectionStrategy {
  private attempts = 0;

  private readonly maxAttempts: number;

  private readonly baseDelay: number;

  private readonly maxDelay: number;

  private readonly backoffFactor: number;

  private readonly reconnectDelegated: boolean;

  constructor(
    maxAttempts: number,
    baseDelay: number,
    maxDelay: number,
    backoffFactor: number,
    reconnectDelegated = false
  ) {
    this.maxAttempts = maxAttempts;
    this.baseDelay = baseDelay;
    this.maxDelay = maxDelay;
    this.backoffFactor = backoffFactor;
    this.reconnectDelegated = reconnectDelegated;
  }

  isReconnectDelegated(): boolean {
    return this.reconnectDelegated;
  }

  /**
   * Check if reconnection should be attempted.
   * Returns false if max attempts have been reached.
   */
  shouldReconnect(): boolean {
    return this.attempts < this.maxAttempts;
  }

  /**
   * Calculate next reconnection delay with exponential backoff
   */
  getNextDelay(): number {
    // Exponential backoff with jitter
    const exponentialDelay =
      this.baseDelay * this.backoffFactor ** this.attempts;
    const clampedDelay = Math.min(exponentialDelay, this.maxDelay);

    // Add jitter to prevent thundering herd
    const jitter = Math.random() * 0.3 * clampedDelay; // 0-30% jitter

    return Math.floor(clampedDelay + jitter);
  }

  /**
   * Reset reconnection attempts
   */
  reset(): void {
    this.attempts = 0;
  }

  /**
   * Increment reconnection attempts
   */
  incrementAttempts(): void {
    this.attempts++;
  }

  /**
   * Get current attempt count
   */
  getAttempts(): number {
    return this.attempts;
  }

  /**
   * Get maximum attempts allowed
   */
  getMaxAttempts(): number {
    return this.maxAttempts;
  }

  /**
   * Check if max attempts reached
   */
  isMaxAttemptsReached(): boolean {
    return this.attempts >= this.maxAttempts;
  }

  /**
   * Get human-readable status
   */
  getStatus(): string {
    if (this.isMaxAttemptsReached()) {
      return `Max reconnection attempts (${this.maxAttempts}) reached`;
    }
    return `Reconnection attempt ${this.attempts + 1}/${this.maxAttempts}`;
  }
}
