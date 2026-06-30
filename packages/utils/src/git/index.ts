/**
 * Node-only git utilities. Do NOT import from browser/frontend code.
 */

export { WorktreeSetupError } from './errors';
export { setupWorktree } from './worktreeSetup';
export { cleanupWorktree } from './worktreeCleanup';
export {
  branchExists,
  createWorktreeForBranch,
  createWorktreeWithNewBranch,
  getMainRepoRoot,
  getWorktreePath,
  hasUncommittedChanges,
  isInWorktree,
  listWorktrees,
  removeWorktree,
  resolveRepoRoot,
} from './worktree';
export type {
  CleanupWorktreeOptions,
  CreateWorktreeResult,
  WorktreeInfo,
  WorktreeSessionInfo,
  WorktreeSetupOptions,
} from './types';
