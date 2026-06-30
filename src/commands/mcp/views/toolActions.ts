import { ToolAction } from '@/commands/mcp/views/enums';
import type { ToolActionItem } from '@/commands/mcp/views/types';
import { getI18n } from '@/i18n';

export function buildToolActions(isDisabled: boolean): ToolActionItem[] {
  const t = getI18n().t;
  return [
    {
      label: isDisabled
        ? `1. ${t('common:mcpViews.toolActions.enableTool')}`
        : `1. ${t('common:mcpViews.toolActions.disableTool')}`,
      action: isDisabled ? ToolAction.Enable : ToolAction.Disable,
    },
    {
      label: `2. ${t('common:mcpViews.toolActions.back')}`,
      action: ToolAction.Back,
    },
  ];
}
