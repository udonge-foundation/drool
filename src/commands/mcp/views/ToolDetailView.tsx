import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { McpMenuList } from '@/commands/mcp/views/McpMenuList';
import { buildToolActions } from '@/commands/mcp/views/toolActions';
import type { ToolActionItem, ToolInfo } from '@/commands/mcp/views/types';
import { convertMcpToolInfoToToolInfo } from '@/commands/mcp/views/utils';
import { COLORS } from '@/components/chat/themedColors';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';

import type { McpToolInfo } from '@industry/drool-sdk-ext/protocol/drool';

interface ToolDetailViewProps {
  serverName: string;
  tool: McpToolInfo | null;
  selectedIndex: number;
  setSelectedIndex: (index: number | ((prev: number) => number)) => void;
}

export function ToolDetailView({
  serverName,
  tool: mcpTool,
  selectedIndex,
  setSelectedIndex,
}: ToolDetailViewProps) {
  const { t } = useTranslation('common');
  const isDisabled = mcpTool ? !mcpTool.isEnabled : false;
  const tool: ToolInfo | null = mcpTool
    ? convertMcpToolInfoToToolInfo(mcpTool)
    : null;

  const actions: ToolActionItem[] = tool ? buildToolActions(isDisabled) : [];

  const items = actions.map((action) => ({
    key: `action-${action.action}`,
    label: action.label,
    value: action.action.toString(),
  }));

  useKeypressHandler((_input, key) => {
    if (!tool) return;

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(items.length - 1, prev + 1));
    }
  });

  if (!tool) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={COLORS.error}>{t('mcpViews.toolDetail.notFound')}</Text>
        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('mcpViews.toolDetail.pressEscBack')}
          </Text>
        </Box>
      </Box>
    );
  }

  const parameters = tool.inputSchema?.properties
    ? Object.entries(tool.inputSchema.properties)
    : [];
  const requiredParams = (tool.inputSchema?.required || []) as string[];

  return (
    <McpMenuList
      items={items}
      selectedIndex={selectedIndex}
      helpText={t('mcpViews.toolDetail.hint')}
    >
      <Text>
        <Text bold>{tool.name}</Text>{' '}
        <Text color={COLORS.text.muted}>({serverName})</Text>
        {tool.isReadOnly && (
          <Text color={COLORS.text.muted}>
            {t('mcpViews.toolDetail.readOnlyBadge')}
          </Text>
        )}
        {isDisabled && (
          <Text color={COLORS.text.muted}>
            {t('mcpViews.toolDetail.disabledBadge')}
          </Text>
        )}
      </Text>

      {tool.description && (
        <>
          <Box marginTop={1}>
            <Text bold>{t('mcpViews.toolDetail.descriptionLabel')}</Text>
          </Box>
          <Box>
            <Text>{tool.description}</Text>
          </Box>
        </>
      )}

      {parameters.length > 0 && (
        <>
          <Box marginTop={1}>
            <Text bold>{t('mcpViews.toolDetail.parametersLabel')}</Text>
          </Box>
          {parameters.map(([paramName, paramSchema]) => {
            const isRequired = requiredParams.includes(paramName);
            const schema = paramSchema as {
              type?: string;
              description?: string;
            };
            const requiredLabel = isRequired
              ? t('mcpViews.toolDetail.required')
              : t('mcpViews.toolDetail.optional');

            return (
              <Box key={paramName} flexDirection="column">
                <Text color={COLORS.text.muted}>
                  {'  '}• <Text color={COLORS.text.primary}>{paramName}</Text> (
                  {requiredLabel}):{' '}
                  {schema.type || t('mcpViews.toolDetail.anyType')}
                  {schema.description && ` - ${schema.description}`}
                </Text>
              </Box>
            );
          })}
        </>
      )}

      <Box marginTop={1} />
    </McpMenuList>
  );
}
