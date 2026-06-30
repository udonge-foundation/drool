import {
  AUTOMATION_HEARTBEAT_FILE,
  AUTOMATION_MEMORY_DIR,
  AUTOMATION_REPORTS_DIR,
  AUTOMATION_VISUAL_FILE,
} from '@industry/common/automations';

/**
 * Normalize a directory path for prompt text and equality comparison:
 * collapse `\` to `/`, collapse repeated separators, and strip any trailing
 * separator. The result is only ever used inside prompt text or to decide
 * whether cwd and the scaffold dir are the same, so platform-consistent
 * forward slashes are preferable to the host separator.
 */
function normalizeSeparators(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}

/**
 * Join an automation scaffold directory with a child path using forward
 * slashes.
 */
function joinScaffold(automationPath: string, child: string): string {
  return `${normalizeSeparators(automationPath)}/${child}`;
}

/**
 * Build a system-reminder block that decouples the automation's run working
 * directory from its scaffold directory.
 *
 * Automation prompts (both the generated run instructions and the
 * user-authored HEARTBEAT body) reference scaffold files with cwd-relative
 * paths like `./memory/state.json` and `./VISUAL.html`. Those paths only
 * resolve correctly when the session cwd is the automation directory. When the
 * user configures a separate working directory (so the run can access project
 * skills, the repo, and relative folders), this reminder tells the agent to
 * keep treating those scaffold references as living under the absolute
 * automation directory while doing its actual work from `cwd`.
 *
 * Returns an empty string when cwd equals the scaffold directory, so callers
 * can unconditionally prepend it without changing default behavior.
 */
export function buildAutomationScaffoldLocationReminder(params: {
  automationPath: string;
  cwd: string;
}): string {
  const { automationPath, cwd } = params;
  if (normalizeSeparators(automationPath) === normalizeSeparators(cwd)) {
    return '';
  }
  return [
    'AUTOMATION WORKING DIRECTORY:',
    `- Your current working directory (cwd) is \`${cwd}\`. Use it for the actual task: discovering project skills, reading/writing repo files, and resolving any task-relative paths.`,
    `- This automation's scaffold lives at \`${automationPath}\` (the "automation directory"). It is OUTSIDE your cwd.`,
    `- Every reference below to \`./${AUTOMATION_HEARTBEAT_FILE}\`, \`./${AUTOMATION_VISUAL_FILE}\`, \`./${AUTOMATION_MEMORY_DIR}/\` (e.g. \`./${AUTOMATION_MEMORY_DIR}/state.json\`), and \`./${AUTOMATION_REPORTS_DIR}/\` refers to that path under the automation directory, NOT your cwd. Always read and write those scaffold files using their absolute paths:`,
    `  - ${joinScaffold(automationPath, AUTOMATION_HEARTBEAT_FILE)}`,
    `  - ${joinScaffold(automationPath, AUTOMATION_VISUAL_FILE)}`,
    `  - ${joinScaffold(automationPath, `${AUTOMATION_MEMORY_DIR}/state.json`)}`,
    `  - ${joinScaffold(automationPath, `${AUTOMATION_REPORTS_DIR}/`)}`,
    '- Do NOT create the scaffold files relative to your cwd.',
  ].join('\n');
}
