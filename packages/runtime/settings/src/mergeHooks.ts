import type { HookSettings } from '@industry/common/settings';

export function mergeHooks(
  higher: HookSettings | undefined,
  lower: HookSettings | undefined
): HookSettings | undefined {
  if (!higher && !lower) return undefined;
  if (!higher) return lower;
  if (!lower) return higher;

  const result: HookSettings = { ...higher };

  const hookConfigTypes = [
    'PreToolUse',
    'PostToolUse',
    'Notification',
    'UserPromptSubmit',
    'Stop',
    'SubagentStop',
    'PreCompact',
    'SessionStart',
    'SessionEnd',
  ] as const;

  for (const hookType of hookConfigTypes) {
    const higherConfigs = higher[hookType];
    const lowerConfigs = lower[hookType];

    if (!lowerConfigs || lowerConfigs.length === 0) continue;

    if (!higherConfigs || higherConfigs.length === 0) {
      result[hookType] = lowerConfigs;
      continue;
    }

    result[hookType] = [...higherConfigs, ...lowerConfigs];
  }

  if (result.hooksDisabled === undefined && lower.hooksDisabled !== undefined) {
    result.hooksDisabled = lower.hooksDisabled;
  }
  if (
    result.showHookOutput === undefined &&
    lower.showHookOutput !== undefined
  ) {
    result.showHookOutput = lower.showHookOutput;
  }

  return result;
}
