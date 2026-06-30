import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { getMcpServerUiState } from '@industry/utils/mcp';

import { AuthStatus } from '@/commands/mcp/views/enums';
import { McpMenuList } from '@/commands/mcp/views/McpMenuList';
import { buildServerActions } from '@/commands/mcp/views/serverActions';
import type {
  ServerActionItem,
  ServerWithStatus,
} from '@/commands/mcp/views/types';
import { formatServerType } from '@/commands/mcp/views/utils';
import { COLORS } from '@/components/chat/themedColors';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';

interface ServerDetailViewProps {
  server: ServerWithStatus | null;
  selectedIndex: number;
  setSelectedIndex: (index: number | ((prev: number) => number)) => void;
  connectingServers: Set<string>;
}

export function ServerDetailView({
  server,
  selectedIndex,
  setSelectedIndex,
  connectingServers,
}: ServerDetailViewProps) {
  const { t } = useTranslation('common');

  // Calculate derived state before early returns to keep hooks in same order
  const uiState = server
    ? getMcpServerUiState(server, {
        isConnecting: connectingServers.has(server.name),
      })
    : null;
  const isServerConnecting = uiState?.isConnecting ?? false;

  // Build action list based on server state using the shared function
  const actions: ServerActionItem[] = server
    ? buildServerActions(server, isServerConnecting)
    : [];

  const items = actions.map((action) => ({
    key: `action-${action.action}`,
    label: action.label,
    value: action.action.toString(),
  }));

  // Handle navigation
  useKeypressHandler((_input, key) => {
    if (!server) return;
    if (items.length === 0) return;

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(items.length - 1, prev + 1));
    }
  });

  if (!server) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={COLORS.error}>{t('mcpViews.serverDetail.notFound')}</Text>
        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('mcpViews.serverDetail.pressEscBack')}
          </Text>
        </Box>
      </Box>
    );
  }

  // Build status text and color
  let statusText = '';
  let statusColor: string | undefined;

  if (server.isDisabled) {
    statusText = t('mcpViews.serverDetail.disabled');
    statusColor = COLORS.text.muted;
  } else if (isServerConnecting) {
    statusText = t('mcpViews.serverDetail.connecting');
    statusColor = COLORS.text.muted;
  } else if (uiState?.isConnected) {
    statusText = t('mcpViews.serverDetail.connected');
    statusColor = COLORS.success;
  } else if (uiState?.needsAuth || server.authStatus === AuthStatus.NeedsAuth) {
    statusText = t('mcpViews.serverDetail.needsAuth');
    statusColor = COLORS.warning;
  } else {
    statusText = t('mcpViews.serverDetail.disconnected');
    statusColor = COLORS.error;
  }

  return (
    <McpMenuList
      items={items}
      selectedIndex={selectedIndex}
      helpText={t('mcpViews.serverDetail.hint')}
    >
      <Text bold>
        {server.name}
        {server.source === SettingsLevel.Org ? (
          <Text color={COLORS.text.muted}>
            {t('mcpViews.serverDetail.orgBadge')}
          </Text>
        ) : server.isManaged ? (
          <Text color={COLORS.text.muted}>
            {t('mcpViews.serverDetail.projectBadge')}
          </Text>
        ) : null}
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text>
          {t('mcpViews.serverDetail.statusLabel')}
          <Text color={statusColor}>{statusText}</Text>
        </Text>
        <Text>
          {t('mcpViews.serverDetail.typeLabel')}
          {formatServerType(server.serverType)}
        </Text>
        {server.error && (uiState?.shouldShowError ?? !isServerConnecting) && (
          <Text>
            <Text color={COLORS.error}>{server.error}</Text>
          </Text>
        )}
        {!server.isDisabled && (
          <Text>
            {t('mcpViews.serverDetail.toolsLabel')}
            {t('mcpViews.serverDetail.toolsEnabled', {
              enabled: server.enabledToolCount,
              total: server.toolCount,
            })}
          </Text>
        )}
      </Box>

      <Box marginTop={1} />
    </McpMenuList>
  );
}
