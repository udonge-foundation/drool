/**
 * Shared shell command parsing and analysis utilities
 *
 * Re-exports utilities from separate files for easier discovery
 *
 * NOTE: This file only exports browser-safe utilities.
 * For Node-only utilities (like loadShellEnvironment), use '@industry/utils/shell/node'
 */

export { stripShellWrapper } from './commandParsing';
export {
  extractNormalizedCommands,
  normalizeCommandExecutables,
} from './commandExtraction';
export { extractExecutableInvocations } from './extractExecutableInvocations';
export { expandTilde } from './paths';
