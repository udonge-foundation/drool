import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

import { DroolMode, DroolSubMode } from '@industry/common/shared';
import { logInfo, logWarn } from '@industry/logging';

import { ACPAdapter } from '@/acp/ACPAdapter';
import type { AcpChildOptions } from '@/acp/types';
import { nodeToWebReadable, nodeToWebWritable } from '@/acp/utils/nodeStreams';
import { wrapStreamForUnstableMethods } from '@/acp/utils/wrapStreamForUnstableMethods';
import { getRuntimeAuthConfig } from '@/environment';
import { getDroolRuntimeService } from '@/services/DroolRuntimeService';
import { CliTelemetryClient } from '@/utils/cliTelemetryClient';

/* eslint-disable no-console */
function redirectConsoleOutput(): void {
  const redirect = (...args: unknown[]): void => {
    const formatted = args
      .map((value) =>
        typeof value === 'string' ? value : JSON.stringify(value)
      )
      .join(' ');
    process.stderr.write(`${formatted}\n`);
  };

  console.log = redirect;
  console.info = redirect;
  console.warn = redirect;
  console.debug = redirect;
}
/* eslint-enable no-console */

export async function runAcpChild(options: AcpChildOptions): Promise<void> {
  redirectConsoleOutput();
  logInfo('[ACPChild] Starting ACP child runner', {
    sessionId: options.sessionId,
  });
  getDroolRuntimeService().setDroolMode(
    DroolMode.InteractiveCLI,
    DroolSubMode.ACP
  );

  CliTelemetryClient.getInstance().setDroolMode(
    DroolMode.InteractiveCLI,
    `${DroolSubMode.ACP}-child`
  );

  // Check for auth token from daemon (via env var or stored credentials)
  const { getAuthToken } = await import('@industry/runtime/auth');
  const authToken = await getAuthToken(getRuntimeAuthConfig());
  if (!authToken) {
    logWarn('[ACPChild] No authentication available');
  }

  // Parse client capabilities from daemon (with safe JSON parsing)
  let clientCapabilities = null;
  const clientCapabilitiesJson = process.env.ACP_CLIENT_CAPABILITIES;
  if (clientCapabilitiesJson) {
    try {
      clientCapabilities = JSON.parse(clientCapabilitiesJson);
    } catch {
      logWarn('[ACPChild] Failed to parse ACP_CLIENT_CAPABILITIES');
    }
  }

  const baseStream = ndJsonStream(
    nodeToWebWritable(process.stdout),
    nodeToWebReadable(process.stdin)
  );

  const stream = wrapStreamForUnstableMethods(baseStream);

  const connection = new AgentSideConnection((client) => {
    const adapter = new ACPAdapter(client);

    // If daemon passed client capabilities, set them on the adapter
    if (clientCapabilities) {
      // The ACPAdapter will receive these via the initialize call from daemon
      // but we can also pre-set them if needed
    }

    return adapter;
  }, stream);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logInfo('[ACPChild] Shutting down ACP child runner');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.stdin.resume();

  try {
    await connection.closed;
  } catch (error) {
    logWarn('[ACPChild] Connection closed with error', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    shutdown();
  }
}
