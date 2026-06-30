import type { ModelExplicitOptInTosVersion } from './types';

/**
 * Default command denylist for organization managed settings.
 * These commands are dangerous and should always require manual approval before execution.
 */
export const DEFAULT_COMMAND_DENYLIST = [
  // Destructive filesystem operations
  'rm -rf /',
  'rm -rf /*',
  'rm -rf .',
  'rm -rf ~',
  'rm -rf ~/*',
  'rm -rf $HOME',
  'rm -r /',
  'rm -r /*',
  'rm -r ~',
  'rm -r ~/*',
  // Filesystem formatting
  'mkfs',
  'mkfs.ext4',
  'mkfs.ext3',
  'mkfs.vfat',
  'mkfs.ntfs',
  // Direct disk operations
  'dd if=/dev/zero of=/dev',
  'dd of=/dev',
  // System control commands
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init 0',
  'init 6',
  // Fork bombs
  ':(){ :|: & };:',
  ':() { :|:& };:',
  // Other dangerous operations
  'chmod -R 777 /',
  'chmod -R 000 /',
  'chown -R',
  // Windows-specific dangerous commands
  'Format-Volume',
  'format.com',
  'powershell Remove-Item -Recurse -Force',
] as const;

/**
 * Default command blocklist (hard denylist) for organization managed settings.
 * Unlike the denylist, blocked commands can NEVER be run and can NEVER be
 * approved by the user. The agent receives an error instructing it not to run
 * or attempt to bypass the command. Empty by default; admins/users opt in.
 */
export const DEFAULT_COMMAND_BLOCKLIST = [] as const;

/**
 * Error message for model policy violations.
 * Used consistently across LLM routes and CLI error handling.
 */
export const MODEL_POLICY_VIOLATION_ERROR =
  "This model is not available due to your organization's security settings.";

/**
 * TOS version stored with explicit model opt-in approvals. An approval only
 * satisfies a model's requirement when its `tosVersion` matches the value the
 * registry declares. Typed as {@link ModelExplicitOptInTosVersion} so bumping
 * the literal in one place forces every declaration to move in lockstep.
 */
export const MODEL_EXPLICIT_OPT_IN_TOS_VERSION: ModelExplicitOptInTosVersion =
  '2026/06/08';

/**
 * Maximum length of the intended-use justification recorded when an admin opts
 * into a data-retention model. Bounded so the audit field cannot be abused to
 * store unbounded free text on the version document.
 */
export const MODEL_EXPLICIT_OPT_IN_INTENDED_USE_MAX_LENGTH = 2000;
