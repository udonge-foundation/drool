import { spawn } from 'child_process';

import { StatusLineConfig } from '@industry/common/cli';
import { INDUSTRY_ROUTER_MODEL_ID } from '@industry/drool-sdk-ext/protocol/llm';
import { logException, logInfo } from '@industry/logging';

import { getTuiModelConfig } from '@/models/config';
import { getFolderTrustService } from '@/services/FolderTrustService';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import {
  StatusLineContext,
  StatusLineContextUsage,
  StatusLineRuntimeSnapshot,
} from '@/services/types';
import { SYSTEM_PROMPT_TOKENS } from '@/utils/constants';
import { computeContextPercentage } from '@/utils/contextUsage';

const THROTTLE_MS = 300;
const COMMAND_TIMEOUT_MS = 5000;

function buildContextUsage(
  lastTokenUsage: number | null,
  tokenLimit: number
): StatusLineContextUsage | null {
  if (lastTokenUsage === null || lastTokenUsage <= 0) {
    return null;
  }

  const { adjustedUsage, adjustedLimit, percentage, display } =
    computeContextPercentage({
      lastTokenUsage,
      tokenLimit,
      systemPromptTokens: SYSTEM_PROMPT_TOKENS,
    });

  return {
    last_call_compaction_tokens: lastTokenUsage,
    token_limit: tokenLimit,
    adjusted_tokens: adjustedUsage,
    adjusted_limit: adjustedLimit,
    percentage,
    display,
  };
}

export class StatusLineService {
  constructor(
    now: () => number = () => Date.now(),
    spawnCommand: typeof spawn = spawn
  ) {
    this.now = now;
    this.spawnCommand = spawnCommand;
  }

  private readonly now: () => number;

  private readonly spawnCommand: typeof spawn;

  private lastExecutionTime = 0;

  private pendingExecution: Promise<string | null> | null = null;

  private pendingSnapshotKey: string | null = null;

  private queuedExecution: Promise<string | null> | null = null;

  private queuedSnapshot: StatusLineRuntimeSnapshot | null = null;

  private queuedSnapshotKey: string | null = null;

  private cachedResult: string | null = null;

  private cachedSnapshotKey: string | null = null;

  async execute(snapshot: StatusLineRuntimeSnapshot): Promise<string | null> {
    // Folder trust gate (CLI-897): statusLine commands come from merged
    // settings, which can pick up a new (untrusted) project after a
    // mid-session cwd change; suppress execution until the folder is trusted.
    if (getFolderTrustService().isTrustGateActive()) {
      return null;
    }

    const config = getSettingsService().getStatusLine();
    if (!config) {
      return null;
    }

    const snapshotKey = this.buildSnapshotKey(snapshot);
    const now = this.now();
    if (
      now - this.lastExecutionTime < THROTTLE_MS &&
      snapshotKey === this.cachedSnapshotKey
    ) {
      return this.cachedResult;
    }

    if (this.pendingExecution) {
      if (snapshotKey === this.pendingSnapshotKey) {
        return this.pendingExecution;
      }
      this.queuedSnapshot = snapshot;
      this.queuedSnapshotKey = snapshotKey;
      this.queuedExecution ??= this.pendingExecution.then(() =>
        this.executeQueuedSnapshot()
      );
      return this.queuedExecution;
    }

    return this.startExecution(config, snapshot, snapshotKey);
  }

  private async startExecution(
    config: StatusLineConfig,
    snapshot: StatusLineRuntimeSnapshot,
    snapshotKey: string
  ): Promise<string | null> {
    this.lastExecutionTime = this.now();
    this.cachedSnapshotKey = snapshotKey;
    this.pendingExecution = this.executeCommand(config, snapshot);
    this.pendingSnapshotKey = snapshotKey;

    try {
      this.cachedResult = await this.pendingExecution;
      return this.cachedResult;
    } finally {
      this.pendingExecution = null;
      this.pendingSnapshotKey = null;
    }
  }

  private async executeQueuedSnapshot(): Promise<string | null> {
    const snapshot = this.queuedSnapshot;
    const snapshotKey = this.queuedSnapshotKey;
    this.queuedExecution = null;
    this.queuedSnapshot = null;
    this.queuedSnapshotKey = null;

    if (!snapshot || !snapshotKey) {
      return this.cachedResult;
    }

    const config = getSettingsService().getStatusLine();
    if (!config) {
      return null;
    }

    return this.startExecution(config, snapshot, snapshotKey);
  }

  private async executeCommand(
    config: StatusLineConfig,
    snapshot: StatusLineRuntimeSnapshot
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const context = this.buildContext(snapshot);

      const isWindows = process.platform === 'win32';
      const shell = isWindows ? 'cmd.exe' : 'sh';
      const shellArgs = isWindows
        ? ['/c', config.command]
        : ['-c', config.command];

      const child = this.spawnCommand(shell, shellArgs, {
        env: {
          ...process.env,
          INDUSTRY_PROJECT_DIR: context.cwd,
        },
        timeout: COMMAND_TIMEOUT_MS,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let timeoutId: NodeJS.Timeout | null = null;

      timeoutId = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore kill errors
        }
        resolve(null);
      }, COMMAND_TIMEOUT_MS);

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.on('close', (code) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        if (code !== 0 || !stdout) {
          resolve(null);
          return;
        }

        resolve(stdout.trim() || null);
      });

      child.on('error', (error) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        logException(error, '[StatusLine] Command execution failed');
        resolve(null);
      });

      // Handle stdin errors (e.g., EPIPE when command exits without reading)
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') {
          logException(error, '[StatusLine] Stdin error');
        }
      });

      // Write context as JSON to stdin
      child.stdin.write(JSON.stringify(context));
      child.stdin.end();
    });
  }

  private buildContext(snapshot: StatusLineRuntimeSnapshot): StatusLineContext {
    const sessionService = getSessionService();
    const settingsService = getSettingsService();

    // Session-scoped, not global default; must show the user's
    // literal choice ("Auto Model"), not the routed concrete pick.
    const modelId = sessionService.getDisplayModel();
    const reasoningEffort = sessionService.getReasoningEffort();
    const modelConfig = getTuiModelConfig(modelId);

    const sessionId = sessionService.getCurrentSessionId() || '';
    const transcriptPath = sessionService.getSessionTranscriptPath() || '';
    const sessionSettingsPath =
      sessionService.getCurrentSessionSettingsPath() || '';
    const cwd = snapshot.cwd ?? process.cwd();

    // Read effective Auto Model directly to avoid sessionService.getModel()
    // warning on every status refresh for unprimed Auto Model sessions.
    const effectiveIndustryRouter =
      sessionService.getEffectiveIndustryRouterModel();
    const tokenLimit = settingsService.getCompactionTokenLimitForModel(
      modelId === INDUSTRY_ROUTER_MODEL_ID && effectiveIndustryRouter
        ? effectiveIndustryRouter.modelId
        : modelId
    );

    return {
      session_id: sessionId,
      transcript_path: transcriptPath,
      session_settings_path: sessionSettingsPath,
      cwd,
      workspace: {
        current_dir: cwd,
      },
      model: {
        id: modelId,
        display_name: modelConfig.shortDisplayName || modelConfig.displayName,
        reasoning_effort: reasoningEffort,
      },
      context: buildContextUsage(snapshot.lastTokenUsage, tokenLimit),
      version: process.env.CLI_VERSION || 'unknown',
    };
  }

  private buildSnapshotKey(snapshot: StatusLineRuntimeSnapshot): string {
    const sessionService = getSessionService();
    const cwd = snapshot.cwd ?? process.cwd();
    return JSON.stringify({
      sessionId: sessionService.getCurrentSessionId(),
      // Mirror the rendered fields above; reading getModel here would
      // re-render on every Auto Model → concrete re-resolution.
      model: sessionService.getDisplayModel(),
      reasoningEffort: sessionService.getReasoningEffort(),
      cwd,
      tokens: snapshot.lastTokenUsage,
      pr: snapshot.prState,
    });
  }

  clearCache(): void {
    this.cachedResult = null;
    this.lastExecutionTime = 0;
    this.cachedSnapshotKey = null;
    this.pendingSnapshotKey = null;
    this.queuedExecution = null;
    this.queuedSnapshot = null;
    this.queuedSnapshotKey = null;
  }
}

let statusLineServiceInstance: StatusLineService | null = null;

export function getStatusLineService(): StatusLineService {
  if (!statusLineServiceInstance) {
    statusLineServiceInstance = new StatusLineService();
    logInfo('[StatusLineService] Initialized');
  }
  return statusLineServiceInstance;
}
