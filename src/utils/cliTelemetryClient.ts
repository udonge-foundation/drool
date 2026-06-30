// IMPORTANT: THIS IS A LOW LEVEL CLASS. DO NOT CALL METRICS OR LOG HERE OR IT WILL RECURSIVELY CALL ITSELF FOREVER

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { ClientType, DroolMode, DroolSubMode } from '@industry/common/shared';
import { EnvironmentVariable } from '@industry/environment';
import {
  setLogToConsole,
  getSentryAdapter,
  isSentryEnabled,
} from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { NodeTelemetryClient } from '@industry/logging/node';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { getEnv, getRuntimeAuthConfig } from '@/environment';
import { ClientMode } from '@/utils/enums';
import { classifyStartupProcess } from '@/utils/startupProcess';
import { getTerminalInfo } from '@/utils/terminalInfo';
import type { StartupProcessContext } from '@/utils/types';

interface CliTelemetryClientConfig {
  deploymentEnv: string;
  logFilePath: string;
}

// Pluggable accessor for the current Industry tier. Wired from the CLI
// entry point (apps/cli/src/index.ts) so this module does not statically
// import `@industry/runtime/settings` — that would pull `chokidar` and
// path-scurry into every transitive consumer's module graph and break
// Vitest ESM mocks of `fs/promises` in tests that don't expect those
// transitive deps.
let industryTierProvider: (() => string | null) | null = null;

export function setIndustryTierProvider(
  provider: (() => string | null) | null
): void {
  industryTierProvider = provider;
}

// Pluggable accessor for the active mission id. Wired from the CLI entry
// points so this module does not statically import SessionService. Returns
// null outside mission-role (orchestrator/worker) sessions; in that case we
// OMIT the `missionId` tag entirely.
let missionIdProvider: (() => string | null) | null = null;

export function setMissionIdProvider(
  provider: (() => string | null) | null
): void {
  missionIdProvider = provider;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ONLY USE console.log() to log messages in this class
export class CliTelemetryClient extends NodeTelemetryClient {
  // Module-level singleton instance (shadows base class instance)
  // eslint-disable-next-line no-use-before-define
  protected static override instance: CliTelemetryClient | null = null;

  // Current sessionId provided by SessionService
  private currentSessionId: string | null = null;

  private currentLogGroupId: string | null = null;

  private clientMode: ClientMode | undefined = undefined;

  private droolMode: DroolMode | null = null;

  private droolSubMode: DroolSubMode | string | null = null;

  private requestId: string | null = null;

  // Current modelId for the active agent session (shared across all instances)
  private currentModelId: string | null = null;

  private currentCompactionReason: string | null = null;

  private currentMachineId: string | null = null;

  private currentMachineType: string | null = null;

  // Persistent random ID for correlating startup logs emitted before org/session tags exist.
  private readonly droolInstallationId: string;

  private readonly startupProcessContext: StartupProcessContext;

  private readonly deploymentEnv: string;

  constructor(config: CliTelemetryClientConfig) {
    const logFilePath = config.logFilePath;
    const extras = getEnv().extras;

    super({
      clientPlatform: 'cli',
      clientPath: 'cli',
      maxEventsPerFlush: 1000,
      logFilePath,
      logRotationMaxBytesPerFragment: extras.logRotationMaxBytesPerFragment,
      logRotationMaxDays: extras.logRotationMaxDays,
      logRotationMaxTotalBytes: extras.logRotationMaxTotalBytes,
      logRotationOnError: (error) => {
        void CliTelemetryClient.instance?.addMetric_INTERNAL_USE_ONLY(
          'cli.log_rotation.error',
          1,
          { operation: error.syscall, errorCode: error.code }
        );
      },
      isWebTelemetryDisabled: () => {
        try {
          return getRuntimeAuthConfig().airgapEnabled === true;
        } catch {
          return false;
        }
      },
    });

    this.deploymentEnv = config.deploymentEnv;
    this.droolInstallationId = CliTelemetryClient.resolveDroolInstallationId();
    this.startupProcessContext = classifyStartupProcess();
  }

  /**
   * Get CLI-specific tags
   * Overrides NodeTelemetryClient.getAdditionalTags()
   */
  protected getAdditionalTags(): Record<string, string> {
    const tags: Record<string, string> = {};

    // Client type & platform & version tags
    tags.clientType = ClientType.CLI;
    tags.platform = process.platform;
    tags.environment = this.deploymentEnv;
    if (process.env.CLI_VERSION) tags.version = process.env.CLI_VERSION;

    const osName = this.getOsName();
    if (osName) tags.os = osName;

    const termInfo = getTerminalInfo();
    if (termInfo.name) tags.terminal = termInfo.name;
    if (termInfo.version) tags.terminalVersion = termInfo.version;

    // Client mode tag
    if (this.clientMode) tags.clientMode = this.clientMode;

    // Drool mode tags
    if (this.droolMode) tags.droolMode = this.droolMode;
    if (this.droolSubMode) tags.droolSubMode = this.droolSubMode;

    // Session and context tags
    if (this.currentSessionId) tags.sessionId = this.currentSessionId;
    if (this.currentLogGroupId) tags.logGroupId = this.currentLogGroupId;
    if (this.requestId) tags.requestId = this.requestId;
    if (this.startupProcessContext.subcommand) {
      tags.subcommand = this.startupProcessContext.subcommand;
    }
    tags.isDroolExec = String(this.startupProcessContext.isDroolExec);
    if (this.startupProcessContext.inputFormat) {
      tags.inputFormat = this.startupProcessContext.inputFormat;
    }
    if (this.startupProcessContext.outputFormat) {
      tags.outputFormat = this.startupProcessContext.outputFormat;
    }
    if (this.startupProcessContext.droolExecRunType) {
      tags.droolExecRunType = this.startupProcessContext.droolExecRunType;
    }
    tags.isStreamJsonRpcWorker = String(
      this.startupProcessContext.isStreamJsonRpcWorker
    );
    tags.callingSessionIdPresent = String(
      this.startupProcessContext.callingSessionIdPresent
    );
    tags.isInteractiveTty = String(this.startupProcessContext.isInteractiveTty);

    // Model and compaction context tags (static, shared across instances)
    if (this.currentModelId) {
      tags.modelId = this.currentModelId;
      tags.isByok = this.currentModelId.startsWith('custom:')
        ? 'true'
        : 'false';
    }

    // Machine context tags
    if (this.currentMachineId) tags.machineId = this.currentMachineId;
    if (this.currentMachineType) tags.machineType = this.currentMachineType;
    if (this.droolInstallationId) {
      tags.droolInstallationId = this.droolInstallationId;
    }

    if (this.currentCompactionReason) {
      tags.compactionReason = this.currentCompactionReason;
    }

    // Ambient `industryTier` tag sourced via the pluggable provider. Returns
    // null until the entry point has wired it up and managed-settings have
    // been fetched; in that case we OMIT the key entirely (per validation
    // contract — never emit placeholder strings like 'null'/'undefined'/
    // 'unknown' which would bloat tag cardinality). Wrapped in try/catch
    // because the provider may throw if SettingsManager is not initialized
    // yet (we must not throw out of getAdditionalTags since it runs on every
    // telemetry event).
    if (industryTierProvider) {
      try {
        const tier = industryTierProvider();
        if (tier) {
          tags.industryTier = tier;
        }
      } catch {
        // Settings not available yet — omit industryTier rather than risking
        // recursive logging (this class must never call logging utilities).
      }
    }

    // Ambient `missionId` tag sourced via the pluggable provider so every
    // telemetry event emitted inside a mission-role session carries it,
    // rather than relying on each call site to pass it explicitly. Returns
    // null outside mission sessions; in that case we OMIT the key entirely.
    // Wrapped in try/catch for the same reasons as industryTier above.
    if (missionIdProvider) {
      try {
        const missionId = missionIdProvider();
        if (missionId) {
          tags.missionId = missionId;
        }
      } catch {
        // Session service not available yet — omit missionId rather than
        // risking recursive logging (this class must never call logging).
      }
    }

    return tags;
  }

  public setClientMode(clientMode: ClientMode): void {
    this.clientMode = clientMode;
    if (isSentryEnabled()) {
      const adapter = getSentryAdapter();
      adapter?.setTag('clientMode', clientMode);
    }
  }

  public setDroolMode(
    mode: DroolMode,
    subMode?: DroolSubMode | string | null
  ): void {
    this.droolMode = mode;
    this.droolSubMode = subMode ?? null;
    if (isSentryEnabled()) {
      const adapter = getSentryAdapter();
      adapter?.setTag('droolMode', mode);
      if (subMode) {
        adapter?.setTag('droolSubMode', subMode);
      }
    }
  }

  /**
   * Allows other modules (e.g. SessionService) to update the active sessionId
   * so that subsequent telemetry events include it in their tags.
   */
  public setSessionId(sessionId: string | null): void {
    this.currentSessionId = sessionId;
    if (isSentryEnabled() && sessionId) {
      const adapter = getSentryAdapter();
      adapter?.setTag('sessionId', sessionId);
    }
  }

  /**
   * Allows setting a log group ID for filtering logs across multiple sessions
   * (e.g., for benchmark runs).
   */
  public setLogGroupId(logGroupId: string | null): void {
    this.currentLogGroupId = logGroupId;
    if (isSentryEnabled() && logGroupId) {
      const adapter = getSentryAdapter();
      adapter?.setTag('logGroupId', logGroupId);
    }
  }

  public setRequestId(requestId: string | null): void {
    this.requestId = requestId;
    if (isSentryEnabled() && requestId) {
      const adapter = getSentryAdapter();
      adapter?.setTag('droolRequestId', requestId);
    }
  }

  /**
   * Sets the current model ID for tracking in all telemetry events.
   * This is static state shared across all CLI telemetry instances.
   */
  public setModelId(modelId: string | null): void {
    this.currentModelId = modelId;
    if (isSentryEnabled()) {
      const adapter = getSentryAdapter();
      if (modelId) {
        adapter?.setTag('modelId', modelId);
        // Also tag whether it's a BYOK model
        adapter?.setTag(
          'isByok',
          modelId.startsWith('custom:') ? 'true' : 'false'
        );
      } else {
        // Best-effort: Sentry does not support un-setting tags explicitly; use sentinel values
        adapter?.setTag('modelId', 'none');
        adapter?.setTag('isByok', 'none');
      }
    }
  }

  public setMachineContext(machineId: string, machineType: string): void {
    this.currentMachineId = machineId;
    this.currentMachineType = machineType;
    if (isSentryEnabled()) {
      const adapter = getSentryAdapter();
      adapter?.setTag('machineId', machineId);
      adapter?.setTag('machineType', machineType);
    }
  }

  /**
   * Set a compaction reason context so all subsequent telemetry events are tagged while active.
   * Call clearCompactionReason() in a finally block to avoid leaking context across operations.
   */
  public setCompactionReason(reason: string | null): void {
    this.currentCompactionReason = reason;
    if (isSentryEnabled() && reason) {
      const adapter = getSentryAdapter();
      adapter?.setTag('compactionReason', reason);
    }
  }

  /**
   * Clear the compaction reason context.
   */
  public clearCompactionReason(): void {
    this.currentCompactionReason = null;
    if (isSentryEnabled()) {
      const adapter = getSentryAdapter();
      // Best-effort: Sentry does not support un-setting tags explicitly; setting to 'none'.
      adapter?.setTag('compactionReason', 'none');
    }
  }

  /*
   * Get the singleton instance
   */
  public static getInstance(): CliTelemetryClient {
    if (!CliTelemetryClient.instance) {
      throw new MetaError(
        'CLI telemetry client not initialized. Call CliTelemetryClient.initializeSync() first.'
      );
    }
    return CliTelemetryClient.instance;
  }

  /**
   * Synchronously initialize the logging system at module load time
   * This ensures telemetry client is ready before any other code runs
   */
  public static initializeSync(): void {
    if (CliTelemetryClient.instance) {
      return; // Already initialized
    }

    // Allow overriding the log file path via env var
    const envLogFile = process.env[EnvironmentVariable.INDUSTRY_LOG_FILE];
    let logFilePath: string;

    if (envLogFile) {
      logFilePath = path.resolve(envLogFile);
      const logsDir = path.dirname(logFilePath);
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
    } else {
      const industryDir = path.join(getIndustryHome(), getIndustryDirName());
      const logsDir = path.join(industryDir, 'logs');
      logFilePath = path.join(logsDir, 'drool-log-single.log');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
    }

    // Create telemetry client instance (constructor is already synchronous)
    CliTelemetryClient.instance = new CliTelemetryClient({
      deploymentEnv: getEnv().deploymentEnv,
      logFilePath,
    });

    // Route logs through the telemetry client's sink
    setLogToConsole(CliTelemetryClient.instance.getLogFunction());
  }

  private static isValidDroolInstallationId(
    value: string | undefined
  ): value is string {
    return typeof value === 'string' && UUID_RE.test(value.trim());
  }

  private static getDroolInstallationIdPath(): string {
    return path.join(
      getIndustryHome(),
      getIndustryDirName(),
      'telemetry',
      'drool-installation-id'
    );
  }

  private static shouldPersistDroolInstallationId(): boolean {
    return (
      process.env[EnvironmentVariable.NODE_ENV] !== 'test' ||
      Boolean(process.env.INDUSTRY_HOME_OVERRIDE)
    );
  }

  private static resolveDroolInstallationId(): string {
    if (!CliTelemetryClient.shouldPersistDroolInstallationId()) {
      return randomUUID();
    }

    const filePath = CliTelemetryClient.getDroolInstallationIdPath();
    try {
      const fileId = fs.readFileSync(filePath, 'utf8').trim();
      if (CliTelemetryClient.isValidDroolInstallationId(fileId)) {
        return fileId;
      }
    } catch {
      // Missing or unreadable ID falls through to generation.
    }

    const id = randomUUID();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(filePath, `${id}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } catch {
      try {
        const fileId = fs.readFileSync(filePath, 'utf8').trim();
        if (CliTelemetryClient.isValidDroolInstallationId(fileId)) {
          return fileId;
        }
      } catch {
        // Best effort: telemetry still gets a process-local ID.
      }
    }
    return id;
  }
}
