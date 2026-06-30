/**
 * SandboxService — singleton service managing OS-level sandbox for the Drool CLI.
 *
 * Reads sandbox settings from the resolved settings hierarchy, creates and
 * manages a DroolSandboxManager, and exposes a public API for tool executors.
 *
 * Initialization distinguishes policy-disabled from sandbox-unavailable. If
 * sandboxing is enabled but SRT/runtime setup fails, the service remains enabled
 * and fail-closes side-effect checks rather than continuing unsandboxed.
 */

import {
  SandboxOperationType,
  SandboxViolationType,
  type SandboxStatus,
} from '@industry/drool-sdk-ext/protocol/drool';
import { SandboxMode } from '@industry/drool-sdk-ext/protocol/settings';
import { logInfo, logWarn } from '@industry/logging';

import { buildSandboxConfig } from '@/sandbox/buildSandboxConfig';
import { DROOL_SANDBOXED_ENV } from '@/sandbox/constants';
import { DroolSandboxManager } from '@/sandbox/DroolSandboxManager';
import type { SandboxViolation } from '@/sandbox/types';
import { isValidatedWholeProcessSandboxChild } from '@/sandbox/wholeProcessSandbox';

import type { SandboxSettings } from '@industry/common/settings';

// =============================================================================
// SandboxService
// =============================================================================

export class SandboxService {
  private manager: DroolSandboxManager | null = null;

  private initialized = false;

  private enabled = false;

  private mode: SandboxMode | null = null;

  private unavailableReason: string | null = null;

  private savedAskCallback?: (params: {
    host: string;
    port: number | undefined;
  }) => Promise<boolean>;

  /**
   * Initialize the sandbox service from resolved sandbox settings.
   *
   * @param settings - The resolved sandbox settings (from settings.general.sandbox).
   *                   Pass undefined/null to skip sandbox entirely.
   * @param sandboxAskCallback - Optional callback for SRT domain prompts during Execute.
   *                             Called when SRT's proxy encounters an unknown domain.
   */
  async initialize(
    settings: SandboxSettings | undefined | null,
    sandboxAskCallback?: (params: {
      host: string;
      port: number | undefined;
    }) => Promise<boolean>
  ): Promise<void> {
    if (sandboxAskCallback) {
      this.savedAskCallback = sandboxAskCallback;
    }

    // Skip if no settings or not enabled
    if (!settings?.enabled) {
      logInfo('[SandboxService] Sandbox not enabled, skipping initialization');
      this.manager = null;
      this.enabled = false;
      this.initialized = false;
      this.mode = null;
      this.unavailableReason = null;
      return;
    }

    if (settings.mode === SandboxMode.WholeProcess) {
      if (
        await isValidatedWholeProcessSandboxChild(process.env, {}, settings)
      ) {
        const config = buildSandboxConfig(settings);
        const manager = new DroolSandboxManager();
        manager.activateAlreadySandboxed(config);
        this.manager = manager;
        this.enabled = true;
        this.mode = SandboxMode.WholeProcess;
        this.initialized = true;
        logInfo('[SandboxService] Initialized in whole-process sandbox child', {
          state: this.mode,
          isEnabled: this.enabled,
        });
        return;
      }

      if (process.env[DROOL_SANDBOXED_ENV] === '1') {
        throw new Error(
          'Invalid whole-process sandbox recursion guard. Refusing to continue with spoofed sandbox state.'
        );
      }

      throw new Error(
        'Whole-process sandbox was requested but this process was not started by the sandbox supervisor.'
      );
    }

    try {
      const manager = new DroolSandboxManager();
      const config = buildSandboxConfig(settings);

      // Check if already sandboxed (belt-and-suspenders check via manager)
      if (
        process.env[DROOL_SANDBOXED_ENV] === '1' ||
        manager.isAlreadySandboxed()
      ) {
        manager.initializePolicyOnly(config);
        this.manager = manager;
        this.enabled = true;
        this.mode = settings.mode ?? SandboxMode.PerCommand;
        this.initialized = true;
        this.unavailableReason = null;
        logInfo(
          '[SandboxService] Inherited sandbox detected; initialized policy-only sandbox checks',
          {
            state: this.mode,
            isEnabled: this.enabled,
          }
        );
        return;
      }

      // Initialize the manager (starts SRT proxies, optionally with domain ask callback)
      await manager.initialize(config, undefined, sandboxAskCallback);

      this.manager = manager;
      this.enabled = true;
      this.mode = settings.mode ?? SandboxMode.PerCommand;
      this.initialized = true;
      this.unavailableReason = null;

      if (!manager.isActive()) {
        this.manager = null;
        this.unavailableReason = 'sandbox runtime did not become active';
        logWarn('[SandboxService] Sandbox runtime unavailable after startup', {
          cause: this.unavailableReason,
        });
        return;
      }

      logInfo('[SandboxService] Initialized successfully', {
        state: this.mode,
        isEnabled: this.enabled,
      });
    } catch (error) {
      // Non-fatal to process startup, but fail-closed for side-effecting work.
      logWarn(
        '[SandboxService] Failed to initialize sandbox — sandbox-required work will fail closed',
        {
          cause: error instanceof Error ? error.message : String(error),
        }
      );
      this.manager = null;
      this.enabled = true;
      this.mode = settings.mode ?? SandboxMode.PerCommand;
      this.initialized = true;
      this.unavailableReason =
        error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Reinitialize the sandbox with updated settings, preserving the ask callback.
   * Called after org settings reload to apply new policies.
   */
  async reinitialize(
    settings: SandboxSettings | undefined | null
  ): Promise<void> {
    // Shut down the existing manager (including the SRT process-wide singleton)
    // before re-creating so updated org policies are actually applied.
    if (this.manager) {
      await this.manager.shutdown();
    }
    this.manager = null;
    this.enabled = false;
    this.initialized = false;
    this.mode = null;
    this.unavailableReason = null;

    await this.initialize(settings, this.savedAskCallback);
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Whether sandbox policy is enabled. If true while runtime is unavailable,
   * side-effecting operations fail closed.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Get the current sandbox mode, or null if not initialized.
   */
  getMode(): SandboxMode | null {
    if (!this.initialized) return null;
    return this.mode;
  }

  getStatus(): SandboxStatus {
    return {
      enabled: this.isEnabled(),
      mode: this.getMode() ?? undefined,
    };
  }

  private isUnavailable(): boolean {
    return this.enabled && !this.manager;
  }

  private getUnavailableMessage(operation: string): string {
    const reason = this.unavailableReason ?? 'sandbox runtime is unavailable';
    return `Sandbox unavailable: ${reason}; refusing ${operation} without sandbox protection`;
  }

  private makeUnavailableFileViolation(
    filePath: string,
    operation: SandboxOperationType.Read | SandboxOperationType.Write
  ): SandboxViolation {
    return {
      type:
        operation === SandboxOperationType.Read
          ? SandboxViolationType.FilesystemRead
          : SandboxViolationType.FilesystemWrite,
      path: filePath,
      operation,
      message: this.getUnavailableMessage(`${operation} access to ${filePath}`),
      timestamp: Date.now(),
      promptable: false,
    };
  }

  private makeUnavailableNetworkViolation(url: string): SandboxViolation {
    let domain = url;
    try {
      domain = new URL(url).hostname;
    } catch {
      // Keep the original URL-ish value for malformed inputs.
    }
    return {
      type: SandboxViolationType.Network,
      domain,
      operation: SandboxOperationType.Network,
      message: this.getUnavailableMessage(`network access to ${domain}`),
      timestamp: Date.now(),
      promptable: false,
    };
  }

  /**
   * Check if a file access operation is allowed.
   * Returns a SandboxViolation if blocked, null if allowed.
   * Returns a non-promptable violation if sandboxing is required but unavailable.
   */
  checkFileAccess(
    filePath: string,
    operation: SandboxOperationType.Read | SandboxOperationType.Write
  ): SandboxViolation | null {
    if (this.isUnavailable()) {
      return this.makeUnavailableFileViolation(filePath, operation);
    }
    if (!this.manager) return null;
    try {
      return this.manager.checkFileAccess(filePath, operation);
    } catch (error) {
      this.unavailableReason =
        error instanceof Error ? error.message : String(error);
      this.manager = null;
      return this.makeUnavailableFileViolation(filePath, operation);
    }
  }

  /**
   * Check if network access to a URL is allowed.
   * Returns a SandboxViolation if blocked, null if allowed.
   * Returns a non-promptable violation if sandboxing is required but unavailable.
   */
  checkNetworkAccess(url: string): SandboxViolation | null {
    if (this.isUnavailable()) {
      return this.makeUnavailableNetworkViolation(url);
    }
    if (!this.manager) return null;
    try {
      return this.manager.checkNetworkAccess(url);
    } catch (error) {
      this.unavailableReason =
        error instanceof Error ? error.message : String(error);
      this.manager = null;
      return this.makeUnavailableNetworkViolation(url);
    }
  }

  /**
   * Wrap a command with OS-level sandbox restrictions.
   * Throws if sandboxing is required but unavailable.
   */
  async wrapCommand(command: string): Promise<string> {
    if (this.isUnavailable()) {
      throw new Error(this.getUnavailableMessage('command execution'));
    }
    if (!this.manager) return command;
    return this.manager.wrapCommand(command);
  }

  /**
   * Get proxy environment variables for child processes.
   * Returns HTTP_PROXY and HTTPS_PROXY pointing to SRT's localhost proxy.
   * Returns an empty record if sandbox is not initialized or no proxy port is configured.
   */
  getProxyEnv(): Record<string, string> {
    if (!this.manager) return {};
    return this.manager.getProxyEnv();
  }

  /**
   * Return the effective sandbox settings snapshot used for child processes.
   * Returns null when sandboxing is disabled or unavailable so callers can
   * fail closed instead of launching side-effecting children unsandboxed.
   */
  getSandboxSettingsSnapshot(): SandboxSettings | null {
    if (!this.enabled || !this.manager) return null;
    const snapshot = this.manager.getSandboxSettingsSnapshot();
    if (!snapshot) return null;
    return {
      ...snapshot,
      mode: this.getMode() ?? snapshot.mode,
    };
  }

  /**
   * Get denyRead paths that are subtrees of the given root path.
   * Used by Grep/Glob to exclude denied directories from recursive searches.
   * Returns relative paths suitable for ripgrep --glob exclusions.
   */
  getDenyReadSubtrees(rootPath: string): string[] {
    if (!this.manager) return [];
    return this.manager.getDenyReadSubtrees(rootPath);
  }

  /**
   * Get both deny exclusions and allowRead re-includes for a root path.
   * Resolves the path once, avoiding duplicate realpathSync syscalls.
   */
  getReadSubtreeGlobs(rootPath: string): {
    deny: string[];
    allow: string[];
  } {
    if (!this.manager) return { deny: [], allow: [] };
    return this.manager.getReadSubtreeGlobs(rootPath);
  }

  /**
   * Get all recorded violations.
   * Returns empty array if sandbox is not initialized.
   */
  getViolations(): SandboxViolation[] {
    if (!this.manager) return [];
    return this.manager.getViolations();
  }

  /**
   * Clear all recorded violations.
   * No-op if sandbox is not initialized.
   */
  clearViolations(): void {
    if (!this.manager) return;
    this.manager.clearViolations();
  }

  /**
   * Add a domain to the allowed domains list at runtime.
   * No-op if sandbox is not initialized.
   */
  async allowDomain(domain: string): Promise<void> {
    if (!this.manager) return;
    return this.manager.allowDomain(domain);
  }

  /**
   * Add a directory to the allowWrite list at runtime.
   * Used by "Allow always" for file write violations.
   * No-op if sandbox is not initialized.
   */
  async addAllowWritePath(dirPath: string): Promise<void> {
    if (!this.manager) return;
    return this.manager.addAllowWritePath(dirPath);
  }

  /**
   * Remove a path from the denyWrite list at runtime.
   * Used by "Remove from deny list" for denyWrite violations.
   * No-op if sandbox is not initialized.
   */
  async removeDenyWritePath(filePath: string): Promise<void> {
    if (!this.manager) return;
    return this.manager.removeDenyWritePath(filePath);
  }

  /**
   * Add a path to the allowRead list at runtime.
   * Used by "Allow always" for read violations inside denied regions.
   * No-op if sandbox is not initialized.
   */
  async addAllowReadPath(dirPath: string): Promise<void> {
    if (!this.manager) return;
    return this.manager.addAllowReadPath(dirPath);
  }

  /**
   * Get allowRead paths that are subtrees of the given root path.
   * Used by Grep/Glob to re-include allowed paths within denied directories.
   * Returns relative paths suitable for ripgrep --glob re-includes.
   */
  getAllowReadSubtrees(rootPath: string): string[] {
    if (!this.manager) return [];
    return this.manager.getAllowReadSubtrees(rootPath);
  }

  /**
   * Shut down the sandbox manager and clean up resources.
   * No-op if sandbox is not initialized.
   */
  async shutdown(): Promise<void> {
    if (this.manager) {
      await this.manager.shutdown();
    }
    this.manager = null;
    this.enabled = false;
    this.initialized = false;
    this.mode = null;
    this.unavailableReason = null;
  }
}

// =============================================================================
// Singleton
// =============================================================================

let sandboxServiceInstance: SandboxService | null = null;

/**
 * Get the SandboxService singleton. Creates the instance on first call.
 * The service must be initialized via `initialize()` before use.
 */
export function getSandboxService(): SandboxService {
  if (!sandboxServiceInstance) {
    sandboxServiceInstance = new SandboxService();
  }
  return sandboxServiceInstance;
}

/**
 * Reset the singleton for testing purposes.
 */
export function resetSandboxServiceForTesting(): void {
  sandboxServiceInstance = null;
}
