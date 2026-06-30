/**
 * Unified hook for agent session management.
 * Combines SessionController state/actions with AgentEventBus subscriptions.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DroolWorkingState } from '@industry/drool-sdk-ext/protocol/drool';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';

import {
  getSessionController,
  resetSessionController,
  type SessionSettings,
  type ModelSwitchResult,
  type McpOperationResult,
} from '@/controllers/SessionController';
import {
  AgentEvent,
  subscribeToMultipleAgentEvents,
} from '@/events/AgentEventBus';

// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export interface UseAgentSessionOptions {
  /** If true, resets the SessionController singleton */
  reset?: boolean;
}

// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export interface UseAgentSessionReturn {
  // Session state
  sessionId: string | null;
  settings: SessionSettings;
  workingState: DroolWorkingState;
  isInitialized: boolean;

  // Session actions
  createSession: (
    params?: Parameters<
      ReturnType<typeof getSessionController>['createSession']
    >[0]
  ) => Promise<string>;
  loadSession: (
    params: Parameters<
      ReturnType<typeof getSessionController>['loadSession']
    >[0]
  ) => Promise<{ sessionId: string; cwd?: string; settings: SessionSettings }>;

  // Settings actions
  applySettings: (updates: Partial<SessionSettings>) => void;
  switchModel: (
    modelId: string,
    reasoningEffort?: Parameters<
      ReturnType<typeof getSessionController>['switchModel']
    >[1]
  ) => Promise<ModelSwitchResult>;
  switchSpecModeModel: (
    modelId: string,
    reasoningEffort?: Parameters<
      ReturnType<typeof getSessionController>['switchSpecModeModel']
    >[1]
  ) => Promise<ModelSwitchResult>;

  // State actions
  setWorkingState: (state: DroolWorkingState) => void;

  // MCP actions
  toggleMcpServer: (
    serverName: string,
    enabled: boolean,
    settingsLevel: SettingsLevel
  ) => Promise<McpOperationResult>;
  authenticateMcpServer: (serverName: string) => Promise<McpOperationResult>;
  clearMcpAuth: (serverName: string) => Promise<McpOperationResult>;
}

/**
 * Unified hook for agent session management.
 *
 * @example
 * ```tsx
 * const {
 *   sessionId,
 *   settings,
 *   workingState,
 *   createSession,
 *   loadSession,
 *   applySettings,
 *   setWorkingState,
 * } = useAgentSession();
 * ```
 */
export function useAgentSession(
  options: UseAgentSessionOptions = {}
): UseAgentSessionReturn {
  const { reset = false } = options;

  // Get or create the singleton controller
  const controllerRef = useRef<ReturnType<typeof getSessionController> | null>(
    null
  );
  if (!controllerRef.current) {
    if (reset) {
      resetSessionController();
    }
    controllerRef.current = getSessionController();
  }
  const controller = controllerRef.current;

  // Local state that mirrors controller state
  const [sessionId, setSessionId] = useState<string | null>(
    controller.getSessionId()
  );
  const [workingState, setWorkingStateLocal] = useState<DroolWorkingState>(
    controller.getWorkingState()
  );
  const [settings, setSettings] = useState<SessionSettings>(
    controller.getSettings()
  );

  // Subscribe to session controller events via AgentEventBus
  useEffect(() => {
    const unsubscribe = subscribeToMultipleAgentEvents({
      [AgentEvent.SettingsUpdated]: (payload) => {
        setSettings((prev) => ({ ...prev, ...payload.settings }));
      },
      [AgentEvent.WorkingStateChanged]: (payload) => {
        setWorkingStateLocal(payload.state);
      },
      [AgentEvent.SessionCreated]: (payload) => {
        setSessionId(payload.sessionId);
        setSettings(controller.getSettings());
      },
      [AgentEvent.SessionLoaded]: (payload) => {
        setSessionId(payload.sessionId);
        setSettings(payload.settings);
      },
    });

    return unsubscribe;
  }, [controller]);

  // Session actions
  const createSession = useCallback(
    async (params?: Parameters<typeof controller.createSession>[0]) => {
      const newSessionId = await controller.createSession(params);
      setSessionId(newSessionId);
      setSettings(controller.getSettings());
      setWorkingStateLocal(controller.getWorkingState());
      return newSessionId;
    },
    [controller]
  );

  const loadSession = useCallback(
    async (params: Parameters<typeof controller.loadSession>[0]) => {
      const result = await controller.loadSession(params);
      setSessionId(result.sessionId);
      setSettings(controller.getSettings());
      setWorkingStateLocal(controller.getWorkingState());
      return result;
    },
    [controller]
  );

  // Settings actions
  const applySettings = useCallback(
    (updates: Partial<SessionSettings>) => {
      controller.applySettings(updates);
    },
    [controller]
  );

  const switchModel = useCallback(
    async (
      modelId: string,
      reasoningEffort?: Parameters<typeof controller.switchModel>[1]
    ) => {
      const result = await controller.switchModel(modelId, reasoningEffort);
      if (result.success) {
        setSettings(controller.getSettings());
      }
      return result;
    },
    [controller]
  );

  const switchSpecModeModel = useCallback(
    async (
      modelId: string,
      reasoningEffort?: Parameters<typeof controller.switchSpecModeModel>[1]
    ) => {
      const result = await controller.switchSpecModeModel(
        modelId,
        reasoningEffort
      );
      if (result.success) {
        setSettings(controller.getSettings());
      }
      return result;
    },
    [controller]
  );

  // State actions
  const setWorkingState = useCallback(
    (state: DroolWorkingState) => {
      controller.setWorkingState(state);
    },
    [controller]
  );

  // MCP actions
  const toggleMcpServer = useCallback(
    (serverName: string, enabled: boolean, settingsLevel: SettingsLevel) =>
      controller.toggleMcpServer(serverName, enabled, settingsLevel),
    [controller]
  );

  const authenticateMcpServer = useCallback(
    (serverName: string) => controller.authenticateMcpServer(serverName),
    [controller]
  );

  const clearMcpAuth = useCallback(
    (serverName: string) => controller.clearMcpAuth(serverName),
    [controller]
  );

  const isInitialized = sessionId !== null;

  return useMemo(
    () => ({
      // State
      sessionId,
      settings,
      workingState,
      isInitialized,

      // Session actions
      createSession,
      loadSession,

      // Settings actions
      applySettings,
      switchModel,
      switchSpecModeModel,

      // State actions
      setWorkingState,

      // MCP actions
      toggleMcpServer,
      authenticateMcpServer,
      clearMcpAuth,
    }),
    [
      sessionId,
      settings,
      workingState,
      isInitialized,
      createSession,
      loadSession,
      applySettings,
      switchModel,
      switchSpecModeModel,
      setWorkingState,
      toggleMcpServer,
      authenticateMcpServer,
      clearMcpAuth,
    ]
  );
}
