import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { McpMenuList } from '@/commands/mcp/views/McpMenuList';
import type { ServerToolsGroup } from '@/commands/mcp/views/types';
import { COLORS } from '@/components/chat/themedColors';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';

import type { McpToolInfo } from '@industry/drool-sdk-ext/protocol/drool';

interface ToolsOverviewViewProps {
  tools: McpToolInfo[];
  selectedIndex: number;
  setSelectedIndex: (index: number | ((prev: number) => number)) => void;
  onToggleTool: (serverName: string, toolName: string) => void;
  onToggleServer: (serverName: string) => void;
  onToggleAll: () => void;
  onViewToolDetail?: (serverName: string, toolName: string) => void;
}

interface FlattenedTool {
  type: 'tool';
  serverName: string;
  toolName: string;
  description?: string;
  isEnabled: boolean;
  isReadOnly: boolean;
}

interface ServerHeader {
  type: 'serverHeader';
  serverName: string;
  enabledCount: number;
  totalCount: number;
}

type ListItem = FlattenedTool | ServerHeader;

export function ToolsOverviewView({
  tools: allTools,
  selectedIndex,
  setSelectedIndex,
  onToggleTool,
  onToggleServer,
  onToggleAll,
  onViewToolDetail,
}: ToolsOverviewViewProps) {
  const { t } = useTranslation('common');
  // Build grouped data structure from flat McpToolInfo list
  const serverGroups: ServerToolsGroup[] = useMemo(() => {
    const grouped = new Map<string, McpToolInfo[]>();
    for (const tool of allTools) {
      const list = grouped.get(tool.serverName) ?? [];
      list.push(tool);
      grouped.set(tool.serverName, list);
    }

    return Array.from(grouped.entries())
      .map(([serverName, serverTools]) => {
        const toolItems = serverTools.map((tool) => ({
          serverName,
          toolName: tool.name,
          description: tool.description,
          isEnabled: tool.isEnabled,
          isReadOnly: tool.isReadOnly === true,
        }));

        return {
          serverName,
          tools: toolItems,
          enabledCount: toolItems.filter((item) => item.isEnabled).length,
          totalCount: serverTools.length,
        };
      })
      .sort((a, b) => a.serverName.localeCompare(b.serverName));
  }, [allTools]);

  // Flatten into a list for navigation (server headers + tools)
  const flatList: ListItem[] = useMemo(() => {
    const items: ListItem[] = [];
    for (const group of serverGroups) {
      items.push({
        type: 'serverHeader',
        serverName: group.serverName,
        enabledCount: group.enabledCount,
        totalCount: group.totalCount,
      });
      for (const tool of group.tools) {
        items.push({
          type: 'tool',
          ...tool,
        });
      }
    }
    return items;
  }, [serverGroups]);

  // Calculate totals
  const totalTools = serverGroups.reduce((sum, g) => sum + g.totalCount, 0);
  const totalEnabled = serverGroups.reduce((sum, g) => sum + g.enabledCount, 0);
  const allEnabled = totalEnabled === totalTools;

  // Handle keyboard input
  useKeypressHandler((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(flatList.length - 1, prev + 1));
    } else if (input === ' ') {
      // Space: toggle current item
      const item = flatList[selectedIndex];
      if (item?.type === 'tool') {
        onToggleTool(item.serverName, item.toolName);
      } else if (item?.type === 'serverHeader') {
        onToggleServer(item.serverName);
      }
    } else if (input === 'a' || input === 'A') {
      // A: toggle all
      onToggleAll();
    } else if (input === 's' || input === 'S') {
      // S: toggle current server (find which server the selection is in)
      const item = flatList[selectedIndex];
      if (item) {
        const serverName =
          item.type === 'serverHeader' ? item.serverName : item.serverName;
        onToggleServer(serverName);
      }
    } else if (key.return && onViewToolDetail) {
      // Enter: view tool details (only for tools, not server headers)
      const item = flatList[selectedIndex];
      if (item?.type === 'tool') {
        onViewToolDetail(item.serverName, item.toolName);
      }
    }
  });

  if (totalTools === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{t('mcpViews.toolsOverview.titleEmpty')}</Text>
        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('mcpViews.toolsOverview.noToolsAvailable')}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('mcpViews.toolsOverview.pressEscBack')}
          </Text>
        </Box>
      </Box>
    );
  }

  const items = flatList.map((item) => {
    if (item.type === 'serverHeader') {
      return {
        key: `header-${item.serverName}`,
        label: `${item.serverName} (${t(
          'mcpViews.toolsOverview.enabledSuffix',
          {
            enabled: item.enabledCount,
            total: item.totalCount,
          }
        )}`,
      };
    }

    const badges = item.isReadOnly
      ? t('mcpViews.toolsOverview.readOnlyBadge')
      : '';

    return {
      key: `tool-${item.serverName}-${item.toolName}`,
      label: `[${item.isEnabled ? '✓' : ' '}] ${item.toolName}`,
      suffix: badges,
      dimmed: !item.isEnabled,
    };
  });

  return (
    <McpMenuList
      title={t('mcpViews.toolsOverview.titleWithCount', {
        enabled: totalEnabled,
        total: totalTools,
      })}
      items={items}
      selectedIndex={selectedIndex}
      helpText={t('mcpViews.toolsOverview.hint')}
      visibleCount={12}
    >
      <Box marginBottom={1}>
        <Text color={COLORS.text.secondary}>
          [{allEnabled ? '✓' : ' '}] {t('mcpViews.toolsOverview.selectAll')}
        </Text>
      </Box>
    </McpMenuList>
  );
}
