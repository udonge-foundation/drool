import { Text } from 'ink';
import { useTranslation } from 'react-i18next';
import stringWidth from 'string-width';

import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { getMcpServerUiState } from '@industry/utils/mcp';

import { AuthStatus } from '@/commands/mcp/views/enums';
import { McpMenuList } from '@/commands/mcp/views/McpMenuList';
import type {
  McpMenuListItem,
  ServerWithStatus,
} from '@/commands/mcp/views/types';
import { COLORS } from '@/components/chat/themedColors';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';

const STATUS_COLUMN_GAP = 8;

interface ServerListViewProps {
  selectedIndex: number;
  setSelectedIndex: (index: number | ((prev: number) => number)) => void;
  connectingServers: Set<string>;
  servers: ServerWithStatus[];
}

const stripStatusParens = (status: string) =>
  status.trim().replace(/^\((.*)\)$/u, '$1');

function StatusSuffix({
  label,
  status,
}: {
  label: string;
  status?: 'connected' | 'disconnected';
}) {
  const icon =
    status === 'connected' ? '✓' : status === 'disconnected' ? '✗' : '';
  const iconColor =
    status === 'connected'
      ? COLORS.success
      : status === 'disconnected'
        ? COLORS.error
        : undefined;

  return (
    <>
      <Text color={iconColor}>{label}</Text>
      {icon ? <Text color={iconColor}> {icon}</Text> : null}
    </>
  );
}

function padLabelToStatusColumn(label: string, statusColumn: number): string {
  return `${label}${' '.repeat(Math.max(0, statusColumn - stringWidth(label)))}`;
}

export function ServerListView({
  selectedIndex,
  setSelectedIndex,
  connectingServers,
  servers,
}: ServerListViewProps) {
  const { t } = useTranslation('common');
  // Total items: servers.length + 1 (Manage All Tools) + 2 (registry + manual add)
  const totalItems = servers.length + 1 + 2;

  // Handle navigation
  useKeypressHandler((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(totalItems - 1, prev + 1));
    }
  });

  const items: McpMenuListItem[] = [];
  const serverLabels = servers.map((server) => {
    const sourceLabel =
      server.source === SettingsLevel.Org
        ? t('mcpViews.serverList.orgBadge')
        : server.isManaged
          ? t('mcpViews.serverList.projectBadge')
          : '';

    return `${server.name}${sourceLabel}`;
  });
  const statusColumn =
    Math.max(0, ...serverLabels.map((label) => stringWidth(label))) +
    STATUS_COLUMN_GAP;

  servers.forEach((server, index) => {
    let suffixLabel = '';
    let suffixStatus: 'connected' | 'disconnected' | undefined;

    const uiState = getMcpServerUiState(server, {
      isConnecting: connectingServers.has(server.name),
    });

    if (server.isDisabled) {
      suffixLabel = stripStatusParens(t('mcpViews.serverList.disabled'));
    } else if (uiState.isConnected) {
      suffixLabel = stripStatusParens(t('mcpViews.serverList.connectedStatus'));
      suffixStatus = 'connected';
    } else if (uiState.isConnecting) {
      suffixLabel = stripStatusParens(
        t('mcpViews.serverList.connectingStatus')
      );
    } else if (
      uiState.needsAuth ||
      server.authStatus === AuthStatus.NeedsAuth
    ) {
      suffixLabel = stripStatusParens(
        t('mcpViews.serverList.disconnectedStatus')
      );
      suffixStatus = 'disconnected';
    } else {
      suffixLabel = stripStatusParens(
        t('mcpViews.serverList.disconnectedStatus')
      );
      suffixStatus = 'disconnected';
    }

    items.push({
      key: `server-${server.name}`,
      label: padLabelToStatusColumn(serverLabels[index], statusColumn),
      value: server.name,
      suffix: <StatusSuffix label={suffixLabel} status={suffixStatus} />,
    });
  });

  items.push({
    key: 'manage-all-tools',
    label: t('mcpViews.serverList.manageAllTools'),
    value: '__manage_all_tools__',
    marginTop: 1,
  });

  items.push({
    key: 'add-server-from-registry',
    label: t('mcpViews.serverList.addFromRegistry'),
    value: '__add_server_from_registry__',
  });

  items.push({
    key: 'add-server-manually',
    label: t('mcpViews.serverList.addManually'),
    value: '__add_server_manually__',
  });

  return (
    <McpMenuList
      title={t('mcpViews.serverList.title')}
      items={items}
      selectedIndex={selectedIndex}
      helpText={t('mcpViews.serverList.hint')}
    />
  );
}
