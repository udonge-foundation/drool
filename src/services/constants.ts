import {
  DEFAULT_COMMAND_BLOCKLIST as SHARED_COMMAND_BLOCKLIST,
  DEFAULT_COMMAND_DENYLIST as SHARED_COMMAND_DENYLIST,
} from '@industry/common/policy';

export const GIT_AI_VERSION = '1.2.2';

export const DROOL_GIT_AI_CHECKPOINT_MATCHER =
  '^(Edit|MultiEdit|Write|Create|ApplyPatch)$';

export const DROOL_GIT_AI_CHECKPOINT_HOOK_MARKER =
  'DROOL_GIT_AI_CHECKPOINT_HOOK=1';

// Default allowed commands - minimal safe commands
export const DEFAULT_COMMAND_ALLOWLIST = [
  'ls',
  'pwd',
  'dir',
  'git status',
  'git diff',
  'git log',
  'git show',
  'git blame',
  'git ls-files',
];
// Default denied commands - re-exported from drool-core
export const DEFAULT_COMMAND_DENYLIST = [...SHARED_COMMAND_DENYLIST];

// Default blocked commands (hard denylist) - never run, never approvable
export const DEFAULT_COMMAND_BLOCKLIST = [...SHARED_COMMAND_BLOCKLIST];
