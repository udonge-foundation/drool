import {
  SYSTEM_REMINDER_END,
  SYSTEM_REMINDER_START,
} from '@industry/drool-sdk-ext/protocol/drool';
import { logWarn } from '@industry/logging';
import { buildAutomationScaffoldLocationReminder } from '@industry/utils/automations';

import { sanitizeUntrustedReminderBlob } from '../server/handlers/reminderSanitization';
import { validateWorkingDirectory } from '../utils/validate-working-directory';

import type { AutomationRunContext } from './types';
import type { ValidAutomationDescriptor } from '@industry/common/automations';

async function resolveAutomationRunCwd(
  automation: Pick<ValidAutomationDescriptor, 'path' | 'config'>
): Promise<string> {
  const configured = automation.config.workingDirectory?.trim();
  if (!configured) {
    return automation.path;
  }
  const validation = await validateWorkingDirectory(configured);
  if (validation.isValid && validation.resolvedPath) {
    return validation.resolvedPath;
  }
  logWarn(
    '[Automation] Configured workingDirectory invalid; using scaffold dir',
    {
      value: automation.config.name,
      cause: validation.error,
    }
  );
  return automation.path;
}

/**
 * Wrap the scaffold-location reminder in a system-reminder block, or return
 * an empty string when the run cwd already equals the scaffold directory
 * (the common case, where scaffold-relative paths resolve correctly without
 * remapping).
 */
function buildScaffoldReminderBlock(
  automationPath: string,
  cwd: string
): string {
  const reminder = buildAutomationScaffoldLocationReminder({
    automationPath,
    cwd,
  });
  // `cwd`/`automationPath` are user-controlled/filesystem-derived, so a
  // crafted path could otherwise embed a `</system-reminder>` token and
  // terminate the wrapper to inject directives into a headless run.
  return reminder
    ? `${SYSTEM_REMINDER_START}\n${sanitizeUntrustedReminderBlob(reminder)}\n${SYSTEM_REMINDER_END}\n`
    : '';
}

/**
 * Resolve where an automation run session executes and the scaffold-location
 * reminder that must accompany it. The cwd defaults to the automation's own
 * scaffold directory (`automation.path`); when the automation configures an
 * explicit `workingDirectory`, that path is expanded, normalized, and
 * validated, and the run uses it as cwd (so the agent can discover project
 * skills, access the repo, and resolve task-relative paths) while scaffold
 * bookkeeping (HEARTBEAT.md, VISUAL.html, memory/, reports/) stays anchored
 * to `automation.path`. An invalid configured path logs a warning and falls
 * back to the scaffold directory so a misconfiguration never blocks a run.
 *
 * Shared by every automation run path (scheduled dispatch, local manual run,
 * computer/hosted run).
 */
export async function resolveAutomationRunContext(
  automation: Pick<ValidAutomationDescriptor, 'path' | 'config'>
): Promise<AutomationRunContext> {
  const cwd = await resolveAutomationRunCwd(automation);
  return {
    cwd,
    scaffoldReminder: buildScaffoldReminderBlock(automation.path, cwd),
  };
}
