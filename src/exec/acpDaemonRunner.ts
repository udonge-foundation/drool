import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

import { DroolMode, DroolSubMode } from '@industry/common/shared';
import { logInfo, logWarn } from '@industry/logging';

import { ACPDaemonAdapter } from '@/acp/ACPDaemonAdapter';
import { nodeToWebReadable, nodeToWebWritable } from '@/acp/utils/nodeStreams';
import { wrapStreamForUnstableMethods } from '@/acp/utils/wrapStreamForUnstableMethods';
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

export async function runAcpDaemon(): Promise<void> {
  redirectConsoleOutput();
  logInfo('[ACPDaemon] Starting ACP daemon runner');
  getDroolRuntimeService().setDroolMode(
    DroolMode.InteractiveCLI,
    DroolSubMode.ACP
  );

  CliTelemetryClient.getInstance().setDroolMode(
    DroolMode.InteractiveCLI,
    `${DroolSubMode.ACP}-daemon`
  );

  const baseStream = ndJsonStream(
    nodeToWebWritable(process.stdout),
    nodeToWebReadable(process.stdin)
  );

  // Wrap stream to handle unstable methods not yet in SDK
  const stream = wrapStreamForUnstableMethods(baseStream);

  let adapter: ACPDaemonAdapter | null = null;

  const connection = new AgentSideConnection((client) => {
    adapter = new ACPDaemonAdapter(client);
    return adapter;
  }, stream);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logInfo('[ACPDaemon] Shutting down ACP daemon runner');

    // Dispose adapter to close all child processes
    if (adapter) {
      try {
        await adapter.dispose();
      } catch (error) {
        logWarn('[ACPDaemon] Error disposing adapter', { cause: error });
      }
    }

    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown().catch(() => {});
  });
  process.on('SIGTERM', () => {
    shutdown().catch(() => {});
  });

  process.stdin.resume();

  try {
    await connection.closed;
  } catch (error) {
    logWarn('[ACPDaemon] Connection closed with error', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await shutdown();
  }
}
