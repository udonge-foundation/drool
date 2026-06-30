import { Box, Text } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import shellQuote from 'shell-quote';

import { type McpPolicy, RegistryServer } from '@industry/common/settings';
import { DroolEvent } from '@industry/daemon-client';
import {
  McpAuthOutcome,
  type McpToolInfo,
} from '@industry/drool-sdk-ext/protocol/drool';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException } from '@industry/logging';
import { McpSettingsManager } from '@industry/runtime/settings';
import {
  formatMcpAuthCompletionMessage,
  getMcpAuthPendingFromServerStatus,
  normalizeServerName,
} from '@industry/utils/mcp';

import { getRegistryServers } from '@/commands/mcp/registry/servers';
import { AddServerView } from '@/commands/mcp/views/AddServerView';
import { ServerAction, ToolAction, ViewType } from '@/commands/mcp/views/enums';
import { RegistryDetailView } from '@/commands/mcp/views/RegistryDetailView';
import { RegistryListView } from '@/commands/mcp/views/RegistryListView';
import { buildServerActions } from '@/commands/mcp/views/serverActions';
import { ServerDetailView } from '@/commands/mcp/views/ServerDetailView';
import { ServerListView } from '@/commands/mcp/views/ServerListView';
import { buildToolActions } from '@/commands/mcp/views/toolActions';
import { ToolDetailView } from '@/commands/mcp/views/ToolDetailView';
import { ToolsListView } from '@/commands/mcp/views/ToolsListView';
import { ToolsOverviewView } from '@/commands/mcp/views/ToolsOverviewView';
import type {
  ServerWithStatus,
  ViewStackItem,
} from '@/commands/mcp/views/types';
import { buildServerListFromDaemon } from '@/commands/mcp/views/utils';
import { COLORS } from '@/components/chat/themedColors';
import { MessageType } from '@/hooks/enums';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { getI18n } from '@/i18n';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import type { McpAuthRequiredInfo } from '@/services/mcp/types';
import { openBrowser } from '@/utils/openBrowser';

interface McpNavigatorProps {
  sessionId: string;
  mcpAuthPending?: McpAuthRequiredInfo | null;
  onExit: () => void;
  addEphemeralSystemMessage: (
    content: string,
    options?: {
      messageType?: MessageType;
      visibility?: MessageVisibility;
    }
  ) => void;
}

export function McpNavigator({
  sessionId,
  mcpAuthPending,
  onExit,
  addEphemeralSystemMessage,
}: McpNavigatorProps) {
  const { t } = useTranslation();

  const [viewStack, setViewStack] = useState<ViewStackItem[]>([
    { type: ViewType.ServerList },
  ]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [actionInProgress, setActionInProgress] = useState(false);
  const [authInProgress, setAuthInProgress] = useState(false);
  const [authServerName, setAuthServerName] = useState<string | null>(null);
  const [localAuthPending, setLocalAuthPending] =
    useState<McpAuthRequiredInfo | null>(null);
  const [triggerSelection, setTriggerSelection] = useState(false);
  const [reloadingServers, setReloadingServers] = useState<Set<string>>(
    new Set()
  );
  const [postAuthConnectingServers, setPostAuthConnectingServers] = useState<
    Set<string>
  >(new Set());
  const [registryError, setRegistryError] = useState<string | undefined>();
  const [mcpPolicy, setMcpPolicy] = useState<McpPolicy | undefined>();

  const [servers, setServers] = useState<ServerWithStatus[]>([]);
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const lastOpenedAuthKeyRef = useRef<string | null>(null);
  const authAttemptIdRef = useRef(0);
  const postAuthConnectingTimersRef = useRef<Map<string, NodeJS.Timeout>>(
    new Map()
  );

  const currentView = viewStack[viewStack.length - 1];
  const currentServerName = currentView.data?.serverName;
  const activeAuthPending =
    authInProgress && authServerName && currentServerName === authServerName
      ? mcpAuthPending &&
        authServerName === mcpAuthPending.serverName &&
        currentServerName === mcpAuthPending.serverName
        ? mcpAuthPending
        : localAuthPending
      : null;

  const loadData = useCallback(async (): Promise<ServerWithStatus[]> => {
    try {
      const adapter = getTuiDaemonAdapter();
      const [serversResult, toolsResult] = await Promise.all([
        adapter.listMcpServers(sessionId),
        adapter.listMcpTools(sessionId),
      ]);

      setTools(toolsResult.tools);
      const serverList = buildServerListFromDaemon(
        serversResult.servers,
        toolsResult.tools
      );
      setServers(serverList);

      // Only clear servers that are no longer connecting
      setReloadingServers((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        for (const name of prev) {
          const server = serverList.find((s) => s.name === name);
          if (
            !server ||
            server.isConnected ||
            server.isDisabled ||
            server.error
          ) {
            next.delete(name);
          }
        }
        return next;
      });
      setPostAuthConnectingServers((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        for (const name of prev) {
          const server = serverList.find((s) => s.name === name);
          if (
            !server ||
            server.isConnected ||
            server.isDisabled ||
            server.error
          ) {
            next.delete(name);
            const timer = postAuthConnectingTimersRef.current.get(name);
            if (timer) {
              clearTimeout(timer);
              postAuthConnectingTimersRef.current.delete(name);
            }
          }
        }
        return next;
      });
      return serverList;
    } catch (_error) {
      setServers([]);
      setTools([]);
      return [];
    }
  }, [sessionId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Load MCP policy from settings
  useEffect(() => {
    void McpSettingsManager.getInstance()
      .getMcpPolicy()
      .then(setMcpPolicy)
      .catch(() => {});
  }, []);

  // Listen for MCP status changes from the daemon
  useEffect(() => {
    const adapter = getTuiDaemonAdapter();
    const unsub = adapter.onControllerEvent(
      DroolEvent.McpStatusChanged,
      (params: { sessionId: string }) => {
        if (params.sessionId === sessionId) {
          void loadData();
        }
      }
    );
    return unsub;
  }, [sessionId, loadData]);

  useEffect(() => {
    const adapter = getTuiDaemonAdapter();
    const unsub = adapter.onControllerEvent(
      DroolEvent.McpAuthCompleted,
      (params: {
        sessionId: string;
        serverName: string;
        outcome: McpAuthOutcome;
        message: string;
      }) => {
        if (params.sessionId !== sessionId) {
          return;
        }
        if (!authInProgress || !authServerName) {
          return;
        }
        if (params.serverName !== authServerName) {
          return;
        }

        authAttemptIdRef.current += 1;
        setAuthInProgress(false);
        setAuthServerName(null);
        setLocalAuthPending(null);

        if (params.outcome === McpAuthOutcome.Success) {
          setPostAuthConnectingServers((prev) =>
            new Set(prev).add(params.serverName)
          );
          const existingTimer = postAuthConnectingTimersRef.current.get(
            params.serverName
          );
          if (existingTimer) {
            clearTimeout(existingTimer);
          }
          postAuthConnectingTimersRef.current.set(
            params.serverName,
            setTimeout(() => {
              setPostAuthConnectingServers((prev) => {
                const next = new Set(prev);
                next.delete(params.serverName);
                return next;
              });
              postAuthConnectingTimersRef.current.delete(params.serverName);
            }, 5000)
          );
          addEphemeralSystemMessage(
            getI18n().t('common:mcpAuth.authSuccessful', {
              serverName: params.serverName,
            }),
            {
              messageType: MessageType.SystemNotification,
              visibility: MessageVisibility.UserOnly,
            }
          );
          return;
        }

        const key =
          params.outcome === McpAuthOutcome.Cancelled
            ? 'common:mcpAuth.authCancelled'
            : 'common:mcpAuth.authFailed';
        const baseMessage = getI18n().t(key, {
          serverName: params.serverName,
        });
        const genericMessage =
          params.outcome === McpAuthOutcome.Cancelled
            ? getI18n().t('common:mcpAuth.authCancelledGeneric')
            : getI18n().t('common:mcpAuth.authFailedDefault');
        const content = formatMcpAuthCompletionMessage({
          outcome: params.outcome,
          detail: params.message,
          baseMessage,
          genericMessage,
        });
        setPostAuthConnectingServers((prev) => {
          const next = new Set(prev);
          next.delete(params.serverName);
          return next;
        });
        addEphemeralSystemMessage(content, {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        });
      }
    );
    return unsub;
  }, [
    sessionId,
    authInProgress,
    authServerName,
    addEphemeralSystemMessage,
    loadData,
  ]);

  useEffect(
    () => () => {
      for (const timer of postAuthConnectingTimersRef.current.values()) {
        clearTimeout(timer);
      }
      postAuthConnectingTimersRef.current.clear();
    },
    []
  );

  useEffect(() => {
    if (
      !authInProgress ||
      !authServerName ||
      currentServerName === authServerName
    ) {
      return;
    }

    void getTuiDaemonAdapter()
      .cancelMcpAuth(sessionId, authServerName)
      .catch(() => {});

    authAttemptIdRef.current += 1;
    setAuthInProgress(false);
    setAuthServerName(null);
    setLocalAuthPending(null);
  }, [authInProgress, authServerName, currentServerName, sessionId]);

  useEffect(() => {
    if (!localAuthPending) {
      return;
    }

    const authKey = `${localAuthPending.serverName}:${localAuthPending.state}`;
    if (lastOpenedAuthKeyRef.current === authKey) {
      return;
    }
    lastOpenedAuthKeyRef.current = authKey;

    void openBrowser(localAuthPending.authUrl).then((opened) => {
      if (!opened) {
        addEphemeralSystemMessage(
          getI18n().t('commands:login.browserNotOpened'),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
      }
    });
  }, [localAuthPending, addEphemeralSystemMessage]);

  useEffect(() => {
    if (
      !authInProgress ||
      !authServerName ||
      activeAuthPending ||
      currentServerName !== authServerName
    ) {
      return;
    }

    const attemptId = authAttemptIdRef.current;
    const timeout = setTimeout(() => {
      void (async () => {
        if (authAttemptIdRef.current !== attemptId) {
          return;
        }

        const adapter = getTuiDaemonAdapter();
        const serversResult = await adapter.listMcpServers(sessionId);
        if (authAttemptIdRef.current !== attemptId) {
          return;
        }
        const fallbackServer = serversResult.servers.find(
          (server) => server.name === authServerName
        );
        const fallbackPending = getMcpAuthPendingFromServerStatus(
          fallbackServer,
          authServerName
        );

        if (fallbackPending) {
          setLocalAuthPending(fallbackPending);
          void loadData();
          return;
        }

        authAttemptIdRef.current += 1;
        setAuthInProgress(false);
        setAuthServerName(null);
        setLocalAuthPending(null);
        await adapter.cancelMcpAuth(sessionId, authServerName).catch(() => {});
        addEphemeralSystemMessage(
          getI18n().t('common:mcpAuth.authDidNotStart', {
            serverName: authServerName,
          }),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
      })().catch((error) => {
        logException(error, 'Failed MCP auth fallback recovery');
        authAttemptIdRef.current += 1;
        setAuthInProgress(false);
        setAuthServerName(null);
        setLocalAuthPending(null);
      });
    }, 3000);

    return () => {
      clearTimeout(timeout);
    };
  }, [
    activeAuthPending,
    addEphemeralSystemMessage,
    authInProgress,
    authServerName,
    currentServerName,
    loadData,
    sessionId,
  ]);

  const pushView = useCallback((view: ViewStackItem) => {
    setViewStack((stack) => [...stack, view]);
    setSelectedIndex(0);
  }, []);

  const popView = useCallback(() => {
    setViewStack((stack) => {
      if (stack.length <= 1) {
        return stack;
      }
      return stack.slice(0, -1);
    });
    setSelectedIndex(0);
  }, []);

  const handleToggleEnabled = useCallback(
    async (serverName: string, isDisabled: boolean) => {
      if (actionInProgress) return;
      setActionInProgress(true);

      if (isDisabled) {
        setReloadingServers((prev) => new Set(prev).add(serverName));
      }

      try {
        const adapter = getTuiDaemonAdapter();
        await adapter.toggleMcpServer(sessionId, serverName, isDisabled);
        setSelectedIndex(0);
        void loadData();
      } catch (error) {
        addEphemeralSystemMessage(
          t('common:mcpViews.navigator.failedToggleServer', {
            action: isDisabled
              ? t('common:mcpViews.serverActions.enable').toLowerCase()
              : t('common:mcpViews.serverActions.disable').toLowerCase(),
            error:
              error instanceof Error
                ? error.message
                : t('common:mcpViews.navigator.unknownError'),
          }),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        logException(
          error,
          isDisabled ? 'Failed to enable server' : 'Failed to disable server'
        );
        if (isDisabled) {
          setReloadingServers((prev) => {
            const next = new Set(prev);
            next.delete(serverName);
            return next;
          });
        }
      } finally {
        setActionInProgress(false);
      }
    },
    [actionInProgress, sessionId, addEphemeralSystemMessage, loadData]
  );

  const handleRemove = useCallback(
    async (serverName: string) => {
      if (actionInProgress) return;
      setActionInProgress(true);

      try {
        const adapter = getTuiDaemonAdapter();
        const result = await adapter.removeMcpServer(sessionId, serverName);

        if (result.success) {
          addEphemeralSystemMessage(
            getI18n().t('commands:slashMessages.removedMcpServer', {
              name: serverName,
            }),
            {
              messageType: MessageType.SystemNotification,
              visibility: MessageVisibility.UserOnly,
            }
          );
          await loadData();
          popView();
        } else {
          addEphemeralSystemMessage(
            t('common:mcpViews.navigator.failedRemoveServer', {
              error: t('common:mcpViews.navigator.unknownError'),
            }),
            {
              messageType: MessageType.SystemNotification,
              visibility: MessageVisibility.UserOnly,
            }
          );
        }
      } catch (error) {
        addEphemeralSystemMessage(
          t('common:mcpViews.navigator.failedRemoveServer', {
            error:
              error instanceof Error
                ? error.message
                : t('common:mcpViews.navigator.unknownError'),
          }),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        logException(error, 'Failed to remove server', {});
      } finally {
        setActionInProgress(false);
      }
    },
    [actionInProgress, sessionId, addEphemeralSystemMessage, popView, loadData]
  );

  const handleRetry = useCallback(
    async (serverName: string) => {
      if (actionInProgress) return;
      setActionInProgress(true);

      setReloadingServers((prev) => new Set(prev).add(serverName));

      try {
        // Retry by disabling then re-enabling the server.
        // The disable may fail if the server is already in a failed/disconnected state,
        // but we still attempt enable regardless.
        const adapter = getTuiDaemonAdapter();
        await adapter
          .toggleMcpServer(sessionId, serverName, false)
          .catch(() => {});
        await adapter.toggleMcpServer(sessionId, serverName, true);
        void loadData();
      } catch (error) {
        setReloadingServers((prev) => {
          const next = new Set(prev);
          next.delete(serverName);
          return next;
        });
        addEphemeralSystemMessage(
          t('common:mcpViews.navigator.failedRetryOperation', {
            error:
              error instanceof Error
                ? error.message
                : t('common:mcpViews.navigator.unknownError'),
          }),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        logException(error, 'Failed to retry server');
      } finally {
        setActionInProgress(false);
      }
    },
    [actionInProgress, sessionId, addEphemeralSystemMessage, loadData]
  );

  const handleAuthenticate = useCallback(
    async (serverName: string) => {
      if (actionInProgress || authInProgress) return;
      setAuthInProgress(true);
      setAuthServerName(serverName);
      setLocalAuthPending(null);
      authAttemptIdRef.current += 1;
      const attemptId = authAttemptIdRef.current;

      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.authenticatingWith', {
          name: serverName,
        }),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );

      const adapter = getTuiDaemonAdapter();
      void adapter
        .authenticateMcpServer(sessionId, serverName)
        .catch((error) => {
          if (authAttemptIdRef.current !== attemptId) {
            return;
          }
          setAuthInProgress(false);
          setAuthServerName(null);
          setLocalAuthPending(null);
          addEphemeralSystemMessage(
            t('common:mcpViews.navigator.failedAuthenticateServer', {
              error:
                error instanceof Error
                  ? error.message
                  : t('common:mcpViews.navigator.unknownError'),
            }),
            {
              messageType: MessageType.SystemNotification,
              visibility: MessageVisibility.UserOnly,
            }
          );
          logException(error, 'Failed to authenticate server');
        });
    },
    [actionInProgress, authInProgress, sessionId, addEphemeralSystemMessage]
  );

  const handleClearAuth = useCallback(
    async (serverName: string) => {
      if (actionInProgress || authInProgress) return;
      setActionInProgress(true);

      try {
        const adapter = getTuiDaemonAdapter();
        const result = await adapter.clearMcpAuth(sessionId, serverName);

        if (result.success) {
          addEphemeralSystemMessage(
            getI18n().t('commands:slashMessages.clearedMcpAuth', {
              name: serverName,
            }),
            {
              messageType: MessageType.SystemNotification,
              visibility: MessageVisibility.UserOnly,
            }
          );
          onExit();
        } else {
          addEphemeralSystemMessage(
            t('common:mcpViews.navigator.failedClearAuth', {
              error: t('common:mcpViews.navigator.unknownError'),
            }),
            {
              messageType: MessageType.SystemNotification,
              visibility: MessageVisibility.UserOnly,
            }
          );
        }
      } catch (error) {
        addEphemeralSystemMessage(
          t('common:mcpViews.navigator.failedClearAuth', {
            error:
              error instanceof Error
                ? error.message
                : t('common:mcpViews.navigator.unknownError'),
          }),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        logException(error, 'Failed to clear authentication');
      } finally {
        setActionInProgress(false);
      }
    },
    [
      actionInProgress,
      authInProgress,
      sessionId,
      addEphemeralSystemMessage,
      onExit,
    ]
  );

  const handleAddServer = useCallback(
    async (
      name: string,
      type: 'stdio' | 'http' | 'sse',
      urlOrCommand: string,
      headers?: Record<string, string>,
      oauth?: false
    ) => {
      if (actionInProgress) return;

      // Check MCP policy before adding
      const serverConfig =
        type === 'http'
          ? ({ type: 'http', url: urlOrCommand } as const)
          : type === 'sse'
            ? ({ type: 'sse', url: urlOrCommand } as const)
            : ({ type: 'stdio', command: urlOrCommand } as const);
      const isAllowed = McpSettingsManager.isServerAllowedByPolicy(
        serverConfig,
        mcpPolicy
      );
      if (!isAllowed) {
        addEphemeralSystemMessage(
          `${name} (not enabled — does not match your organization's allowlist)`,
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        onExit();
        return;
      }

      setActionInProgress(true);

      try {
        const adapter = getTuiDaemonAdapter();

        if (type === 'http' || type === 'sse') {
          await adapter.addMcpServer(sessionId, {
            name,
            type,
            url: urlOrCommand,
            headers,
            oauth,
          });
        } else {
          const commandParts = shellQuote
            .parse(urlOrCommand)
            .map((part) => part.toString());

          const command = commandParts[0] || '';
          const args = commandParts.slice(1);

          await adapter.addMcpServer(sessionId, {
            name,
            type,
            command,
            args,
          });
        }

        addEphemeralSystemMessage(
          getI18n().t('commands:slashMessages.addedMcpServer', { name }),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        await loadData();
        setViewStack([
          { type: ViewType.ServerList },
          {
            type: ViewType.ServerDetail,
            data: { serverName: normalizeServerName(name) },
          },
        ]);
        setSelectedIndex(0);
      } catch (error) {
        addEphemeralSystemMessage(
          t('common:mcpViews.navigator.failedAddServer', {
            error: error instanceof Error ? error.message : String(error),
          }),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        logException(error, 'Failed to add server', {
          name,
          type,
          url: urlOrCommand,
        });
      } finally {
        setActionInProgress(false);
      }
    },
    [
      actionInProgress,
      mcpPolicy,
      sessionId,
      addEphemeralSystemMessage,
      loadData,
      t,
    ]
  );

  const handleToggleTool = useCallback(
    async ({
      serverName,
      toolName,
      isCurrentlyDisabled,
    }: {
      serverName: string;
      toolName: string;
      isCurrentlyDisabled: boolean;
    }) => {
      if (actionInProgress) return;
      setActionInProgress(true);

      try {
        const adapter = getTuiDaemonAdapter();
        await adapter.toggleMcpTool(
          sessionId,
          serverName,
          toolName,
          isCurrentlyDisabled // enabled = true if currently disabled
        );

        // Optimistically update tools state
        setTools((prev) =>
          prev.map((tool) =>
            tool.serverName === serverName && tool.name === toolName
              ? { ...tool, isEnabled: isCurrentlyDisabled }
              : tool
          )
        );

        // Also update server enabledToolCount to keep UI consistent
        const delta = isCurrentlyDisabled ? 1 : -1;
        setServers((prev) =>
          prev.map((s) =>
            s.name === serverName
              ? { ...s, enabledToolCount: s.enabledToolCount + delta }
              : s
          )
        );
      } catch (error) {
        addEphemeralSystemMessage(
          t('common:mcpViews.navigator.failedToggleTool', {
            action: isCurrentlyDisabled
              ? t('common:mcpViews.toolActions.enableTool').toLowerCase()
              : t('common:mcpViews.toolActions.disableTool').toLowerCase(),
            error:
              error instanceof Error
                ? error.message
                : t('common:mcpViews.navigator.unknownError'),
          }),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        logException(
          error,
          isCurrentlyDisabled
            ? 'Failed to enable tool'
            : 'Failed to disable tool'
        );
      } finally {
        setActionInProgress(false);
      }
    },
    [actionInProgress, sessionId, addEphemeralSystemMessage]
  );

  const handleOverviewToggleTool = useCallback(
    async (serverName: string, toolName: string) => {
      if (actionInProgress) return;
      const tool = tools.find(
        (item) => item.serverName === serverName && item.name === toolName
      );
      const isCurrentlyDisabled = tool ? !tool.isEnabled : false;
      await handleToggleTool({ serverName, toolName, isCurrentlyDisabled });
    },
    [actionInProgress, tools, handleToggleTool]
  );

  const handleOverviewToggleServer = useCallback(
    async (serverName: string) => {
      if (actionInProgress) return;
      setActionInProgress(true);

      try {
        const adapter = getTuiDaemonAdapter();
        const serverTools = tools.filter(
          (tool) => tool.serverName === serverName
        );
        const allDisabled = serverTools.every((tool) => !tool.isEnabled);

        await Promise.all(
          serverTools.map((tool) =>
            adapter.toggleMcpTool(sessionId, serverName, tool.name, allDisabled)
          )
        );

        setTools((prev) =>
          prev.map((tool) =>
            tool.serverName === serverName
              ? { ...tool, isEnabled: allDisabled }
              : tool
          )
        );
      } catch (error) {
        addEphemeralSystemMessage(
          t('common:mcpViews.navigator.failedToggleServerTools', {
            error:
              error instanceof Error
                ? error.message
                : t('common:mcpViews.navigator.unknownError'),
          }),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        logException(error, 'Failed to toggle server tools');
        // Reconcile state with daemon after partial failure
        void loadData();
      } finally {
        setActionInProgress(false);
      }
    },
    [actionInProgress, tools, sessionId, addEphemeralSystemMessage, loadData]
  );

  const handleOverviewToggleAll = useCallback(async () => {
    if (actionInProgress) return;
    setActionInProgress(true);

    try {
      const adapter = getTuiDaemonAdapter();
      const allEnabled = tools.every((tool) => tool.isEnabled);

      const results = await Promise.allSettled(
        tools.map((tool) =>
          adapter.toggleMcpTool(
            sessionId,
            tool.serverName,
            tool.name,
            !allEnabled
          )
        )
      );

      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        const firstError =
          failures[0].status === 'rejected' ? failures[0].reason : undefined;
        addEphemeralSystemMessage(
          t('common:mcpViews.navigator.failedToggleAllTools', {
            error:
              firstError instanceof Error
                ? firstError.message
                : t('common:mcpViews.navigator.unknownError'),
          }),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        logException(firstError, 'Failed to toggle all tools');
        // Reconcile state with daemon after partial failure
        void loadData();
      } else {
        setTools((prev) =>
          prev.map((tool) => ({ ...tool, isEnabled: !allEnabled }))
        );
      }
    } catch (error) {
      logException(error, 'Failed to toggle all tools (unexpected)');
      void loadData();
    } finally {
      setActionInProgress(false);
    }
  }, [actionInProgress, tools, sessionId, addEphemeralSystemMessage, loadData]);

  const handleAddFromRegistry = useCallback(
    async (registryServer: RegistryServer) => {
      if (actionInProgress || !registryServer.type) return;

      setRegistryError(undefined);

      const existingServerNames = servers.map((s) =>
        normalizeServerName(s.name).toLowerCase()
      );
      if (
        existingServerNames.includes(
          normalizeServerName(registryServer.name).toLowerCase()
        )
      ) {
        setRegistryError(
          t('common:mcpViews.navigator.serverAlreadyExists', {
            name: registryServer.name,
          })
        );
        return;
      }

      setActionInProgress(true);

      try {
        const adapter = getTuiDaemonAdapter();
        await adapter.addMcpServer(sessionId, {
          name: registryServer.name,
          type: registryServer.type,
          url:
            registryServer.type === 'http' || registryServer.type === 'sse'
              ? registryServer.url
              : undefined,
          command:
            registryServer.type === 'stdio'
              ? registryServer.command
              : undefined,
          args:
            registryServer.type === 'stdio' ? registryServer.args : undefined,
        });

        addEphemeralSystemMessage(
          getI18n().t('commands:slashMessages.addedMcpServer', {
            name: registryServer.name,
          }),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );

        const serverList = await loadData();

        const normalizedName = normalizeServerName(registryServer.name);
        setViewStack([
          { type: ViewType.ServerList },
          {
            type: ViewType.ServerDetail,
            data: { serverName: normalizedName },
          },
        ]);
        setSelectedIndex(0);

        const addedServer = serverList.find(
          (server) => normalizeServerName(server.name) === normalizedName
        );
        if (
          registryServer.type !== 'stdio' &&
          addedServer?.requiresAuth &&
          !addedServer.hasAuthTokens
        ) {
          void handleAuthenticate(normalizedName);
        }
      } catch (error) {
        addEphemeralSystemMessage(
          t('common:mcpViews.navigator.failedAddServer', {
            error: error instanceof Error ? error.message : String(error),
          }),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        logException(error, 'Failed to add server from registry', {
          name: registryServer.name,
          type: registryServer.type,
        });
      } finally {
        setActionInProgress(false);
      }
    },
    [
      actionInProgress,
      servers,
      sessionId,
      addEphemeralSystemMessage,
      loadData,
      handleAuthenticate,
      t,
    ]
  );

  useKeypressHandler((_input, key) => {
    if (actionInProgress) return;

    if (key.escape) {
      // Cancel any in-flight auth so the pending OAuth callback doesn't
      // linger and get cancelled by the next Authenticate attempt.
      if (authInProgress && authServerName) {
        void getTuiDaemonAdapter()
          .cancelMcpAuth(sessionId, authServerName)
          .catch(() => {});
        setAuthInProgress(false);
        setAuthServerName(null);
      }

      if (viewStack.length > 1) {
        popView();
      } else {
        onExit();
      }
      return;
    }

    if (key.return) {
      setTriggerSelection(true);
    }
  });

  // Handle selection trigger with useEffect to allow async operations
  useEffect(() => {
    if (!triggerSelection) return;

    const handleSelection = async () => {
      try {
        switch (currentView.type) {
          case ViewType.ServerList: {
            // Index 0 to servers.length - 1 = servers
            // Index servers.length = Manage All Tools
            // Index servers.length + 1 = Registry
            // Index servers.length + 2 = Add Server
            //
            // IMPORTANT: Keep selection aligned with the rendered server list
            // (which is sorted/grouped), not Object.keys(configs).
            const serverCount = servers.length;

            if (selectedIndex < serverCount) {
              const selectedServer = servers[selectedIndex];
              if (!selectedServer) break;
              pushView({
                type: ViewType.ServerDetail,
                data: { serverName: selectedServer.name },
              });
            } else if (selectedIndex === serverCount) {
              // Manage All Tools
              pushView({ type: ViewType.ToolsOverview });
            } else if (selectedIndex === serverCount + 1) {
              pushView({ type: ViewType.RegistryList });
            } else if (selectedIndex === serverCount + 2) {
              pushView({ type: ViewType.AddServer });
            }
            break;
          }

          case ViewType.ServerDetail: {
            const serverName = currentView.data?.serverName;
            if (!serverName) break;

            const server = servers.find((s) => s.name === serverName);
            if (!server) break;

            const isServerConnecting = reloadingServers.has(server.name);
            const actions = buildServerActions(server, isServerConnecting);
            const selectedAction = actions[selectedIndex]?.action;

            switch (selectedAction) {
              case ServerAction.ViewTools:
                pushView({
                  type: ViewType.ToolsList,
                  data: { serverName },
                });
                break;
              case ServerAction.Authenticate:
              case ServerAction.Reauthenticate:
                void handleAuthenticate(serverName);
                break;
              case ServerAction.ClearAuth:
                void handleClearAuth(serverName);
                break;
              case ServerAction.Enable:
                void handleToggleEnabled(serverName, true);
                break;
              case ServerAction.Disable:
                void handleToggleEnabled(serverName, false);
                break;
              case ServerAction.Retry:
                void handleRetry(serverName);
                break;
              case ServerAction.Remove:
                void handleRemove(serverName);
                break;
              default:
                break;
            }
            break;
          }

          case ViewType.ToolsList: {
            const serverName = currentView.data?.serverName;
            if (!serverName) break;

            const serverTools = tools.filter(
              (item) => item.serverName === serverName
            );
            if (selectedIndex >= 0 && selectedIndex < serverTools.length) {
              pushView({
                type: ViewType.ToolDetail,
                data: { serverName, toolName: serverTools[selectedIndex].name },
              });
            }
            break;
          }

          case ViewType.ToolDetail: {
            const { serverName, toolName } = currentView.data || {};
            if (!serverName || !toolName) break;

            const tool = tools.find(
              (item) => item.serverName === serverName && item.name === toolName
            );
            const isToolDisabled = tool ? !tool.isEnabled : false;
            const toolActions = buildToolActions(isToolDisabled);
            const selectedToolAction = toolActions[selectedIndex]?.action;

            switch (selectedToolAction) {
              case ToolAction.Enable:
                void handleToggleTool({
                  serverName,
                  toolName,
                  isCurrentlyDisabled: true,
                });
                break;
              case ToolAction.Disable:
                void handleToggleTool({
                  serverName,
                  toolName,
                  isCurrentlyDisabled: false,
                });
                break;
              case ToolAction.Back:
                popView();
                break;
              default:
                break;
            }
            break;
          }

          case ViewType.RegistryList:
            break;

          case ViewType.RegistryDetail:
            break;

          default:
            break;
        }
      } finally {
        setTriggerSelection(false);
      }
    };

    void handleSelection();
  }, [
    triggerSelection,
    currentView,
    selectedIndex,
    servers,
    tools,
    reloadingServers,
    pushView,
    popView,
    handleToggleEnabled,
    handleToggleTool,
    handleRemove,
    handleRetry,
    handleAuthenticate,
    handleClearAuth,
  ]);

  if (activeAuthPending) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text bold>{activeAuthPending.message}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={COLORS.text.muted}>
            {t('common:mcpViews.navigator.escToGoBack')}
          </Text>
          <Text>{activeAuthPending.authUrl}</Text>
        </Box>
      </Box>
    );
  }

  if (authInProgress) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={COLORS.primary}>
          {t('common:mcpViews.navigator.processing')}
        </Text>
        <Text color={COLORS.text.muted}>
          {t('common:mcpViews.navigator.escToGoBack')}
        </Text>
      </Box>
    );
  }

  const connectingServerNames = new Set([
    ...reloadingServers,
    ...postAuthConnectingServers,
  ]);

  if (actionInProgress) {
    return (
      <Box marginTop={1}>
        <Text color={COLORS.primary}>
          {t('common:mcpViews.navigator.processing')}
        </Text>
      </Box>
    );
  }

  switch (currentView.type) {
    case ViewType.ServerList:
      return (
        <ServerListView
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          connectingServers={connectingServerNames}
          servers={servers}
        />
      );

    case ViewType.ServerDetail: {
      const serverName = currentView.data?.serverName;
      if (!serverName) {
        return (
          <Box marginTop={1}>
            <Text color={COLORS.error}>
              {t('common:mcpViews.navigator.errorNoServer')}
            </Text>
          </Box>
        );
      }

      const server = servers.find((s) => s.name === serverName);

      return (
        <ServerDetailView
          server={server || null}
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          connectingServers={connectingServerNames}
        />
      );
    }

    case ViewType.ToolsList: {
      const serverName = currentView.data?.serverName;
      if (!serverName) {
        return (
          <Box marginTop={1}>
            <Text color={COLORS.error}>
              {t('common:mcpViews.navigator.errorNoServer')}
            </Text>
          </Box>
        );
      }

      const serverTools = tools.filter(
        (item) => item.serverName === serverName
      );

      return (
        <ToolsListView
          serverName={serverName}
          tools={serverTools}
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
        />
      );
    }

    case ViewType.ToolDetail: {
      const { serverName, toolName } = currentView.data || {};
      if (!serverName || !toolName) {
        return (
          <Box marginTop={1}>
            <Text color={COLORS.error}>
              {t('common:mcpViews.navigator.errorNoTool')}
            </Text>
          </Box>
        );
      }

      const tool =
        tools.find(
          (item) => item.serverName === serverName && item.name === toolName
        ) ?? null;

      return (
        <ToolDetailView
          serverName={serverName}
          tool={tool}
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
        />
      );
    }

    case ViewType.ToolsOverview: {
      return (
        <ToolsOverviewView
          tools={tools}
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          onToggleTool={handleOverviewToggleTool}
          onToggleServer={handleOverviewToggleServer}
          onToggleAll={handleOverviewToggleAll}
          onViewToolDetail={(serverName, toolName) => {
            pushView({
              type: ViewType.ToolDetail,
              data: { serverName, toolName },
            });
          }}
        />
      );
    }

    case ViewType.AddServer: {
      const existingServerNames = servers.map((s) =>
        normalizeServerName(s.name).toLowerCase()
      );

      return (
        <AddServerView
          onSubmit={handleAddServer}
          existingServerNames={existingServerNames}
        />
      );
    }

    case ViewType.RegistryList: {
      return (
        <RegistryListView
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          mcpPolicy={mcpPolicy}
          onSelect={(server) => {
            pushView({
              type: ViewType.RegistryDetail,
              data: { serverName: server.name },
            });
          }}
        />
      );
    }

    case ViewType.RegistryDetail: {
      const serverName = currentView.data?.serverName;
      if (!serverName) {
        return (
          <Box marginTop={1}>
            <Text color={COLORS.error}>
              {t('common:mcpViews.navigator.errorNoRegistryServer')}
            </Text>
          </Box>
        );
      }

      const registryServers = getRegistryServers();
      const registryServer = registryServers.find(
        (s: RegistryServer) => s.name === serverName
      );

      if (!registryServer) {
        return (
          <Box marginTop={1}>
            <Text color={COLORS.error}>
              {t('common:mcpViews.navigator.errorRegistryNotFound')}
            </Text>
          </Box>
        );
      }

      return (
        <RegistryDetailView
          server={registryServer}
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          onAdd={() => {
            void handleAddFromRegistry(registryServer);
          }}
          onBack={popView}
          errorMessage={registryError}
        />
      );
    }

    default:
      return (
        <Box marginTop={1}>
          <Text color={COLORS.error}>
            {t('common:mcpViews.navigator.unknownViewType')}
          </Text>
        </Box>
      );
  }
}
