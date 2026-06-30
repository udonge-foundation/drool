import { z } from 'zod';

import {
  AutomationCreateToolInputSchema,
  AutomationDeleteToolInputSchema,
  AutomationEditToolInputSchema,
  AutomationListToolInputSchema,
  AutomationReadToolInputSchema,
  CronCreateToolInputSchema,
  CronDeleteToolInputSchema,
  CronListToolInputSchema,
} from '@industry/drool-sdk-ext/protocol/drool';
import { RiskLevel } from '@industry/drool-sdk-ext/protocol/tools';

export const readCliSchema = z.object({
  file_path: z
    .string()
    .describe(
      'The absolute path to the file to read (must be absolute, not relative)'
    ),
  offset: z
    .number()
    .optional()
    .default(0)
    .describe('The line number to start reading from (0-based, defaults to 0)'),
  limit: z
    .number()
    .optional()
    .default(2400)
    .describe('The maximum number of lines to read (defaults to 2400)'),
  image_quality: z
    .enum(['default', 'high'])
    .optional()
    .default('default')
    .describe(
      'Image compression quality. "default" uses standard compression (~200KB), "high" uses higher fidelity (~1MB). Only applicable when reading image files.'
    ),
});

export type ReadCliParams = z.infer<typeof readCliSchema>;
export type CronCreateParams = z.infer<typeof CronCreateToolInputSchema>;
export type CronListParams = z.infer<typeof CronListToolInputSchema>;
export type CronDeleteParams = z.infer<typeof CronDeleteToolInputSchema>;
export type AutomationCreateParams = z.infer<
  typeof AutomationCreateToolInputSchema
>;
export type AutomationListParams = z.infer<
  typeof AutomationListToolInputSchema
>;
export type AutomationReadParams = z.infer<
  typeof AutomationReadToolInputSchema
>;
export type AutomationEditParams = z.infer<
  typeof AutomationEditToolInputSchema
>;
export type AutomationDeleteParams = z.infer<
  typeof AutomationDeleteToolInputSchema
>;

const editChangeSchema = z.object({
  old_str: z.string().describe('The exact text to find and replace'),
  new_str: z.string().describe('The text to replace the old_str with'),
  change_all: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Whether to replace all occurrences (true) or just the first one (false). Defaults to false.'
    ),
});
const _multiEditCliSchema = z.object({
  file_path: z.string().describe('The path to the file to edit'),
  changes: z
    .array(editChangeSchema)
    .min(1)
    .describe('Array of changes to apply to the file'),
});

export type MultiEditCliParams = z.infer<typeof _multiEditCliSchema>;
export type EditChange = z.infer<typeof editChangeSchema>;
export const lsCliSchema = z.object({
  directory_path: z
    .string()
    .optional()
    .describe(
      'The absolute path to the directory to list (must be absolute, not relative). Defaults to current working directory if not provided.'
    ),
  ignorePatterns: z
    .array(z.string())
    .optional()
    .describe(
      'Array of glob patterns to ignore when listing files and directories. Example: ["node_modules/**", "*.log", ".git/**"]'
    ),
});

export type LsCliParams = z.infer<typeof lsCliSchema>;
export const grepSearchCliToolSchema = z.object({
  pattern: z
    .string()
    .describe(
      'A search pattern to match in file contents. Can be a literal string or a regular expression. Supports ripgrep regex syntax.'
    ),
  path: z
    .string()
    .optional()
    .describe(
      'Absolute path to a file or directory to search in. If not specified, searches in the current working directory.'
    ),
  glob_pattern: z
    .string()
    .optional()
    .describe(
      'Glob pattern to filter files. Example: "*.js" for JavaScript files, "**/*.tsx" for React components. Maps to ripgrep --glob parameter.'
    ),
  output_mode: z
    .enum(['file_paths', 'content'])
    .optional()
    .default('file_paths')
    .describe(
      'Output format: "file_paths" returns only matching file paths, "content" returns matching lines with context. Content mode supports -A/-B/-C context, -n line numbers, head_limit.'
    ),
  case_insensitive: z
    .boolean()
    .optional()
    .default(false)
    .describe('Perform case-insensitive matching (ripgrep -i flag).'),
  type: z
    .string()
    .optional()
    .describe(
      'Ripgrep file type filter for common file types (ripgrep --type flag). Examples: "js" for JavaScript, "py" for Python, "rust" for Rust, "cpp" for C++.'
    ),
  context_before: z
    .number()
    .optional()
    .describe(
      'Number of lines to show before each match (ripgrep -B flag). Only works with output_mode="content".'
    ),
  context_after: z
    .number()
    .optional()
    .describe(
      'Number of lines to show after each match (ripgrep -A flag). Only works with output_mode="content".'
    ),
  context: z
    .number()
    .optional()
    .describe(
      'Number of lines to show before and after each match (ripgrep -C flag). Only works with output_mode="content".'
    ),
  line_numbers: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Show line numbers in output (ripgrep -n flag). Only works with output_mode="content".'
    ),
  head_limit: z
    .number()
    .optional()
    .describe(
      'Limit output to first N lines/entries. Works with both output modes.'
    ),
  multiline: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Enable multiline mode where . matches newlines and patterns can span lines (ripgrep -U --multiline-dotall).'
    ),
  fixed_string: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Treat the pattern as a literal string instead of a regular expression (ripgrep -F flag). Useful for searching special characters like ?, *, etc.'
    ),
});

export type GrepSearchCliParams = z.infer<typeof grepSearchCliToolSchema>;
const executeCliSchema = z.object({
  summary: z
    .string()
    .trim()
    .regex(
      /^[A-Z]\S*(?:\s+\S+){2,7}$/,
      'summary must be Sentence cased and 3-8 words long'
    )
    .describe(
      `REQUIRED: A Sentence cased summary of what the command is about, 3-8 words long.

Examples:
- "Print out numbers 1-100"
- "Run the dev server"
- "Remove legacy folders"
- "Clean up lint statements in recent files"`
    ),
  command: z.string().describe('The command to execute'),
  timeout: z
    .number()
    .optional()
    .default(60)
    .describe('Timeout in seconds (default: 60)'),
  riskLevelReason: z
    .string()
    .default('High risk command')
    .describe(
      `REQUIRED: First, provide a concise one-sentence explanation justifying the risk level of this command.

Your reason should explain WHY the command has a specific risk level, focusing on:
- What the command modifies or accesses
- Whether changes are reversible
- The scope of potential impact (local vs system-wide vs remote)
- Whether it executes untrusted code or uses elevated privileges

Examples of good reasons for LOW risk commands:
- "This pwd command only reads the current directory without modifying any files."
- "The git status command only displays repository information without making changes."
- "This cat command only reads file contents without making any modifications."

Examples of good reasons for MEDIUM risk commands:
- "This npm install command will modify node_modules but is limited to the project directory."
- "The git commit changes the working tree but can be reversed with subsequent git commands."
- "This mkdir command creates a new directory but doesn't affect existing files."

Examples of good reasons for HIGH risk commands:
- "This sudo rm -rf command can permanently delete files with elevated privileges."
- "The curl | bash pattern executes untrusted code directly from the internet."
- "This git push command modifies the remote repository, which could affect other developers and CI/CD pipelines."
- "This git push --force command can overwrite remote repository history."`
    ),
  riskLevel: z
    .nativeEnum(RiskLevel)
    .default(RiskLevel.HIGH)
    .describe(
      `REQUIRED: Based on your reasoning above, choose the appropriate risk level for this command. Choose from the following guidelines:

# LOW RISK
Commands that are strictly read-only operations with no side effects and very unlikely to have severe or irreversible consequences.
Examples:
- Display commands: echo, pwd
- Information gathering: whoami, date, uname, ps, top
- Reading files or logs: cat, less, head, tail, systemctl status
- Git read operations: git status, git log, git diff
- Directory listing: ls, find (without -delete or -exec)

Note: Commands that create, modify, or delete files should be classified as MEDIUM or HIGH risk, not LOW risk.

Examples for low risk commands:
- riskLevelReason: "This pwd command only reads the current directory without modifying any files.", riskLevel: "low"
- riskLevelReason: "The git status command only displays repository information without making changes.", riskLevel: "low"
- riskLevelReason: "This cat command only reads file contents without making any modifications.", riskLevel: "low"

# MEDIUM RISK
Commands that may have significant side effects, but these side effects are typically harmless and straightforward to recover from.
Examples:
- File creation/modification in non-system directories: touch, mkdir, mv, cp
- Installing packages from trusted sources: npm install, pip install (without sudo)
- Network requests to trusted endpoints: curl, wget to known APIs
- Git operations that modify local repositories but preserve uncommitted work: git commit, git pull, and git checkout / git switch / git restore ONLY when they will NOT overwrite or delete uncommitted or untracked changes — e.g. git checkout -b <new-branch>, or switching/restoring after you have confirmed the working tree is clean (but not git push, and see HIGH RISK for the destructive cases)
- Building code with tools like make, npm run build, mvn compile

Examples for medium risk commands:
- riskLevelReason: "This npm install command will modify node_modules but is limited to the project directory.", riskLevel: "medium"
- riskLevelReason: "The git commit changes the working tree but can be reversed with subsequent git commands.", riskLevel: "medium"
- riskLevelReason: "This git checkout -b creates a new branch and does not overwrite any uncommitted or untracked changes.", riskLevel: "medium"

# HIGH RISK
Commands that may have security implications such as data transfers between untrusted sources or execution of unknown code, or major side effects such as irreversible data loss or modifications of production systems/deployments.
Examples:
- Any command with sudo or elevated privileges that can modify system files or configurations
- Commands that delete many files or directories: rm -rf, find ... -delete
- Commands that may delete, overwrite, move, or clean untracked files
- Commands that discard or overwrite uncommitted or untracked changes: git checkout / git switch / git restore over dirty paths or branches, git reset --hard, git stash drop/clear. Unless you have confirmed the working tree is clean (e.g. via a preceding git status), treat these as HIGH RISK — they irreversibly destroy unstaged/unstashed edits, including when chained with other commands
- Cleanup commands such as git clean, broad rm -rf globs, and find ... -delete
- Running arbitrary/untrusted code: curl | bash, eval, executing downloaded scripts
- Exposing ports or modifying firewall rules that could allow external access
- Git push operations that modify remote repositories: git push, git push --force
- Irreversible actions to production deployments, database migrations, or other sensitive operations
- Commands that access or modify sensitive information like passwords or keys

Examples for high risk commands:
- riskLevelReason: "This sudo rm -rf command can permanently delete files with elevated privileges.", riskLevel: "high"
- riskLevelReason: "The curl | bash pattern executes untrusted code directly from the internet.", riskLevel: "high"
- riskLevelReason: "This git checkout switches branches while the working tree has uncommitted changes, which could irreversibly overwrite unstaged edits.", riskLevel: "high"
- riskLevelReason: "This rm -rf targets a workspace directory and would permanently delete its contents, including any untracked or uncommitted work.", riskLevel: "high"
- riskLevelReason: "This git push command modifies the remote repository, which could affect other developers and CI/CD pipelines.", riskLevel: "high"
- riskLevelReason: "This git push --force command can overwrite remote repository history.", riskLevel: "high"`
    ),
});

export type ExecuteCliParams = z.infer<typeof executeCliSchema>;

export const executeCliWithBackgroundSchema = executeCliSchema.extend({
  fireAndForget: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Run command in background without waiting for completion. After start, note the printed PID and temp log path, run `sleep <seconds>` and Read that file to inspect output, and stop the process later with `kill <pid>`.'
    ),
});

export type ExecuteCliWithBackgroundParams = z.infer<
  typeof executeCliWithBackgroundSchema
>;

export const editCliSchema = z.object({
  file_path: z.string().describe('The path to the file to edit'),
  old_str: z
    .string()
    .describe('The exact text to find and replace in the file'),
  new_str: z.string().describe('The text to replace the old_str with'),
  change_all: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Whether to replace all occurrences (true) or just the first one (false). Defaults to false.'
    ),
});

export type EditCliParams = z.infer<typeof editCliSchema>;
export const createCliSchema = z.object({
  file_path: z.string().describe('The path to the file for the new file.'),
  content: z.string().describe('The content to write to the file'),
});

export type CreateCliParams = z.infer<typeof createCliSchema>;

// ---------------------------------------------------------------------------
// Apply Patch (CLI) schema
// ---------------------------------------------------------------------------

export const applyPatchCliSchema = z.object({
  input: z
    .string()
    .describe('The apply_patch command that you wish to execute.'),
});

export type ApplyPatchCliParams = z.infer<typeof applyPatchCliSchema>;

// ---------------------------------------------------------------------------
// AskUser schema
// ---------------------------------------------------------------------------

export const askUserSchema = z.object({
  questionnaire: z
    .string()
    .describe(
      `A plain-text questionnaire to ask the user. Use this format (no headers or code fences):\n\n` +
        `1. [question] Which features do you want to enable?\n` +
        `[topic] Features\n` +
        `[option] Auth handling\n` +
        `[option] Login Page\n\n` +
        `2. [question] Which library should we use for date formatting?\n` +
        `[topic] Library\n` +
        `[option] Library ABC\n` +
        `[option] Library BlaBla\n\n` +
        `Notes:\n` +
        `- 1–4 questions\n` +
        `- 2–4 options per question\n` +
        `- [topic] is a short label for the UI navigation bar; multi-word topics will be normalized (e.g., "My Topic" → "My-Topic")\n` +
        `- Do NOT include an 'Own answer' option; the UI provides it automatically\n` +
        `- Keep option labels short and mutually exclusive\n`
    ),
});

export type AskUserToolInput = z.infer<typeof askUserSchema>;

export const toolSearchSchema = z.object({
  query: z
    .string()
    .describe(
      'Query to load deferred tool schemas. Format: "select:<name>[,<name>...]". Names must exactly match entries in the "Deferred tools:" system reminder.'
    ),
});

export type ToolSearchParams = z.infer<typeof toolSearchSchema>;

export const sessionModelUpgradeCliSchema = z
  .object({})
  .describe('No input parameters.');

export type SessionModelUpgradeCliParams = z.infer<
  typeof sessionModelUpgradeCliSchema
>;

export const sessionModelUpgradeOutputSchema = z
  .string()
  .describe('A status message describing the session model change result.');
