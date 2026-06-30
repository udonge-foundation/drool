/**
 * DroolSandboxManager wraps @anthropic-ai/sandbox-runtime (SRT) to provide
 * application-level file/network access checks and OS-level command sandboxing
 * for the Drool CLI.
 *
 * This is the core sandbox manager. It does NOT handle settings resolution,
 * service lifecycle, or TUI integration — those are handled by SandboxService.
 */

import { existsSync, realpathSync } from 'fs';
import { createRequire } from 'module';
import { isIP } from 'net';
import { dirname, basename, join, resolve } from 'path';

import {
  SandboxOperationType,
  SandboxViolationReason,
  SandboxViolationType,
} from '@industry/drool-sdk-ext/protocol/drool';
import { SandboxMode } from '@industry/drool-sdk-ext/protocol/settings';
import { domainMatchesPattern } from '@industry/utils/settings';

import { DROOL_SANDBOXED_ENV } from '@/sandbox/constants';
import type {
  SandboxConfig,
  SandboxViolation,
  PlatformSupportResult,
  DependencyCheckResult,
} from '@/sandbox/types';
import { getRipgrepPath } from '@/utils/grep-utils';

import type {
  SandboxManager as SandboxManagerType,
  SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';
import type { SandboxSettings } from '@industry/common/settings';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_INDUSTRY_DOMAINS = [
  'api.example.com',
  'dev.api.example.com',
  'staging.api.example.com',
  'preprod.api.example.com',
  'app.example.com',
  'dev.app.example.com',
  'staging.app.example.com',
  'preprod.app.example.com',
  'telemetry.example.com',
  'dev.telemetry.example.com',
  'relay.example.com',
  'relay-dev.example.com',
  'downloads.example.com',
  'test.api.example.com',
  'test.example.com',
];
const MAX_VIOLATIONS = 500;
const SANDBOX_RUNTIME_PACKAGE_NAME = '@anthropic-ai/sandbox-runtime';
const SANDBOX_RUNTIME_SECCOMP_SUBPATH = join('vendor', 'seccomp');
const requireFromHere = createRequire(import.meta.url);

interface SeccompDiscoveryOptions {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  execPath?: string;
  resolveSandboxRuntimePackageRoot?: () => string | undefined;
  exists?: typeof existsSync;
  realpath?: typeof realpathSync;
}

function getSeccompVendorArch(
  arch: NodeJS.Architecture
): 'arm64' | 'x64' | undefined {
  if (arch === 'arm64') {
    return 'arm64';
  }
  if (arch === 'x64') {
    return 'x64';
  }
  return undefined;
}

function hasNodeErrorCode(error: unknown, codes: string[]): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return codes.includes(String(error.code));
}

function resolveSandboxRuntimePackageRoot(): string | undefined {
  try {
    return dirname(
      requireFromHere.resolve(`${SANDBOX_RUNTIME_PACKAGE_NAME}/package.json`)
    );
  } catch (error) {
    if (hasNodeErrorCode(error, ['MODULE_NOT_FOUND'])) {
      return undefined;
    }
    throw error;
  }
}

function safeRealpath(
  filePath: string,
  realpath: typeof realpathSync
): string | undefined {
  try {
    return realpath(filePath);
  } catch (error) {
    if (hasNodeErrorCode(error, ['EACCES', 'ENOENT', 'ENOTDIR'])) {
      return undefined;
    }
    throw error;
  }
}

function getTrustedSeccompDirectories(
  arch: 'arm64' | 'x64',
  options: Required<
    Pick<
      SeccompDiscoveryOptions,
      'execPath' | 'resolveSandboxRuntimePackageRoot'
    >
  >
): string[] {
  const relativeNodeModulesPath = join(
    'node_modules',
    SANDBOX_RUNTIME_PACKAGE_NAME,
    SANDBOX_RUNTIME_SECCOMP_SUBPATH,
    arch
  );
  const execDir = dirname(options.execPath);
  const packageRoot = options.resolveSandboxRuntimePackageRoot();
  const candidates = [
    packageRoot
      ? resolve(packageRoot, SANDBOX_RUNTIME_SECCOMP_SUBPATH, arch)
      : undefined,
    packageRoot
      ? resolve(packageRoot, 'dist', SANDBOX_RUNTIME_SECCOMP_SUBPATH, arch)
      : undefined,
    resolve(execDir, '..', '..', '..', relativeNodeModulesPath),
    resolve(execDir, '..', relativeNodeModulesPath),
  ].filter((entry): entry is string => entry !== undefined);

  return [...new Set(candidates)];
}

/**
 * Check if a path is under (a child of, or equal to) a given directory.
 */
function isPathUnder(filePath: string, dirPath: string): boolean {
  // Normalize: ensure dirPath ends without trailing slash for comparison
  const normalizedDir = dirPath.endsWith('/') ? dirPath.slice(0, -1) : dirPath;

  // Exact match
  if (filePath === normalizedDir) return true;

  // Child path: filePath starts with dirPath + /
  return filePath.startsWith(`${normalizedDir}/`);
}

function resolveTrustedSeccompFile(
  basePath: string,
  fileName: string,
  exists: typeof existsSync,
  realpath: typeof realpathSync
): string | undefined {
  const filePath = join(basePath, fileName);
  if (!exists(filePath)) {
    return undefined;
  }

  const baseRealpath = safeRealpath(basePath, realpath);
  const fileRealpath = safeRealpath(filePath, realpath);
  if (
    !baseRealpath ||
    !fileRealpath ||
    !isPathUnder(fileRealpath, baseRealpath)
  ) {
    return undefined;
  }

  return fileRealpath;
}

export function getSecureSeccompConfig(
  options: SeccompDiscoveryOptions = {}
): { bpfPath: string; applyPath: string } | undefined {
  if ((options.platform ?? process.platform) !== 'linux') {
    return undefined;
  }

  const arch = getSeccompVendorArch(options.arch ?? process.arch);
  if (!arch) {
    return undefined;
  }

  const exists = options.exists ?? existsSync;
  const realpath = options.realpath ?? realpathSync;
  const candidates = getTrustedSeccompDirectories(arch, {
    execPath: options.execPath ?? process.execPath,
    resolveSandboxRuntimePackageRoot:
      options.resolveSandboxRuntimePackageRoot ??
      resolveSandboxRuntimePackageRoot,
  });

  for (const basePath of candidates) {
    const bpfPath = resolveTrustedSeccompFile(
      basePath,
      'unix-block.bpf',
      exists,
      realpath
    );
    const applyPath = resolveTrustedSeccompFile(
      basePath,
      'apply-seccomp',
      exists,
      realpath
    );
    if (bpfPath && applyPath) {
      return { bpfPath, applyPath };
    }
  }

  return undefined;
}

// =============================================================================
// Pure Helper Functions (no `this` usage)
// =============================================================================

/**
 * Check if a path is under any of the given directory paths.
 */
function isPathUnderAny(filePath: string, paths: string[]): boolean {
  return paths.some((p) => isPathUnder(filePath, p));
}

/**
 * Backslash-escape ripgrep glob metacharacters
 */
function escapeGlobMetacharacters(path: string): string {
  return path.replace(/[\\*?[\]{}]/g, '\\$&');
}

/** Remove surrounding square brackets from an IPv6 literal. */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Validate a hostname before allowlist matching, mirroring SRT's `isValidHost`.
 */
function isValidHostname(host: string): boolean {
  if (!host || host.length > 255) return false;

  const bare = stripBrackets(host);

  // Reject IPv6 zone identifiers (e.g. `fe80::1%eth0`); `isIP` accepts a
  // permissive zone charset that could otherwise pass a wildcard suffix check.
  if (bare.includes('%')) return false;

  if (isIP(bare)) return true;

  // DNS label charset; underscore permitted for records like `_dmarc`.
  return /^[A-Za-z0-9._-]+$/.test(bare);
}

/**
 * Canonicalize a validated host so the app-level allowlist comparison agrees
 * with what `getaddrinfo()` would dial and with SRT's `canonicalizeHost`.
 */
function canonicalizeHostname(host: string): string | null {
  try {
    const bare = stripBrackets(host);
    const bracketed = isIP(bare) === 6 ? `[${bare}]` : bare;
    const out = new URL(`http://${bracketed}/`).hostname;
    return stripBrackets(out).replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * Extract the domain (hostname) from a URL.
 */
function extractDomain(urlString: string): string | null {
  try {
    const url = new URL(urlString);
    return url.hostname;
  } catch {
    // If not a valid URL, try treating it as a plain domain
    return urlString.split('/')[0] || null;
  }
}

// =============================================================================
// DroolSandboxManager
// =============================================================================

export class DroolSandboxManager {
  private config: SandboxConfig | null = null;

  private cwd: string = process.cwd();

  private active = false;

  private violations: SandboxViolation[] = [];

  private effectiveAllowedDomains: string[] = [];

  private resolvedCwd: string | null = null;

  /** Reference to the SRT SandboxManager singleton for querying dynamic proxy ports */
  private srtManager: typeof SandboxManagerType | null = null;

  // ==========================================================================
  // Initialization
  // ==========================================================================

  /**
   * Initialize the sandbox manager with a resolved config.
   * Translates Drool SandboxConfig to SRT's SandboxRuntimeConfig and
   * initializes the SRT SandboxManager singleton.
   *
   * @param config - Resolved sandbox config
   * @param cwd - Override for current working directory
   * @param sandboxAskCallback - Optional callback for SRT domain prompts during Execute
   */
  async initialize(
    config: SandboxConfig,
    cwd?: string,
    sandboxAskCallback?: (params: {
      host: string;
      port: number | undefined;
    }) => Promise<boolean>
  ): Promise<void> {
    if (this.isAlreadySandboxed()) {
      // Whole-process children are activated via activateAlreadySandboxed()
      if (config.mode === SandboxMode.WholeProcess) {
        throw new Error(
          'Whole-process sandbox child was incorrectly initialized'
        );
      }
      this.initializePolicyOnly(config, cwd);
      return;
    }

    this.setConfig(config, cwd);

    if (!config.enabled) {
      return;
    }

    // Build SRT config
    const srtConfig = this.translateToSrtConfig(config);

    // Import SRT dynamically to avoid issues when it's not available
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
    await SandboxManager.initialize(srtConfig, sandboxAskCallback);
    this.srtManager = SandboxManager;
    this.active = true;
  }

  /**
   * Activate application-level sandbox policy for a process that has already
   * been re-execed into the whole-process OS sandbox by the supervisor.
   *
   * This intentionally does not initialize SRT again: the host-side supervisor
   * owns proxy/bridge lifetime while this child process only needs local policy
   * checks and status surfaces to remain enabled.
   */
  activateAlreadySandboxed(config: SandboxConfig, cwd?: string): void {
    this.setConfig(config, cwd);
    this.active = config.enabled;
  }

  /**
   * Initialize policy checks without starting another SRT runtime.
   *
   * Used by subagent children that are already inside the parent's OS sandbox.
   * The child still needs application-level file/network checks for its own
   * tool calls, but must not recursively initialize SRT.
   */
  initializePolicyOnly(config: SandboxConfig, cwd?: string): void {
    this.setConfig(config, cwd);
    this.active = false;
    this.srtManager = null;
  }

  // ==========================================================================
  // File Access Checks (Application-Level)
  // ==========================================================================

  /**
   * Check if a file access operation is allowed.
   *
   * @param filePath - Absolute or relative path to check
   * @param operation - 'read' or 'write'
   * @returns SandboxViolation if blocked, null if allowed
   */
  checkFileAccess(
    filePath: string,
    operation: SandboxOperationType.Read | SandboxOperationType.Write
  ): SandboxViolation | null {
    // No checks when sandbox is disabled
    if (!this.config?.enabled) {
      return null;
    }

    // Resolve the path to absolute, following symlinks where possible
    const resolvedPath = this.resolvePath(filePath);

    if (operation === SandboxOperationType.Read) {
      return this.checkReadAccess(resolvedPath);
    }

    return this.checkWriteAccess(resolvedPath);
  }

  /**
   * Check read access for a path.
   * Read uses deny-then-allow: allowRead overrides denyRead within denied regions.
   * This is the opposite of write, where denyWrite overrides allowWrite.
   */
  private checkReadAccess(resolvedPath: string): SandboxViolation | null {
    const { denyRead, allowRead } = this.config!.filesystem;

    // Check if path is under any denyRead entry
    if (isPathUnderAny(resolvedPath, denyRead)) {
      // allowRead carve-outs override denyRead
      if (isPathUnderAny(resolvedPath, allowRead)) {
        return null;
      }

      const violation: SandboxViolation = {
        type: SandboxViolationType.FilesystemRead,
        reason: SandboxViolationReason.DenyList,
        path: resolvedPath,
        operation: SandboxOperationType.Read,
        message: `Sandbox: read denied to ${resolvedPath}`,
        timestamp: Date.now(),
      };
      this.recordViolation(violation);
      return violation;
    }

    return null;
  }

  /**
   * Check write access for a path.
   * Write uses allow-only + deny pattern:
   * 1. denyWrite always takes precedence (checked first)
   * 2. CWD is writable by default
   * 3. allowWrite paths are writable
   * 4. Everything else is denied
   */
  private checkWriteAccess(resolvedPath: string): SandboxViolation | null {
    const { allowWrite, denyWrite } = this.config!.filesystem;

    // 1. denyWrite always wins (checked first, overrides allowWrite)
    if (isPathUnderAny(resolvedPath, denyWrite)) {
      const violation: SandboxViolation = {
        type: SandboxViolationType.FilesystemWrite,
        reason: SandboxViolationReason.DenyList,
        path: resolvedPath,
        operation: SandboxOperationType.Write,
        message: `Sandbox: write denied to ${resolvedPath}`,
        timestamp: Date.now(),
      };
      this.recordViolation(violation);
      return violation;
    }

    // 2. CWD is always writable by default
    if (isPathUnder(resolvedPath, this.resolvedCwd!)) {
      return null;
    }

    // 3. allowWrite paths are writable
    if (isPathUnderAny(resolvedPath, allowWrite)) {
      return null;
    }

    // 4. Everything else is denied
    const violation: SandboxViolation = {
      type: SandboxViolationType.FilesystemWrite,
      reason: SandboxViolationReason.NotAllowed,
      path: resolvedPath,
      operation: SandboxOperationType.Write,
      message: `Sandbox: write denied to ${resolvedPath}`,
      timestamp: Date.now(),
    };
    this.recordViolation(violation);
    return violation;
  }

  // ==========================================================================
  // Network Access Checks (Application-Level)
  // ==========================================================================

  /**
   * Check if network access to a URL is allowed.
   *
   * @param url - The URL to check
   * @returns SandboxViolation if blocked, null if allowed
   */
  checkNetworkAccess(url: string): SandboxViolation | null {
    // No checks when sandbox is disabled
    if (!this.config?.enabled) {
      return null;
    }

    const domain = extractDomain(url);
    if (!domain) {
      return null;
    }

    // Check if domain matches effective allowed domains
    if (this.isDomainAllowedInternal(domain)) {
      return null;
    }

    const violation: SandboxViolation = {
      type: SandboxViolationType.Network,
      domain,
      operation: SandboxOperationType.Network,
      message: `Sandbox: network access denied to ${domain}`,
      timestamp: Date.now(),
    };
    this.recordViolation(violation);
    return violation;
  }

  /**
   * Check if a domain is allowed based on the effective allowed domains list.
   */
  private isDomainAllowedInternal(domain: string): boolean {
    if (!isValidHostname(domain)) {
      return false;
    }
    const canonicalDomain = canonicalizeHostname(domain);
    if (canonicalDomain === null) {
      return false;
    }
    for (const pattern of this.effectiveAllowedDomains) {
      if (domainMatchesPattern(canonicalDomain, pattern)) {
        return true;
      }
    }
    return false;
  }

  // ==========================================================================
  // Command Wrapping (OS-Level Sandboxing via SRT)
  // ==========================================================================

  /**
   * Wrap a command with OS-level sandbox restrictions via SRT.
   * If already sandboxed (DROOL_SANDBOXED=1) or sandbox is disabled,
   * returns the command unchanged.
   */
  async wrapCommand(command: string): Promise<string> {
    if (!this.config?.enabled || this.isAlreadySandboxed() || !this.active) {
      return command;
    }

    return this.srtManager!.wrapWithSandbox(command);
  }

  // ==========================================================================
  // Proxy Environment
  // ==========================================================================

  /**
   * Get proxy environment variables for child processes.
   * Returns HTTP_PROXY and HTTPS_PROXY pointing to SRT's localhost proxy.
   * Also returns ALL_PROXY (SOCKS5) when SRT has a SOCKS proxy running.
   * Returns an empty record if sandbox is not active or no proxy port is available.
   */
  getProxyEnv(): Record<string, string> {
    if (!this.config?.enabled || !this.active) {
      const inheritedEnv: Record<string, string> = {};
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
        const value = process.env[key];
        if (value) {
          inheritedEnv[key] = value;
        }
      }
      return inheritedEnv;
    }

    const env: Record<string, string> = {};

    // In whole-process child mode, SRT injected proxy variables into the
    // process environment while the supervisor owns the SRT manager instance.
    // Surface those values for child spawns without trying to query a local
    // SandboxManager singleton that does not exist in the child.
    if (!this.srtManager) {
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const) {
        const value = process.env[key];
        if (value) {
          env[key] = value;
        }
      }
      return env;
    }

    // Use SRT's dynamically assigned HTTP proxy port
    const httpPort = this.srtManager?.getProxyPort();
    if (httpPort != null) {
      const proxyUrl = `http://127.0.0.1:${httpPort}`;
      env.HTTP_PROXY = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;
    }

    // Use SRT's dynamically assigned SOCKS proxy port if available
    const socksPort = this.srtManager?.getSocksProxyPort();
    if (socksPort != null) {
      env.ALL_PROXY = `socks5://127.0.0.1:${socksPort}`;
    }

    return env;
  }

  /**
   * Get denyRead paths that are subtrees of the given root path,
   * excluding any subtrees fully covered by allowRead carve-outs.
   * Returns paths relative to rootPath for use as ripgrep --glob exclusions.
   *
   * If the root itself is inside a denied region (and not covered by allowRead),
   * returns `['**']` to signal "exclude everything" as a defense-in-depth guard.
   * The pre-check in sandboxPreCheck.ts already catches this case, but this
   * ensures the subtree method is also correct if called independently.
   */
  getDenyReadSubtrees(rootPath: string): string[] {
    return this.getReadSubtreeGlobs(rootPath).deny;
  }

  /**
   * Get allowRead paths that are subtrees of the given root path.
   * Returns paths relative to rootPath for use as ripgrep re-include globs.
   */
  getAllowReadSubtrees(rootPath: string): string[] {
    return this.getReadSubtreeGlobs(rootPath).allow;
  }

  /**
   * Combined deny/allow subtree computation. Resolves rootPath once and returns
   * both deny exclusions and allowRead re-includes as relative paths.
   */
  getReadSubtreeGlobs(rootPath: string): {
    deny: string[];
    allow: string[];
  } {
    if (!this.config) return { deny: [], allow: [] };
    const { denyRead, allowRead } = this.config.filesystem;
    const resolvedRoot = this.resolvePath(rootPath);

    // Defense-in-depth: if the root itself is inside a denied region
    // and not covered by an allowRead carve-out, exclude everything.
    if (isPathUnderAny(resolvedRoot, denyRead)) {
      if (!isPathUnderAny(resolvedRoot, allowRead)) {
        return { deny: ['**'], allow: [] };
      }
    }

    const prefix = resolvedRoot.endsWith('/')
      ? resolvedRoot
      : `${resolvedRoot}/`;

    const deny: string[] = [];
    for (const denyPath of denyRead) {
      if (denyPath.startsWith(prefix)) {
        if (isPathUnderAny(denyPath, allowRead)) continue;
        deny.push(escapeGlobMetacharacters(denyPath.slice(prefix.length)));
      }
    }

    const allow: string[] = [];
    for (const allowPath of allowRead) {
      if (allowPath.startsWith(prefix)) {
        allow.push(escapeGlobMetacharacters(allowPath.slice(prefix.length)));
      }
    }

    return { deny, allow };
  }

  // ==========================================================================
  // Runtime Config Updates
  // ==========================================================================

  private canUpdateRuntimeConfig(): boolean {
    // Whole-process children activate local policy without owning the SRT
    // manager. Runtime mutations must be applied by the supervisor-owned SRT
    // instance; mutating only local state would make app-level checks diverge
    // from OS-level enforcement.
    return !this.active || Boolean(this.srtManager);
  }

  /**
   * Add a domain to the allowed domains list at runtime.
   * Uses SRT's updateConfig to apply changes without restarting proxies.
   */
  async allowDomain(domain: string): Promise<void> {
    if (!this.config) return;
    if (!this.canUpdateRuntimeConfig()) return;

    // Add to our effective domains list
    if (!this.effectiveAllowedDomains.includes(domain)) {
      this.effectiveAllowedDomains.push(domain);
    }

    // Add to config
    if (!this.config.network.allowedDomains.includes(domain)) {
      this.config.network.allowedDomains.push(domain);
    }

    // Update SRT config if active
    if (this.active && this.srtManager) {
      const srtConfig = this.translateToSrtConfig(this.config);
      this.srtManager.updateConfig(srtConfig);
    }
  }

  /**
   * Add a directory to the allowWrite list at runtime.
   * Used by "Allow always" for file write violations.
   * Uses SRT's updateConfig to apply changes without restarting proxies.
   */
  async addAllowWritePath(dirPath: string): Promise<void> {
    if (!this.config) return;
    if (!this.canUpdateRuntimeConfig()) return;

    // Add to config
    if (!this.config.filesystem.allowWrite.includes(dirPath)) {
      this.config.filesystem.allowWrite.push(dirPath);
    }

    // Update SRT config if active
    if (this.active && this.srtManager) {
      const srtConfig = this.translateToSrtConfig(this.config);
      this.srtManager.updateConfig(srtConfig);
    }
  }

  /**
   * Remove a path from the denyWrite list at runtime.
   * Used by "Remove from deny list" for denyWrite violations.
   * Uses SRT's updateConfig to apply changes without restarting proxies.
   */
  async removeDenyWritePath(filePath: string): Promise<void> {
    if (!this.config) return;
    if (!this.canUpdateRuntimeConfig()) return;

    this.config.filesystem.denyWrite = this.config.filesystem.denyWrite.filter(
      (entry) => entry !== filePath && !filePath.startsWith(`${entry}/`)
    );

    if (this.active && this.srtManager) {
      const srtConfig = this.translateToSrtConfig(this.config);
      this.srtManager.updateConfig(srtConfig);
    }
  }

  /**
   * Add a path to the allowRead list at runtime.
   * Used by "Allow always" for read violations inside denied regions.
   * Uses SRT's updateConfig to apply changes without restarting proxies.
   */
  async addAllowReadPath(dirPath: string): Promise<void> {
    if (!this.config) return;
    if (!this.canUpdateRuntimeConfig()) return;

    if (!this.config.filesystem.allowRead.includes(dirPath)) {
      this.config.filesystem.allowRead.push(dirPath);
    }

    if (this.active && this.srtManager) {
      const srtConfig = this.translateToSrtConfig(this.config);
      this.srtManager.updateConfig(srtConfig);
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Whether the sandbox manager has been initialized and SRT is running.
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Check if this process is already running inside a sandbox
   * (indicated by DROOL_SANDBOXED=1 environment variable).
   */
  isAlreadySandboxed(): boolean {
    return process.env[DROOL_SANDBOXED_ENV] === '1';
  }

  /**
   * Shut down the sandbox manager and clean up SRT resources.
   */
  async shutdown(): Promise<void> {
    if (this.active && this.srtManager) {
      await this.srtManager.reset();
      this.active = false;
      this.srtManager = null;
    }
  }

  /**
   * Full reset: shutdown + clear all state.
   */
  async reset(): Promise<void> {
    await this.shutdown();
    this.config = null;
    this.violations = [];
    this.effectiveAllowedDomains = [];
    this.resolvedCwd = null;
    this.srtManager = null;
  }

  // ==========================================================================
  // Platform & Dependency Checks
  // ==========================================================================

  /**
   * Check if the current platform supports sandboxing.
   */
  async checkPlatformSupport(): Promise<PlatformSupportResult> {
    try {
      const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
      if (SandboxManager.isSupportedPlatform()) {
        return { supported: true };
      }
      return {
        supported: false,
        reason: `Unsupported platform: ${process.platform}`,
      };
    } catch {
      return {
        supported: false,
        reason: 'Failed to load @anthropic-ai/sandbox-runtime',
      };
    }
  }

  /**
   * Check if required dependencies are available.
   */
  async checkDependencies(): Promise<DependencyCheckResult> {
    try {
      const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
      const rgPath = getRipgrepPath() ?? 'rg';
      const result = SandboxManager.checkDependencies({
        command: rgPath,
      });
      const hasSecureSeccomp = Boolean(getSecureSeccompConfig());
      return {
        satisfied: result.errors.length === 0,
        errors: result.errors,
        warnings: hasSecureSeccomp
          ? result.warnings.filter((warning) => !/seccomp|unix/i.test(warning))
          : result.warnings,
      };
    } catch (error) {
      return {
        satisfied: false,
        errors: [
          `Failed to check dependencies: ${error instanceof Error ? error.message : String(error)}`,
        ],
        warnings: [],
      };
    }
  }

  // ==========================================================================
  // Violation Tracking
  // ==========================================================================

  /**
   * Record a violation, capping the array to avoid unbounded memory growth.
   */
  private recordViolation(violation: SandboxViolation): void {
    if (this.violations.length >= MAX_VIOLATIONS) {
      this.violations.shift();
    }
    this.violations.push(violation);
  }

  /**
   * Get all recorded violations.
   */
  getViolations(): SandboxViolation[] {
    return [...this.violations];
  }

  /**
   * Return the current sandbox settings represented by this manager.
   *
   * This snapshot intentionally uses the mutable runtime config so scoped
   * permission changes (for example allow-always grants) propagate to child
   * processes instead of being lost to stale settings reloads.
   */
  getSandboxSettingsSnapshot(): SandboxSettings | null {
    if (!this.config) {
      return null;
    }

    return {
      enabled: this.config.enabled,
      mode: this.config.mode,
      filesystem: {
        allowWrite: [...this.config.filesystem.allowWrite],
        allowRead: [...this.config.filesystem.allowRead],
        denyWrite: [...this.config.filesystem.denyWrite],
        denyRead: [...this.config.filesystem.denyRead],
      },
      network: {
        allowedDomains: [...this.config.network.allowedDomains],
        allowUnixSockets: this.config.network.allowUnixSockets,
        allowAllUnixSockets: this.config.network.allowAllUnixSockets,
        allowLocalBinding: this.config.network.allowLocalBinding,
        httpProxyPort: this.config.network.httpProxyPort,
        socksProxyPort: this.config.network.socksProxyPort,
      },
    };
  }

  /**
   * Clear all recorded violations.
   */
  clearViolations(): void {
    this.violations = [];
  }

  // ==========================================================================
  // Internal Helpers
  // ==========================================================================

  /**
   * Resolve a file path to absolute, following symlinks when possible.
   * Walks up the directory tree to find the nearest existing ancestor and
   * resolves symlinks from there (e.g. /tmp/a/b/c → /private/tmp/a/b/c on macOS).
   */
  private resolvePath(filePath: string): string {
    const absolute = resolve(this.cwd, filePath);
    try {
      return realpathSync(absolute);
    } catch {
      // Walk up to find the nearest existing ancestor with resolved symlinks
      let current = absolute;
      const tailSegments: string[] = [];

      while (true) {
        const parent = dirname(current);
        tailSegments.unshift(basename(current));
        if (parent === current) {
          // Reached filesystem root without finding an existing path
          return absolute;
        }
        try {
          const resolvedAncestor = realpathSync(parent);
          return resolve(resolvedAncestor, ...tailSegments);
        } catch {
          current = parent;
        }
      }
    }
  }

  private setConfig(config: SandboxConfig, cwd?: string): void {
    this.config = config;
    this.cwd = cwd ?? process.cwd();
    this.resolvedCwd = this.resolvePath(this.cwd);

    // Compute effective allowed domains:
    // Always include the explicit Industry control-plane defaults, then add any
    // user-configured domains. Do not use a Industry wildcard here: mediated
    // tools still need sandbox review for unrelated Industry subdomains and
    // pseudo-scopes such as WebSearch.
    this.effectiveAllowedDomains = [
      ...DEFAULT_INDUSTRY_DOMAINS,
      ...config.network.allowedDomains.filter(
        (d) => !DEFAULT_INDUSTRY_DOMAINS.includes(d)
      ),
    ];
  }

  /**
   * Translate Drool SandboxConfig to SRT's SandboxRuntimeConfig.
   */
  private translateToSrtConfig(config: SandboxConfig): SandboxRuntimeConfig {
    // Add CWD to allowWrite for SRT (only CWD is writable by default)
    const allAllowWrite = [
      this.resolvedCwd ?? this.cwd,
      ...config.filesystem.allowWrite,
    ];
    // Deduplicate
    const uniqueAllowWrite = [...new Set(allAllowWrite)];

    return {
      network: {
        allowedDomains: this.effectiveAllowedDomains,
        deniedDomains: [],
        allowUnixSockets: config.network.allowUnixSockets,
        allowAllUnixSockets: config.network.allowAllUnixSockets,
        allowLocalBinding: config.network.allowLocalBinding,
        httpProxyPort: config.network.httpProxyPort,
        socksProxyPort: config.network.socksProxyPort,
      },
      filesystem: {
        allowWrite: uniqueAllowWrite,
        denyWrite: config.filesystem.denyWrite,
        denyRead: config.filesystem.denyRead,
      },
      ripgrep: {
        command: getRipgrepPath() ?? 'rg',
      },
      seccomp: getSecureSeccompConfig(),
    };
  }
}
