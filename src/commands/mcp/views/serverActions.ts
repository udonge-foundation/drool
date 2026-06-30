import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { getMcpServerUiState } from '@industry/utils/mcp';

import { AuthStatus, ServerAction } from '@/commands/mcp/views/enums';
import type {
  ServerActionItem,
  ServerWithStatus,
} from '@/commands/mcp/views/types';
import { getI18n } from '@/i18n';

/**
 * Builds the list of available actions for a server based on its current state.
 */
export function buildServerActions(
  server: ServerWithStatus,
  isConnecting: boolean
): ServerActionItem[] {
  const actions: ServerActionItem[] = [];
  let actionNum = 1;

  const isOrgServer = server.source === SettingsLevel.Org;
  const canToggleServer = !isOrgServer;
  const canRemoveServer =
    !isOrgServer && !server.isManaged && server.source === SettingsLevel.User;
  const uiState = getMcpServerUiState(server, { isConnecting });
  const canShowAuthOptions = !uiState.isConnecting;

  const t = getI18n().t;

  if (server.isDisabled) {
    // Disabled server actions
    if (uiState.isAuthenticated && server.isConnected && canShowAuthOptions) {
      actions.push({
        label: `${actionNum++}. ${t('common:mcpViews.serverActions.clearAuth')}`,
        action: ServerAction.ClearAuth,
      });
    }
    if (canToggleServer) {
      actions.push({
        label: `${actionNum++}. ${t('common:mcpViews.serverActions.enable')}`,
        action: ServerAction.Enable,
      });
    }
    // Only allow removal for personal (user-level) servers.
    if (canRemoveServer) {
      actions.push({
        label: `${actionNum++}. ${t('common:mcpViews.serverActions.removeServer')}`,
        action: ServerAction.Remove,
      });
    }
  } else if (
    !server.isConnected &&
    uiState.canAuthenticate &&
    server.authStatus === AuthStatus.NeedsAuth
  ) {
    // Server needs authentication
    actions.push({
      label: `${actionNum++}. ${t('common:mcpViews.serverActions.authenticate')}`,
      action: ServerAction.Authenticate,
    });
    if (canToggleServer) {
      actions.push({
        label: `${actionNum++}. ${t('common:mcpViews.serverActions.disable')}`,
        action: ServerAction.Disable,
      });
    }
    // Only allow removal for personal (user-level) servers.
    if (canRemoveServer) {
      actions.push({
        label: `${actionNum++}. ${t('common:mcpViews.serverActions.removeServer')}`,
        action: ServerAction.Remove,
      });
    }
  } else if (
    !server.isConnected &&
    server.hasAuthTokens === true &&
    canShowAuthOptions
  ) {
    actions.push({
      label: `${actionNum++}. ${t('common:mcpViews.serverActions.reauthenticate')}`,
      action: ServerAction.Reauthenticate,
    });
    actions.push({
      label: `${actionNum++}. ${t('common:mcpViews.serverActions.clearAuth')}`,
      action: ServerAction.ClearAuth,
    });
    actions.push({
      label: `${actionNum++}. ${t('common:mcpViews.serverActions.retry')}`,
      action: ServerAction.Retry,
    });
    if (canToggleServer) {
      actions.push({
        label: `${actionNum++}. ${t('common:mcpViews.serverActions.disable')}`,
        action: ServerAction.Disable,
      });
    }
    if (canRemoveServer) {
      actions.push({
        label: `${actionNum++}. ${t('common:mcpViews.serverActions.removeServer')}`,
        action: ServerAction.Remove,
      });
    }
  } else if (
    !server.isConnected &&
    server.authStatus === AuthStatus.NotApplicable
  ) {
    // Server doesn't need auth but is disconnected
    actions.push({
      label: `${actionNum++}. ${t('common:mcpViews.serverActions.retry')}`,
      action: ServerAction.Retry,
    });
    if (canToggleServer) {
      actions.push({
        label: `${actionNum++}. ${t('common:mcpViews.serverActions.disable')}`,
        action: ServerAction.Disable,
      });
    }
    // Only allow removal for personal (user-level) servers.
    if (canRemoveServer) {
      actions.push({
        label: `${actionNum++}. ${t('common:mcpViews.serverActions.removeServer')}`,
        action: ServerAction.Remove,
      });
    }
  } else {
    // Enabled and connected (or STDIO or connecting)
    if (!uiState.isConnecting || uiState.isConnected) {
      actions.push({
        label: `${actionNum++}. ${t('common:mcpViews.serverActions.viewTools')}`,
        action: ServerAction.ViewTools,
      });
    }
    if (uiState.isAuthenticated && server.isConnected && canShowAuthOptions) {
      actions.push({
        label: `${actionNum++}. ${t('common:mcpViews.serverActions.reauthenticate')}`,
        action: ServerAction.Reauthenticate,
      });
      actions.push({
        label: `${actionNum++}. ${t('common:mcpViews.serverActions.clearAuth')}`,
        action: ServerAction.ClearAuth,
      });
    }
    if (canToggleServer) {
      actions.push({
        label: `${actionNum++}. ${t('common:mcpViews.serverActions.disable')}`,
        action: ServerAction.Disable,
      });
    }
    // Only allow removal for personal (user-level) servers.
    if (canRemoveServer) {
      actions.push({
        label: `${actionNum++}. ${t('common:mcpViews.serverActions.removeServer')}`,
        action: ServerAction.Remove,
      });
    }
  }

  return actions;
}
