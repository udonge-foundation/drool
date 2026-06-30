/**
 * FolderTrustService
 *
 * Decides whether the folder Drool was opened in is trusted, and persists
 * trust decisions (CLI-897). Untrusted folders must not get their
 * project-sourced hooks executed; the interactive TUI shows a trust prompt
 * before any project config is allowed to run.
 *
 * SECURITY: trust state is read exclusively from USER-level settings
 * (~/.industry/settings.json). It must never be read from resolved/merged
 * settings, because project-level settings.json is attacker-controlled in
 * the threat model this service exists for (a cloned repository must not be
 * able to self-trust).
 */
import * as path from 'path';

import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { logInfo, logWarn } from '@industry/logging';
import { getFlag } from '@industry/runtime/feature-flags';
import {
  isPathEqualOrDescendant,
  SettingsManager,
} from '@industry/runtime/settings';
import { resolveSandboxPath } from '@industry/utils/settings/sandbox-paths';
import { findGitRoot } from '@industry/utils/shell/node';

import { getSettingsService } from '@/services/SettingsService';

import type {
  TrustedFolderEntry,
  TrustedFolders,
} from '@industry/common/settings';

interface FolderTrustDeps {
  getUserTrustedFolders: () => TrustedFolders | undefined;
  persistUserTrustedFolders: (trustedFolders: TrustedFolders) => Promise<void>;
  /** The discovered project .industry path (or null when none, e.g. home dir) */
  getProjectPath: () => string | null;
  getCwd: () => string;
  /** Enclosing git root for an arbitrary directory (or null when none) */
  findGitRootForPath: (dir: string) => string | null;
  isFeatureEnabled: () => boolean;
}

function defaultDeps(): FolderTrustDeps {
  return {
    getUserTrustedFolders: () => getSettingsService().getUserTrustedFolders(),
    persistUserTrustedFolders: (trustedFolders) =>
      getSettingsService().updateUserTrustedFolders(trustedFolders),
    getProjectPath: () => SettingsManager.getInstance().getProjectPath(),
    getCwd: () => process.cwd(),
    findGitRootForPath: (dir) => findGitRoot(dir),
    isFeatureEnabled: () => getFlag(IndustryFeatureFlags.FolderTrustPrompt),
  };
}

export class FolderTrustService {
  private readonly deps: FolderTrustDeps;

  /**
   * Set by the interactive TUI entrypoint. The trust gate only applies to
   * interactive runs: non-interactive modes (exec, ACP, daemon-spawned
   * runners) cannot prompt and keep their existing behavior, and the drool
   * child the TUI spawns is only created after trust has been resolved.
   */
  private interactiveTui = false;

  constructor(deps: FolderTrustDeps = defaultDeps()) {
    this.deps = deps;
  }

  setInteractiveTuiContext(interactive: boolean): void {
    this.interactiveTui = interactive;
  }

  /**
   * The folder a trust decision applies to: the parent of the discovered
   * project .industry directory (git root, or cwd outside git), falling back
   * to cwd when there is no project path at all (home dir). The home dir
   * loads no project-level config, but its contents are still untrusted
   * input, so it gets prompted like any other folder. Canonicalized through
   * realpath so symlinked paths (e.g. macOS /tmp) compare and persist
   * stably.
   */
  getTrustRoot(): string {
    const projectPath = this.deps.getProjectPath();
    const root = projectPath ? path.dirname(projectPath) : this.deps.getCwd();
    return this.canonicalize(root);
  }

  /**
   * The trust root a folder WOULD have if the process cwd were `dir`:
   * its enclosing git root when one exists, otherwise the folder itself.
   * Used to evaluate trust for a target directory before chdir (e.g. /cwd),
   * without mutating SettingsManager path discovery.
   */
  getTrustRootForPath(dir: string): string {
    return this.canonicalize(this.deps.findGitRootForPath(dir) ?? dir);
  }

  private canonicalize(root: string): string {
    try {
      return resolveSandboxPath({ rawPath: root });
    } catch (error) {
      logWarn('[FolderTrust] Failed to canonicalize trust root', {
        cause: error,
      });
      return root;
    }
  }

  /**
   * A folder is trusted when the trust root equals, or is a descendant of,
   * any persisted trusted folder.
   */
  isCurrentFolderTrusted(): boolean {
    return this.isTrustedRoot(this.getTrustRoot());
  }

  private isTrustedRoot(trustRoot: string): boolean {
    const trustedFolders = this.deps.getUserTrustedFolders();
    if (!trustedFolders) return false;

    return Object.keys(trustedFolders).some((trustedPath) =>
      isPathEqualOrDescendant(trustRoot, trustedPath)
    );
  }

  /**
   * Whether the interactive TUI must show the trust prompt before letting
   * project-sourced config execute.
   */
  needsTrustPrompt(): boolean {
    if (!this.deps.isFeatureEnabled() || !this.interactiveTui) return false;
    return !this.isTrustedRoot(this.getTrustRoot());
  }

  /**
   * Whether changing the session cwd to `dir` requires a trust confirmation
   * first. Mirrors needsTrustPrompt() but evaluates the target directory
   * instead of the current one, so /cwd can prompt BEFORE chdir and the
   * daemon child respawn pick up the untrusted folder's project config.
   */
  needsTrustPromptForPath(dir: string): boolean {
    if (!this.deps.isFeatureEnabled() || !this.interactiveTui) return false;
    return !this.isTrustedRoot(this.getTrustRootForPath(dir));
  }

  /**
   * Whether hook execution must be suppressed right now. Used as a
   * defense-in-depth guard at the HookService choke point: resume/fork
   * flows load sessions (and would run SessionStart hooks) before the
   * trust prompt can render.
   */
  isTrustGateActive(): boolean {
    return this.needsTrustPrompt();
  }

  /**
   * Persist trust for the current trust root. Writes the full map via the
   * serialized user-level settings write path.
   */
  async trustCurrentFolder(): Promise<void> {
    await this.trustRoot(this.getTrustRoot());
  }

  /**
   * Persist trust for the trust root of a target directory (see
   * getTrustRootForPath). Used by /cwd after the user confirms.
   */
  async trustFolderForPath(dir: string): Promise<void> {
    await this.trustRoot(this.getTrustRootForPath(dir));
  }

  private async trustRoot(trustRoot: string): Promise<void> {
    const existing = this.deps.getUserTrustedFolders() ?? {};
    const entry: TrustedFolderEntry = {
      trustedAt: new Date().toISOString(),
    };
    await this.deps.persistUserTrustedFolders({
      ...existing,
      [trustRoot]: entry,
    });

    logInfo('[FolderTrust] Folder trusted');
  }
}

// =============================================================================
// Singleton instance getter
// =============================================================================

let instance: FolderTrustService | undefined;

export function getFolderTrustService(): FolderTrustService {
  if (!instance) {
    instance = new FolderTrustService();
  }
  return instance;
}
