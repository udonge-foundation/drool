import type { DisplayMessage, HookExecutionData } from './types';

export function isHookExecutionData(
  item: DisplayMessage
): item is HookExecutionData {
  return 'hookId' in item;
}
