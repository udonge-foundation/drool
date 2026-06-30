import { useRef } from 'react';

import { DroolEvent } from '@industry/daemon-client';
import {
  MessageRole,
  MessageVisibility,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logWarn } from '@industry/logging';
import { getMcpServerUiState } from '@industry/utils/mcp';

import { useMountEffect } from '@/hooks/useMountEffect';
import { getI18n } from '@/i18n';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { sanitizeInlineText } from '@/utils/sanitizeInlineText';

import type { McpStatusChangedNotification } from '@industry/drool-sdk-ext/protocol/drool';

const MAX_DISPLAYED_SERVER_NAME_LENGTH = 64;
const MCP_AUTH_NOTICE_COALESCE_DELAY_MS = 500;

interface AuthRequiredTransition {
  next: ReadonlySet<string>;
  newlyRequired: string[];
}

/**
 * Diff the servers a user can currently authenticate against the previously
 * announced set, so a notice fires only when a server newly enters the
 * needs-auth state (and fires again if it regresses after connecting).
 */
export function computeAuthRequiredTransition(
  previous: ReadonlySet<string>,
  servers: McpStatusChangedNotification['servers']
): AuthRequiredTransition {
  const next = new Set<string>();
  const newlyRequired: string[] = [];
  for (const server of servers) {
    if (!getMcpServerUiState(server).canAuthenticate) {
      continue;
    }
    next.add(server.name);
    if (!previous.has(server.name)) {
      newlyRequired.push(server.name);
    }
  }
  return { next, newlyRequired };
}

/**
 * Posts an agent-only system message whenever MCP server statuses load or
 * change such that a server newly requires authentication. The agent uses
 * this context to point users at /mcp; the note itself stays out of the
 * user's transcript.
 */
export function useMcpAuthNotices(): void {
  const announcedRef = useRef<ReadonlySet<string>>(new Set());
  const pendingNoticesRef = useRef<
    Map<
      string,
      {
        serverNames: Set<string>;
        timeout: ReturnType<typeof setTimeout>;
      }
    >
  >(new Map());

  useMountEffect(() => {
    const adapter = getTuiDaemonAdapter();
    const flushPendingNotice = (sessionId: string) => {
      const pending = pendingNoticesRef.current.get(sessionId);
      if (!pending) {
        return;
      }
      pendingNoticesRef.current.delete(sessionId);

      const displayNames = [...pending.serverNames].map((name) =>
        sanitizeInlineText(name, MAX_DISPLAYED_SERVER_NAME_LENGTH)
      );
      const t = getI18n().t;
      const content =
        displayNames.length === 1
          ? t('common:mcpAuth.authRequiredNotice', {
              serverName: displayNames[0],
            })
          : t('common:mcpAuth.authRequiredNoticeMultiple', {
              serverNames: displayNames.map((name) => `"${name}"`).join(', '),
            });
      void adapter
        .sendTuiMessage({
          sessionId,
          text: content,
          skipAgentLoop: true,
          role: MessageRole.System,
          visibility: MessageVisibility.LLMOnly,
        })
        .catch((error) => {
          logWarn('[useMcpAuthNotices] Failed to persist auth notice', {
            cause: error,
            sessionId,
          });
        });
    };

    const queuePendingNotice = (sessionId: string, serverNames: string[]) => {
      const existing = pendingNoticesRef.current.get(sessionId);
      if (existing) {
        clearTimeout(existing.timeout);
        for (const serverName of serverNames) {
          existing.serverNames.add(serverName);
        }
        existing.timeout = setTimeout(
          () => flushPendingNotice(sessionId),
          MCP_AUTH_NOTICE_COALESCE_DELAY_MS
        );
        return;
      }

      pendingNoticesRef.current.set(sessionId, {
        serverNames: new Set(serverNames),
        timeout: setTimeout(
          () => flushPendingNotice(sessionId),
          MCP_AUTH_NOTICE_COALESCE_DELAY_MS
        ),
      });
    };

    const unsubscribe = adapter.onControllerEvent(
      DroolEvent.McpStatusChanged,
      (params: {
        sessionId: string;
        servers: McpStatusChangedNotification['servers'];
      }) => {
        const { next, newlyRequired } = computeAuthRequiredTransition(
          announcedRef.current,
          params.servers
        );
        announcedRef.current = next;
        if (newlyRequired.length === 0) {
          return;
        }

        queuePendingNotice(params.sessionId, newlyRequired);
      }
    );
    return () => {
      unsubscribe();
      for (const pending of pendingNoticesRef.current.values()) {
        clearTimeout(pending.timeout);
      }
      pendingNoticesRef.current.clear();
    };
  });
}
