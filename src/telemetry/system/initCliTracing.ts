/**
 * Owns the global OtelTracing client lifecycle for the CLI process.
 * Replacing the client tears down the previous one (resource attributes
 * are immutable on a tracer provider).
 */

import { SESSION_TAG_MISSION_WORKER } from '@industry/common/session';
import { ServiceName } from '@industry/common/shared';
import { logException, logInfo } from '@industry/logging';
import {
  type Attributes,
  ClientUiSurface,
  OtelTracing,
  SessionKind,
  SpanAttribute,
} from '@industry/logging/tracing';

import { getRuntimeAuthConfig } from '@/environment';
import { CliOtelTracingClient } from '@/telemetry/system/CliOtelTracingClient';
import { classifyStartupProcess } from '@/utils/startupProcess';

enum CliSubcommand {
  Acp = 'acp',
  Daemon = 'daemon',
  Exec = 'exec',
}

interface InitCliTracingParams {
  clientSurface?: ClientUiSurface;
  extraAttributes?: Attributes;
  /** Override service.name. Defaults to ServiceName.CLI; daemon passes ServiceName.Daemon. */
  serviceNameOverride?: ServiceName;
}

let currentClient: CliOtelTracingClient | null = null;

function getArgValue(flagNames: string[]): string | undefined {
  const argv = process.argv.slice(2);

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    for (const flagName of flagNames) {
      if (arg === flagName) {
        return argv[index + 1];
      }

      if (arg.startsWith(`${flagName}=`)) {
        return arg.slice(flagName.length + 1);
      }
    }
  }

  return undefined;
}

function isAcpExecProcess(): boolean {
  const outputFormat = getArgValue(['--output-format', '-o']);
  return outputFormat === 'acp' || outputFormat === 'acp-daemon';
}

/**
 * Returns true when the current process is a headless drool worker spawned by
 * the daemon or TUI (via `drool exec --input-format stream-jsonrpc`) or a
 * subagent child (via `drool exec ... --calling-session-id`). These processes
 * are internal infrastructure, not user-facing client surfaces.
 */
/**
 * Classify the current top-level CLI invocation into a client interaction surface.
 * Returns undefined for daemon mode and headless drool workers because they are
 * not user-facing client surfaces.
 */
export function classifyCliClientSurface(): ClientUiSurface | undefined {
  const processContext = classifyStartupProcess();
  const subcommand = Object.values(CliSubcommand).find(
    (value) => value === processContext.subcommand
  );

  switch (subcommand) {
    case CliSubcommand.Daemon:
      return undefined;
    case CliSubcommand.Exec:
      // Daemon-spawned children and subagents are internal workers, not clients.
      if (processContext.isDroolWorkerProcess) return undefined;
      if (isAcpExecProcess()) return ClientUiSurface.CliAcp;
      return ClientUiSurface.CliExec;
    case CliSubcommand.Acp:
      return ClientUiSurface.CliAcp;
    default:
      return ClientUiSurface.CliTui;
  }
}

/**
 * Classify the session kind for the current CLI process based on argv.
 * Returns the kind for child sessions (subagent, mission_worker) where
 * the spawning context determines the kind. Returns undefined for
 * top-level sessions where kind is derived from origin instead.
 *
 * Mission workers are detected by the `--tag mission-worker` argv pair
 * (set by MissionRunner when spawning workers via exec).
 */
export function classifySessionKind(): SessionKind | undefined {
  const argv = process.argv;
  if (argv.includes(SESSION_TAG_MISSION_WORKER))
    return SessionKind.MissionWorker;
  if (argv.includes('--calling-session-id')) return SessionKind.Subagent;
  return undefined;
}

/**
 * Install (or replace) the global CLI OTel client. No-op if
 * `OTEL_SDK_DISABLED=true`.
 */
export async function initCliTracing({
  clientSurface = classifyCliClientSurface(),
  extraAttributes = {},
  serviceNameOverride,
}: InitCliTracingParams): Promise<void> {
  if (process.env.OTEL_SDK_DISABLED === 'true') return;
  let airgapEnabled = false;
  try {
    airgapEnabled = getRuntimeAuthConfig().airgapEnabled === true;
  } catch {
    // Auth config may not be initialized in some test contexts.
  }
  if (airgapEnabled) {
    logInfo('[initCliTracing] Airgap Mode is enabled; skipping OTEL init');
    return;
  }

  if (currentClient) {
    try {
      await currentClient.shutdown();
    } catch (error) {
      logException(error, '[initCliTracing] Failed to shut down prior client');
    }
    currentClient = null;
  }

  const client = new CliOtelTracingClient({
    enabled: true,
    serviceName: serviceNameOverride ?? ServiceName.CLI,
    extraResourceAttributes: {
      ...(clientSurface && {
        [SpanAttribute.INDUSTRY_CLIENT_SURFACE]: clientSurface,
      }),
      ...extraAttributes,
    },
  });
  OtelTracing.initialize(client);
  currentClient = client;
}
