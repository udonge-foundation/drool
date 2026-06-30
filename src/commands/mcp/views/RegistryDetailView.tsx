import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { McpMenuList } from '@/commands/mcp/views/McpMenuList';
import type { McpMenuListItem } from '@/commands/mcp/views/types';
import { COLORS } from '@/components/chat/themedColors';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';

import type { RegistryServer } from '@industry/common/settings';

interface RegistryDetailViewProps {
  server: RegistryServer;
  selectedIndex: number;
  setSelectedIndex: (index: number | ((prev: number) => number)) => void;
  onAdd: () => void;
  onBack: () => void;
  errorMessage?: string;
}

export function RegistryDetailView({
  server,
  selectedIndex,
  setSelectedIndex,
  onAdd,
  onBack,
  errorMessage,
}: RegistryDetailViewProps) {
  const { t } = useTranslation('common');

  // Handle navigation
  useKeypressHandler((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(1, prev + 1));
    } else if (key.return) {
      if (selectedIndex === 0) {
        onAdd();
      } else if (selectedIndex === 1) {
        onBack();
      }
    }
  });

  const actions: McpMenuListItem[] = [
    {
      key: 'add',
      label: t('mcpViews.registryDetail.addServer').replace(/^\d+\.\s*/u, ''),
      value: 'add',
    },
    {
      key: 'back',
      label: t('mcpViews.registryDetail.back').replace(/^\d+\.\s*/u, ''),
      value: 'back',
    },
  ];

  return (
    <>
      <McpMenuList
        items={actions}
        selectedIndex={selectedIndex}
        helpText={t('mcpViews.registryDetail.hint')}
      >
        <Text bold>{server.name}</Text>

        <Box marginTop={1} flexDirection="column">
          <Text color={COLORS.text.muted}>{server.description}</Text>
          <Text> </Text>
          <Text>
            {t('mcpViews.registryDetail.typeLabel')}
            {server.type}
          </Text>
          {(server.type === 'http' || server.type === 'sse') && server.url && (
            <Text>
              {t('mcpViews.registryDetail.urlLabel')}
              {server.url}
            </Text>
          )}
          {server.type === 'stdio' && server.command && (
            <>
              <Text>
                {t('mcpViews.registryDetail.commandLabel')}
                {server.command}
              </Text>
              {server.args && server.args.length > 0 && (
                <Text>
                  {t('mcpViews.registryDetail.argsLabel')}
                  {server.args.join(' ')}
                </Text>
              )}
            </>
          )}
          {server.note && (
            <>
              <Text> </Text>
              <Text color={COLORS.warning}>
                {t('mcpViews.registryDetail.noteLabel')}
                {server.note}
              </Text>
            </>
          )}
          {(server.type === 'http' || server.type === 'sse') &&
            server.headers &&
            Object.keys(server.headers).length > 0 && (
              <>
                <Text>{t('mcpViews.registryDetail.headersLabel')}</Text>
                {Object.entries(server.headers).map(([key, value]) => (
                  <Text key={key}>
                    • {key}: {value}
                  </Text>
                ))}
              </>
            )}
        </Box>

        <Box marginTop={1} />
      </McpMenuList>

      {errorMessage && (
        <Box marginTop={1} marginLeft={3}>
          <Text color={COLORS.error}>{errorMessage}</Text>
        </Box>
      )}
    </>
  );
}
