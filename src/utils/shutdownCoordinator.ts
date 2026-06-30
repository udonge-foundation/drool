import * as path from 'path';

import { getSentryAdapter, logError, logException } from '@industry/logging';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { MCP_SERVER_KILL_GRACE_MS } from '@/mcp/constants';
import { getMcpServiceIfCreated } from '@/services/mcp/McpService';
import { CustomerMetrics } from '@/telemetry/customer/CustomerMetrics';
import { cleanupAgentBrowserDaemons } from '@/utils/agentBrowserCleanup';
import { cleanupOldFiles } from '@/utils/cleanupOldFiles';
import { CliTelemetryClient } from '@/utils/cliTelemetryClient';
import { SHUTDOWN_HOOK_PRIORITY } from '@/utils/constants';
import { ShutdownReason, ShutdownSignal } from '@/utils/enums';
import { type ShutdownContext } from '@/utils/types';

// Keep MCP cleanup timeout above the MCP SIGTERM grace window so SIGKILL escalation can complete.
const MCP_CLEANUP_TIMEOUT_MS = 3000;
const MCP_CLEANUP_TIMEOUT_BUFFER_MS = 2000;
const TIMEOUT_RESULT = 'timeout';
const SHUTDOWN_HOOK_TIMEOUT_MS = 10000;

type ShutdownHookEntry = {
  hook: (context: ShutdownContext) => Promise<void>;
  priority: number;
  /**
   * Per-hook wait budget. When set, grows the global hook-chain race to
   * accommodate hooks that legitimately need more than the default (e.g. the
   * auto-update drain). Hooks still bound their own waits internally; this
   * only prevents the coordinator's safety net from cutting them short.
   */
  timeoutMs?: number;
  order: number;
};

type ShutdownHookOptions = {
  priority?: number;
  timeoutMs?: number;
};

async function cleanupMcpWithTimeout(): Promise<void> {
  const mcpService = getMcpServiceIfCreated();
  if (!mcpService) {
    return;
  }

  const serverCount = Object.keys(mcpService.listServers()).length;
  const cleanupTimeoutMs = Math.max(
    MCP_CLEANUP_TIMEOUT_MS,
    serverCount * MCP_SERVER_KILL_GRACE_MS + MCP_CLEANUP_TIMEOUT_BUFFER_MS
  );

  const cleanupPromise = mcpService.cleanup().catch((error) => {
    logError('[ShutdownCoordinator] MCP cleanup failed', { error });
  });

  const timeoutPromise = new Promise<typeof TIMEOUT_RESULT>((resolve) => {
    const timeoutId = setTimeout(
      () => resolve(TIMEOUT_RESULT),
      cleanupTimeoutMs
    );
    timeoutId.unref?.();
  });

  const result = await Promise.race([
    cleanupPromise.then(() => 'completed' as const),
    timeoutPromise,
  ]);

  if (result === TIMEOUT_RESULT && process.env.INDUSTRY_ENV !== 'production') {
    logError('MCP cleanup timed out', {
      timeout: cleanupTimeoutMs,
      count: serverCount,
    });
  }
}

class ShutdownCoordinator {
  private hooks = new Map<string, ShutdownHookEntry>();

  private nextHookOrder = 0;

  private shutdownPromise: Promise<void> | null = null;

  private shutdownExitCode = 0;

  private handlersRegistered = false;

  registerHook(
    name: string,
    hook: (context: ShutdownContext) => Promise<void>,
    options: ShutdownHookOptions = {}
  ): void {
    const existing = this.hooks.get(name);
    if (existing) {
      logError('[ShutdownCoordinator] Duplicate hook registration', {
        name,
      });
    }

    const order = existing?.order ?? this.nextHookOrder;
    if (!existing) {
      this.nextHookOrder += 1;
    }

    this.hooks.set(name, {
      hook,
      priority: options.priority ?? SHUTDOWN_HOOK_PRIORITY.Default,
      timeoutMs: options.timeoutMs,
      order,
    });
  }

  registerSignalHandlers(): void {
    if (this.handlersRegistered) return;
    this.handlersRegistered = true;

    process.on('SIGINT', () => {
      void this.requestExit({
        reason: ShutdownReason.PromptInputExit,
        exitCode: 0,
        signal: ShutdownSignal.SIGINT,
      });
    });

    process.on('SIGTERM', () => {
      void this.requestExit({
        reason: ShutdownReason.Other,
        exitCode: 0,
        signal: ShutdownSignal.SIGTERM,
      });
    });
  }

  requestExit(context: ShutdownContext): Promise<void> {
    if (this.shutdownPromise) {
      if (this.shutdownExitCode === 0 && context.exitCode !== 0) {
        this.shutdownExitCode = context.exitCode;
        process.exitCode = this.shutdownExitCode;
      }
      return this.shutdownPromise;
    }

    this.shutdownExitCode = context.exitCode;
    process.exitCode = this.shutdownExitCode;

    this.shutdownPromise = (async () => {
      await this.runHooks({
        ...context,
        exitCode: this.shutdownExitCode,
      });

      await ShutdownCoordinator.runCoreShutdown();

      process.exitCode = this.shutdownExitCode;
      process.exit(this.shutdownExitCode);
    })();

    return this.shutdownPromise;
  }

  private async runHooks(context: ShutdownContext): Promise<void> {
    const orderedHooks = Array.from(this.hooks.entries()).sort(
      ([, left], [, right]) =>
        left.priority - right.priority || left.order - right.order
    );

    const hooksPromise = orderedHooks.reduce(
      (chain, [name, entry]) =>
        chain.then(async () => {
          try {
            await entry.hook(context);
          } catch (error) {
            logException(error, '[ShutdownCoordinator] Shutdown hook failed', {
              name,
            });
            if (this.shutdownExitCode === 0) {
              this.shutdownExitCode = 1;
              process.exitCode = this.shutdownExitCode;
            }
          }
        }),
      Promise.resolve()
    );

    const chainTimeoutMs = this.computeHookChainTimeoutMs();
    const timeoutPromise = new Promise<typeof TIMEOUT_RESULT>((resolve) => {
      const timeoutId = setTimeout(
        () => resolve(TIMEOUT_RESULT),
        chainTimeoutMs
      );
      timeoutId.unref?.();
    });

    const result = await Promise.race([
      hooksPromise.then(() => 'completed' as const),
      timeoutPromise,
    ]);

    if (result === TIMEOUT_RESULT) {
      logError('Shutdown hooks timed out', {
        timeout: chainTimeoutMs,
      });
      if (this.shutdownExitCode === 0) {
        this.shutdownExitCode = 1;
        process.exitCode = this.shutdownExitCode;
      }
    }
  }

  /**
   * Hooks run sequentially. Chain budget is the sum of each declared per-hook
   * timeout plus the default safety-net budget, so:
   *   - Non-declaring hooks still share the original default as their group budget.
   *   - Declaring hooks get their exact requested budget, with headroom for
   *     their own cleanup (log/metric emission) before the chain race fires.
   */
  private computeHookChainTimeoutMs(): number {
    const declaredSum = Array.from(this.hooks.values()).reduce(
      (acc, entry) => acc + (entry.timeoutMs ?? 0),
      0
    );
    return declaredSum + SHUTDOWN_HOOK_TIMEOUT_MS;
  }

  private static async runCoreShutdown(): Promise<void> {
    try {
      await cleanupMcpWithTimeout();

      // Flush OTEL customer metrics
      await CustomerMetrics.forceFlush();
      await CustomerMetrics.shutdown();

      // Clean up old temp files (best effort, non-blocking)
      const tempDir = path.join(getIndustryHome(), getIndustryDirName(), 'temp');
      await cleanupOldFiles(tempDir);

      // Close any orphaned agent-browser daemon processes (best effort)
      await cleanupAgentBrowserDaemons();
    } catch (error) {
      logError('[ShutdownCoordinator] Shutdown cleanup failed', { error });
    } finally {
      try {
        // Flush all logs to Sentry and Axiom
        await CliTelemetryClient.getInstance().forceFlush();
        await getSentryAdapter()?.flush();
      } catch (error) {
        if (process.env.INDUSTRY_ENV !== 'production') {
          logException(error, 'Failed to flush logs');
        }
      }
    }
  }
}

const coordinator = new ShutdownCoordinator();

export function initShutdownCoordinator(): void {
  coordinator.registerSignalHandlers();
}

export function getShutdownCoordinator(): ShutdownCoordinator {
  return coordinator;
}
