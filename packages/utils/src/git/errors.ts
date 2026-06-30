/**
 * Error thrown during worktree setup. The message is user-facing.
 */
export class WorktreeSetupError extends Error {
  constructor(
    message: string,
    public readonly metadata?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'WorktreeSetupError';
  }
}
