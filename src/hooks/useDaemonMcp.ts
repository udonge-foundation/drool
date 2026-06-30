import { useState } from 'react';

import { DroolEvent } from '@industry/daemon-client';
import {
  McpStatus,
  type McpStatusChangedNotification,
} from '@industry/drool-sdk-ext/protocol/drool';

import { useMountEffect } from '@/hooks/useMountEffect';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';

interface UseDaemonMcpResult {
  status: McpStatus;
  retry: () => Promise<void>;
}

function deriveStatusFromNotification(
  notification: Omit<McpStatusChangedNotification, 'type'>
): McpStatus {
  const { summary } = notification;

  if (summary.configError) {
    return McpStatus.Failed;
  }

  if (summary.total === 0) {
    return McpStatus.NoServers;
  }

  // All disabled counts as no servers from the user's perspective
  if (summary.disabled === summary.total) {
    return McpStatus.NoServers;
  }

  if (summary.failed > 0 && summary.connected === 0) {
    return McpStatus.Failed;
  }

  if (summary.connecting > 0) {
    return McpStatus.Initializing;
  }

  if (summary.connected > 0) {
    return McpStatus.Ready;
  }

  return McpStatus.NoServers;
}

/**
 * Derives MCP status from daemon notifications instead of
 * initializing a local MCPService. Used in daemon mode where MCP
 * is managed by the daemon process.
 */
export function useDaemonMcp(): UseDaemonMcpResult {
  const [status, setStatus] = useState<McpStatus>(McpStatus.NotInitialized);

  useMountEffect(() => {
    const adapter = getTuiDaemonAdapter();

    const unsub = adapter.onControllerEvent(
      DroolEvent.McpStatusChanged,
      (params: {
        sessionId: string;
        servers: McpStatusChangedNotification['servers'];
        summary: McpStatusChangedNotification['summary'];
      }) => {
        setStatus(deriveStatusFromNotification(params));
      }
    );

    return unsub;
  });

  const retry = async () => {
    // In daemon mode, retry is a no-op — the daemon manages MCP lifecycle
  };

  return { status, retry };
}
