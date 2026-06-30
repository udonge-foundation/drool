import { once } from 'lodash-es';

import type { WorktreeSessionInfo } from '@industry/utils/git';

/**
 * ExecRuntimeConfigService holds per-run execution constraints for `drool exec` when
 * routed through the TUI path. These settings are ephemeral and should be set
 * by the CLI wiring prior to running the agent, and reset/ignored afterward.
 */
class ExecRuntimeConfigService {
  private allowedToolIds: Set<string> | null = null;

  private skipAllConfirmations = false;

  private subAgentsV2Enabled = false;

  // Recursion depth for subagent spawning (0 = top-level, 1 = first subagent, etc.)
  private depth = 0;

  private worktreeInfo: WorktreeSessionInfo | null = null;

  private appendSystemPrompt: string | null = null;

  setAllowedToolIds(ids: string[] | null): void {
    this.allowedToolIds = Array.isArray(ids) ? new Set(ids) : null;
  }

  getAllowedToolIds(): Set<string> | null {
    return this.allowedToolIds;
  }

  setSkipAllConfirmations(enabled: boolean): void {
    this.skipAllConfirmations = !!enabled;
  }

  getSkipAllConfirmations(): boolean {
    return this.skipAllConfirmations;
  }

  setSubAgentsV2Enabled(enabled: boolean): void {
    this.subAgentsV2Enabled = enabled;
  }

  isSubAgentsV2Enabled(): boolean {
    return this.subAgentsV2Enabled;
  }

  setDepth(depth: number): void {
    this.depth = depth;
  }

  getDepth(): number {
    return this.depth;
  }

  setWorktreeInfo(info: WorktreeSessionInfo | null): void {
    this.worktreeInfo = info;
  }

  getWorktreeInfo(): WorktreeSessionInfo | null {
    return this.worktreeInfo;
  }

  setAppendSystemPrompt(text: string | null): void {
    this.appendSystemPrompt = text;
  }

  getAppendSystemPrompt(): string | null {
    return this.appendSystemPrompt;
  }

  reset(): void {
    this.allowedToolIds = null;
    this.skipAllConfirmations = false;
    this.subAgentsV2Enabled = false;
    this.depth = 0;
    this.worktreeInfo = null;
    this.appendSystemPrompt = null;
  }
}

export const getExecRuntimeConfig = once(() => new ExecRuntimeConfigService());
