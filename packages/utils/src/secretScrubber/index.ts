export { scrubbed } from './helpers';
export { scrubSecrets } from './scrubSecrets';
export type {
  SecretFinding,
  PreExecContext,
  CommandHook,
  GitExecutorParams,
  GitExecutor,
  SecretScanOptions,
} from './types';
export {
  parseGitleaksAllowlistPathPatterns,
  scanGitCommandForSecrets,
} from './gitDiffScanner';
