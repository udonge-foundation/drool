import {
  McpServerStatus,
  McpServerType,
} from '@industry/drool-sdk-ext/protocol/drool';

import { McpServerAuthUiState } from './enums';

import type {
  GetMcpServerUiStateOptions,
  McpServerUiStateInfo,
  McpServerUiStateSource,
} from './types';

function hasPendingAuthentication(server: McpServerUiStateSource): boolean {
  return Boolean(
    server.pendingAuthUrl ||
      server.pendingAuthMessage ||
      server.pendingAuthState
  );
}

function hasLegacyAuthenticationRequiredError(
  server: McpServerUiStateSource
): boolean {
  return server.error?.includes('Authentication required') === true;
}

export function doesMcpServerRequireAuthentication(
  server: McpServerUiStateSource
): boolean {
  const isRemoteServer =
    server.serverType === McpServerType.Http ||
    server.serverType === McpServerType.Sse;
  const requiresAuthentication =
    hasPendingAuthentication(server) ||
    server.requiresAuth === true ||
    (server.requiresAuth === undefined &&
      hasLegacyAuthenticationRequiredError(server));

  return (
    isRemoteServer && requiresAuthentication && server.hasAuthTokens !== true
  );
}

export function getMcpServerAuthUiState(
  server: McpServerUiStateSource
): McpServerAuthUiState {
  const isRemoteServer =
    server.serverType === McpServerType.Http ||
    server.serverType === McpServerType.Sse;
  const isConnected = server.status === McpServerStatus.Connected;
  const isDisabled = server.status === McpServerStatus.Disabled;

  if (isRemoteServer && isConnected && server.hasAuthTokens === true) {
    return McpServerAuthUiState.Authenticated;
  }

  if (
    isRemoteServer &&
    !isConnected &&
    !isDisabled &&
    doesMcpServerRequireAuthentication(server)
  ) {
    return McpServerAuthUiState.NeedsAuth;
  }

  return McpServerAuthUiState.NotApplicable;
}

export function getMcpServerUiState(
  server: McpServerUiStateSource,
  options: GetMcpServerUiStateOptions = {}
): McpServerUiStateInfo {
  const isRemoteServer =
    server.serverType === McpServerType.Http ||
    server.serverType === McpServerType.Sse;
  const isConnected = server.status === McpServerStatus.Connected;
  const isDisabled = server.status === McpServerStatus.Disabled;
  const isConnecting =
    options.isConnecting === true ||
    server.status === McpServerStatus.Connecting;
  const authState = getMcpServerAuthUiState(server);
  const isAuthenticated = authState === McpServerAuthUiState.Authenticated;
  const needsAuth = authState === McpServerAuthUiState.NeedsAuth;

  return {
    canAuthenticate:
      isRemoteServer && needsAuth && !isConnecting && !isDisabled,
    isAuthenticated,
    isConnected,
    isConnecting,
    needsAuth,
    shouldShowError: Boolean(server.error) && !isConnecting,
  };
}
