/**
 * Node-only shell utilities
 *
 * This file contains utilities that require Node.js APIs (like child_process)
 * and should NOT be imported in browser/frontend code.
 *
 * @example
 * import { loadShellEnvironment } from '@industry/utils/shell/node';
 */

// eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
export { loadShellEnvironment } from './shellEnv';
// eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
export { findGitRoot } from './git';
// eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
export { expandTilde } from './paths';
