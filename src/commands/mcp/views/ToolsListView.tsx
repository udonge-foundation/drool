import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { McpMenuList } from '@/commands/mcp/views/McpMenuList';
import type { ToolInfo } from '@/commands/mcp/views/types';
import { convertMcpToolInfoToToolInfo } from '@/commands/mcp/views/utils';
import { COLORS } from '@/components/chat/themedColors';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';

import type { McpToolInfo } from '@industry/drool-sdk-ext/protocol/drool';

interface ToolsListViewProps {
  serverName: string;
  tools: McpToolInfo[];
  selectedIndex: number;
  setSelectedIndex: (index: number | ((prev: number) => number)) => void;
}

export function ToolsListView({
  serverName,
  tools: mcpTools,
  selectedIndex,
  setSelectedIndex,
}: ToolsListViewProps) {
  const { t } = useTranslation('common');
  const tools: ToolInfo[] = mcpTools.map(convertMcpToolInfoToToolInfo);
  const enabledCount = tools.filter(
    (tool, idx) => mcpTools[idx].isEnabled
  ).length;

  // Handle navigation
  useKeypressHandler((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(tools.length - 1, prev + 1));
    }
  });

  if (tools.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>
          {t('mcpViews.toolsList.titleEmpty', { name: serverName })}
        </Text>
        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('mcpViews.toolsList.noToolsAvailable')}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('mcpViews.toolsList.pressEscBack')}
          </Text>
        </Box>
      </Box>
    );
  }

  const items = tools.map((tool, idx) => {
    const isToolDisabled = !mcpTools[idx].isEnabled;
    const badges = [
      tool.isReadOnly ? t('mcpViews.toolsList.readOnlyBadge') : '',
      isToolDisabled ? t('mcpViews.toolsList.disabledBadge') : '',
    ]
      .filter(Boolean)
      .join(' ');

    return {
      key: `tool-${tool.name}`,
      label: tool.name,
      value: tool.name,
      suffix: badges ? ` ${badges}` : undefined,
      dimmed: isToolDisabled,
    };
  });

  return (
    <McpMenuList
      title={t('mcpViews.toolsList.titleWithCount', {
        name: serverName,
        enabled: enabledCount,
        total: tools.length,
      })}
      items={items}
      selectedIndex={selectedIndex}
      helpText={t('mcpViews.toolsList.hint')}
    />
  );
}
