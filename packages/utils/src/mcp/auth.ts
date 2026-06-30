import { McpAuthOutcome } from '@industry/drool-sdk-ext/protocol/drool';

import { normalizeServerName } from './normalizeServerName';

import type {
  McpAuthPendingState,
  McpAuthPendingStatusSource,
  ShouldHandleMcpAuthRequiredEventOptions,
} from './types';

const DEFAULT_ENGLISH_AUTH_COMPLETION_MESSAGES: Partial<
  Record<McpAuthOutcome, string[]>
> = {
  [McpAuthOutcome.Cancelled]: ['Authentication cancelled'],
  [McpAuthOutcome.Failed]: ['Authentication failed'],
};

function shouldAppendMcpAuthCompletionDetail({
  outcome,
  detail,
  baseMessage,
  genericMessage,
}: {
  outcome: McpAuthOutcome;
  detail: string;
  baseMessage: string;
  genericMessage: string;
}): boolean {
  const normalizedDetail = detail
    .trim()
    .replace(/[.!]+$/u, '')
    .toLowerCase();
  if (!normalizedDetail) {
    return false;
  }

  const genericMessages = new Set(
    [
      baseMessage,
      genericMessage,
      ...(DEFAULT_ENGLISH_AUTH_COMPLETION_MESSAGES[outcome] ?? []),
    ].map((message) =>
      message
        .trim()
        .replace(/[.!]+$/u, '')
        .toLowerCase()
    )
  );

  return !genericMessages.has(normalizedDetail);
}

export function formatMcpAuthCompletionMessage({
  outcome,
  detail,
  baseMessage,
  genericMessage,
}: {
  outcome: McpAuthOutcome;
  detail: string;
  baseMessage: string;
  genericMessage: string;
}): string {
  const trimmedDetail = detail.trim();
  return shouldAppendMcpAuthCompletionDetail({
    outcome,
    detail: trimmedDetail,
    baseMessage,
    genericMessage,
  })
    ? `${baseMessage} ${trimmedDetail}`
    : baseMessage;
}

export function mergeMcpAuthPendingState(
  previous: McpAuthPendingState | null | undefined,
  next: McpAuthPendingState
): McpAuthPendingState {
  return {
    ...next,
    authUrl:
      previous?.serverName === next.serverName &&
      previous?.state === next.state &&
      previous.authUrl
        ? previous.authUrl
        : next.authUrl,
  };
}

export function clearMcpAuthPendingForServer(
  pending: McpAuthPendingState | null | undefined,
  serverName: string
): McpAuthPendingState | undefined {
  if (!pending) {
    return undefined;
  }

  return normalizeServerName(pending.serverName) ===
    normalizeServerName(serverName)
    ? undefined
    : pending;
}

export function shouldHandleMcpAuthRequiredEvent({
  currentSessionId,
  eventSessionId,
  requiresExplicitRequest = false,
  requestedServers,
  serverName,
}: ShouldHandleMcpAuthRequiredEventOptions): boolean {
  if (eventSessionId !== currentSessionId) {
    return false;
  }

  if (!requiresExplicitRequest) {
    return true;
  }

  return requestedServers?.has(serverName) === true;
}

export function getMcpAuthPendingFromServerStatus(
  server: McpAuthPendingStatusSource | null | undefined,
  serverName?: string
): McpAuthPendingState | null {
  if (!server) {
    return null;
  }

  if (
    !server.pendingAuthUrl ||
    !server.pendingAuthMessage ||
    !server.pendingAuthState
  ) {
    return null;
  }

  return {
    serverName: serverName ?? server.name,
    authUrl: server.pendingAuthUrl,
    message: server.pendingAuthMessage,
    state: server.pendingAuthState,
  };
}
