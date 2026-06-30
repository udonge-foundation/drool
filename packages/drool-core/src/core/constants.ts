/**
 * Possible file names for coding guidelines/agent instructions.
 * These files are searched in order of preference.
 */
export const AGENTS_MD_FILE_NAMES = [
  'CLAUDE.md',
  'Claude.md',
  'AGENTS.md',
  'Agents.md',
  'agents.md',
] as const;

/**
 * Possible file names for design guidelines.
 * These files are searched in order of preference.
 */
export const DESIGN_MD_FILE_NAMES = [
  'DESIGN.md',
  'Design.md',
  'design.md',
] as const;
