/**
 * SandboxPermissionPrompt — handles interactive sandbox permission prompts.
 *
 * When a sandbox violation is detected (file access or network), instead of
 * immediately returning an error, this module emits a PermissionRequest via
 * AgentEventBus and blocks until the user responds with one of:
 *   - Allow once: proceed with the operation this time only
 *   - Allow always: add to user-level settings and proceed
 *   - Deny: block the operation and return an error
 *
 * For domain violations during Execute (via SRT's sandboxAskCallback), a
 * 60-second timeout auto-denies if the user doesn't respond.
 */

import { createHmac } from 'crypto';
import { constants as fsConstants, promises as fs } from 'fs';
import { basename, dirname, resolve as resolvePath } from 'path';

import {
  SandboxOperationType,
  SandboxViolationReason,
  ToolConfirmationOutcome,
  ToolConfirmationType,
  SandboxViolationType,
  type SandboxViolationConfirmationDetails,
  type ToolConfirmationInfo,
  type ToolConfirmationListItem,
} from '@industry/drool-sdk-ext/protocol/drool';
import { logWarn } from '@industry/logging';
import {
  isPathUnderEntry,
  resolveSandboxPath,
} from '@industry/utils/settings/sandbox-paths';

import { getThemedColors } from '@/components/chat/themedColors';
import { computeAllowAlwaysDomain } from '@/sandbox/allowAlwaysPersistence';
import {
  DROOL_SANDBOXED_ENV,
  DROOL_WHOLE_PROCESS_SANDBOX_GUARD_TOKEN_ENV,
  DROOL_WHOLE_PROCESS_SANDBOX_PERMISSION_REQUEST_FIFO_ENV,
  DROOL_WHOLE_PROCESS_SANDBOX_PERMISSION_RESPONSE_FIFO_ENV,
} from '@/sandbox/constants';
import { SandboxDenyListKind, SandboxPromptResult } from '@/sandbox/enums';
import type {
  SandboxPermissionRequestFn,
  SandboxViolation,
} from '@/sandbox/types';
import { getSettingsService } from '@/services/SettingsService';

import type { FileHandle } from 'fs/promises';

// =============================================================================
// Outcome tracking
// =============================================================================

/**
 * Module-level variable to track the last sandbox prompt outcome.
 *
 * When a sandbox prompt is shown via the TUI (SandboxViolationPrompt component),
 * the selected outcome (ProceedOnce vs ProceedAlways) is stored here BEFORE the
 * onConfirm callback resolves the permission promise. This allows
 * requestSandboxPermission() to read it after the promise resolves.
 *
 * This is safe because sandbox prompts are always single-tool, sequential
 * (the executor blocks on the promise), and single-threaded (JS event loop).
 */
let lastSandboxPromptOutcome: ToolConfirmationOutcome | null = null;

/**
 * Set the last sandbox prompt outcome. Called by SandboxViolationPrompt
 * before the onConfirm callback fires.
 */
export function setLastSandboxPromptOutcome(
  outcome: ToolConfirmationOutcome
): void {
  lastSandboxPromptOutcome = outcome;
}

/**
 * Read and clear the last sandbox prompt outcome.
 */
function consumeLastSandboxPromptOutcome(): ToolConfirmationOutcome | null {
  const outcome = lastSandboxPromptOutcome;
  lastSandboxPromptOutcome = null;
  return outcome;
}

// =============================================================================
// Denied domain tracking for Execute tool
// =============================================================================

/**
 * Domains denied via SRT's proxy callback during Execute tool runs.
 * The Execute tool reads and clears this after command completion to
 * append a clear sandbox denial message to the tool output.
 */
const MAX_PENDING_DENIED_DOMAINS = 100;
let pendingDeniedDomains: string[] = [];

/**
 * Read and clear the list of domains denied during Execute.
 */
export function consumeDeniedDomains(): string[] {
  const domains = pendingDeniedDomains;
  pendingDeniedDomains = [];
  return domains;
}

// =============================================================================
// Higher-level policy check
// =============================================================================

/**
 * Check if a violation is enforced by a higher-level policy (org, project, folder)
 * that the user cannot override. If so, the violation is auto-denied without
 * prompting — there is nothing the user can persist to avoid this prompt in the
 * future, so showing it would be noise.
 *
 * Under Section 9.4, only levels with `enabled: true` participate in policy.
 * Non-participating levels do not impose ceilings or deny-list restrictions.
 *
 * Policy rules:
 * - deny-list violations: auto-deny if the deny entry is from a participating
 *   higher level (user cannot remove it)
 * - not-allowed writes: auto-deny if a participating higher level's allowWrite
 *   ceiling excludes the target path (user's "Allow always" would be ineffective)
 * - not-allowed network: auto-deny if a participating higher level's
 *   allowedDomains ceiling excludes the target domain
 */
export function isHigherLevelPolicy(violation: SandboxViolation): boolean {
  try {
    const settingsService = getSettingsService();

    if (
      violation.type === SandboxViolationType.FilesystemWrite &&
      violation.path
    ) {
      if (violation.reason === SandboxViolationReason.DenyList) {
        return settingsService.isDenyFromParticipatingHigherLevel(
          violation.path,
          SandboxDenyListKind.Write
        );
      }
      return settingsService.isWriteBlockedByHigherCeiling(violation.path);
    }

    if (
      violation.type === SandboxViolationType.FilesystemRead &&
      violation.path
    ) {
      // Auto-deny if higher-level denyRead blocks the path AND the
      // higher-level allowRead ceiling does not include it
      return settingsService.isReadBlockedByHigherCeiling(violation.path);
    }

    if (violation.type === SandboxViolationType.Network && violation.domain) {
      return settingsService.isDomainBlockedByHigherCeiling(violation.domain);
    }

    return false;
  } catch {
    return false;
  }
}

// =============================================================================
// Permission prompt options
// =============================================================================

/**
 * Get the confirmation options for a sandbox violation prompt.
 * Options are dynamic based on violation type:
 * - File violations: shows both folder-level and file-level "Allow always" options
 * - Network violations: shows a single "Allow always" option with the domain
 */
export function getSandboxPromptOptions(
  violation: SandboxViolation
): (ToolConfirmationListItem & {
  selectedColor: string;
  selectedPrefix?: string;
})[] {
  const options: (ToolConfirmationListItem & {
    selectedColor: string;
    selectedPrefix?: string;
  })[] = [
    {
      label: 'Allow once',
      value: ToolConfirmationOutcome.ProceedOnce,
      selectedColor: getThemedColors().highlight,
    },
  ];

  const settingsService = getSettingsService();

  if (
    violation.type === SandboxViolationType.FilesystemWrite &&
    violation.path
  ) {
    if (violation.reason === SandboxViolationReason.DenyList) {
      // Only offer removal if the entry is user-owned
      if (
        settingsService.hasUserLevelMatchingDeny(
          violation.path,
          SandboxDenyListKind.Write
        )
      ) {
        const currentDenyWrite =
          settingsService.getUserSandboxSettings()?.filesystem?.denyWrite ?? [];
        const resolvedViolationPath = resolveSandboxPath({
          rawPath: violation.path,
        });
        const matchingDenyEntry = currentDenyWrite.find((entry) =>
          isPathUnderEntry(
            resolvedViolationPath,
            resolveSandboxPath({ rawPath: entry })
          )
        );
        if (matchingDenyEntry) {
          options.push({
            label: `Remove ${matchingDenyEntry} from deny list`,
            value: ToolConfirmationOutcome.ProceedAlways,
            selectedColor: getThemedColors().highlight,
          });
        }
      }
    } else {
      // This prompt is only shown when isHigherLevelPolicy() returned false,
      // meaning the path is within the higher-level ceiling (if any) and
      // user-level persistence can prevent this prompt in the future.
      const parentDir = dirname(violation.path);
      options.push({
        label: `Allow always (writes to ${parentDir})`,
        value: ToolConfirmationOutcome.ProceedAlways,
        selectedColor: getThemedColors().highlight,
      });
      options.push({
        label: `Allow always (writes to ${violation.path})`,
        value: ToolConfirmationOutcome.ProceedAlwaysForExactPath,
        selectedColor: getThemedColors().highlight,
      });
    }
  } else if (
    violation.type === SandboxViolationType.FilesystemRead &&
    violation.path
  ) {
    // This prompt is only shown when isHigherLevelPolicy() returned false,
    // meaning the path is within the higher-level allowRead ceiling (if any)
    // and user-level persistence can prevent this prompt in the future.
    const parentDir = dirname(violation.path);
    options.push({
      label: `Allow always (reads from ${parentDir})`,
      value: ToolConfirmationOutcome.ProceedAlways,
      selectedColor: getThemedColors().highlight,
    });
    options.push({
      label: `Allow always (reads from ${violation.path})`,
      value: ToolConfirmationOutcome.ProceedAlwaysForExactPath,
      selectedColor: getThemedColors().highlight,
    });
  } else if (
    violation.type === SandboxViolationType.Network &&
    violation.domain
  ) {
    // This prompt is only shown when isHigherLevelPolicy() returned false,
    // meaning the domain is within the higher-level ceiling (if any).
    const displayDomain = computeAllowAlwaysDomain(violation.domain);
    options.push({
      label: `Allow always (${displayDomain})`,
      value: ToolConfirmationOutcome.ProceedAlways,
      selectedColor: getThemedColors().highlight,
    });
  } else {
    options.push({
      label: 'Allow always (add to settings)',
      value: ToolConfirmationOutcome.ProceedAlways,
      selectedColor: getThemedColors().highlight,
    });
  }

  options.push({
    label: 'Deny',
    value: ToolConfirmationOutcome.Cancel,
    selectedColor: getThemedColors().highlightDanger,
    selectedPrefix: '✕ ',
  });

  return options;
}

// =============================================================================
// Build ToolConfirmationInfo for sandbox violations
// =============================================================================

/**
 * Build a ToolConfirmationInfo for a sandbox violation.
 */
export function buildSandboxViolationConfirmationInfo(
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  violation: SandboxViolation
): ToolConfirmationInfo {
  const enforcedByHigherLevel = isHigherLevelPolicy(violation);
  const target = violation.path ?? violation.domain ?? 'unknown';
  const violationType = violation.type;

  let reason: string;
  switch (violationType) {
    case SandboxViolationType.FilesystemWrite:
      reason =
        violation.reason === SandboxViolationReason.DenyList
          ? 'Path is blocked by the deny write list'
          : 'Path is not in the allowed write list';
      break;
    case SandboxViolationType.FilesystemRead:
      reason = 'Path is blocked by the deny read list';
      break;
    case SandboxViolationType.Network:
      reason = 'Domain is not in the allowed domains list';
      break;
    case SandboxViolationType.Tool:
      reason = violation.message;
      break;
    default:
      reason = violation.message;
  }

  if (enforcedByHigherLevel) {
    reason += ' (enforced by higher-level policy)';
  }

  const details: Omit<SandboxViolationConfirmationDetails, 'onConfirm'> = {
    type: ToolConfirmationType.SandboxViolation,
    violatingToolName: toolName,
    target,
    operationType: violation.operation,
    violationType,
    reason,
    violationReason: violation.reason,
    isOrgDeny: enforcedByHigherLevel,
  };

  return {
    toolUseId,
    toolName,
    toolInput,
    confirmationType: ToolConfirmationType.SandboxViolation,
    details,
  };
}

// =============================================================================
// Prompt for sandbox permission (used by file tool executors)
// =============================================================================

/**
 * Request sandbox permission from the user for a file/network violation.
 *
 * Returns the prompt result. The caller should:
 * - AllowOnce: proceed with the operation
 * - AllowAlways: persist to settings, then proceed
 * - Deny: return an error to the model
 *
 * @param toolUseId - The tool use ID
 * @param toolName - The tool name (e.g., 'Edit', 'Create')
 * @param toolInput - The tool input
 * @param violation - The sandbox violation details
 * @param requestPermissionFn - The permission request function (from ToolExecutionContext)
 * @returns The user's decision
 */
export async function requestSandboxPermission(
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  violation: SandboxViolation,
  requestPermissionFn?: SandboxPermissionRequestFn
): Promise<SandboxPromptResult> {
  if (
    violation.type === SandboxViolationType.Tool ||
    violation.promptable === false
  ) {
    return SandboxPromptResult.Deny;
  }

  // Auto-deny if enforced by higher-level policy (org, project, folder) —
  // prompting is pointless since user-level settings can't override it.
  if (isHigherLevelPolicy(violation)) {
    return SandboxPromptResult.Deny;
  }

  // If no permission function is available, deny by default
  if (!requestPermissionFn) {
    return SandboxPromptResult.Deny;
  }

  const confirmationInfo = buildSandboxViolationConfirmationInfo(
    toolUseId,
    toolName,
    toolInput,
    violation
  );

  const options = getSandboxPromptOptions(violation);

  try {
    const result = await requestPermissionFn({
      toolUses: [confirmationInfo],
      options,
    });

    // Check if the tool was approved
    if (result.approvedToolIds.includes(toolUseId)) {
      const outcome = result.outcome ?? consumeLastSandboxPromptOutcome();
      if (outcome === ToolConfirmationOutcome.ProceedAlways) {
        return SandboxPromptResult.AllowAlways;
      }
      if (outcome === ToolConfirmationOutcome.ProceedAlwaysForExactPath) {
        return SandboxPromptResult.AllowAlwaysForExactPath;
      }
      return SandboxPromptResult.AllowOnce;
    }

    return SandboxPromptResult.Deny;
  } catch {
    return SandboxPromptResult.Deny;
  }
}

// =============================================================================
// Domain prompt with timeout (for SRT sandboxAskCallback)
// =============================================================================

const DOMAIN_PROMPT_TIMEOUT_MS = 60_000; // 60 seconds
const FIFO_OPEN_FLAGS = fsConstants.O_RDWR + fsConstants.O_NONBLOCK;
const PIPE_BUF_LIMIT = 4096;

type WholeProcessPermissionDecision =
  | { decision: 'deny'; errorCode?: string }
  | { decision: 'allow_once' }
  | { decision: 'allow_always'; allowPattern?: string };

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function makeBridgeMac(
  token: string,
  payload: Record<string, unknown>
): string {
  return createHmac('sha256', token)
    .update(stableStringify(payload))
    .digest('hex');
}

function permissionResponseMacPayload(params: {
  id: string;
  host: string;
  port: number | undefined;
  deadlineMs: number;
  responseFifoPath: string;
  decision: WholeProcessPermissionDecision['decision'];
  allowPattern?: string;
}): Record<string, unknown> {
  return {
    id: params.id,
    host: params.host,
    port: params.port,
    deadlineMs: params.deadlineMs,
    responseFifoPath: params.responseFifoPath,
    decision: params.decision,
    allowPattern: params.allowPattern,
  };
}

/**
 * Module-level mutable delegate for domain request prompts.
 *
 * SRT's sandboxAskCallback is set once at SandboxManager.initialize() and
 * can't be updated later. But at startup, the TUI's requestPermissionFn
 * isn't available yet. We solve this with indirection: createSandboxAskCallback()
 * always returns a stable callback that delegates to this mutable reference.
 * When a session starts and requestPermissionFn becomes available,
 * setSandboxDomainRequestFn() updates the reference.
 */
let activeDomainRequestFn: SandboxPermissionRequestFn | null = null;

interface WholeProcessPermissionBridgeState {
  requestFifoPath: string;
  responseFifoPath: string;
  token: string;
  requestHandle: FileHandle;
  timer: ReturnType<typeof setInterval>;
  buffer: string;
  draining: boolean;
}

let activeWholeProcessBridge: WholeProcessPermissionBridgeState | null = null;
let wholeProcessBridgeGeneration = 0;

async function requestActiveSandboxDomainPermission(params: {
  host: string;
  port: number | undefined;
}): Promise<WholeProcessPermissionDecision> {
  const { host, port } = params;
  const domain = host;

  // Auto-deny if a participating higher-level ceiling excludes this domain.
  // Uses the same target-aware check as file tool prompts (Section 9.4).
  try {
    const settingsService = getSettingsService();
    if (settingsService.isDomainBlockedByHigherCeiling(domain)) {
      if (pendingDeniedDomains.length < MAX_PENDING_DENIED_DOMAINS) {
        pendingDeniedDomains.push(domain);
      }
      return { decision: 'deny', errorCode: 'higher_level_policy' };
    }
  } catch (error) {
    // Settings service not available — fall through to normal flow.
    logWarn('[Sandbox] Failed to evaluate sandbox domain ceiling', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const requestFn = activeDomainRequestFn;
  if (!requestFn) {
    if (pendingDeniedDomains.length < MAX_PENDING_DENIED_DOMAINS) {
      pendingDeniedDomains.push(domain);
    }
    return { decision: 'deny', errorCode: 'prompt_unavailable' };
  }
  const url =
    port === 443 || port === undefined
      ? `https://${host}`
      : `http://${host}:${port}`;

  const violation: SandboxViolation = {
    type: SandboxViolationType.Network,
    domain,
    operation: SandboxOperationType.Network,
    message: `Sandbox: network access to ${domain} requires approval`,
    timestamp: Date.now(),
  };

  const toolUseId = `sandbox-domain-prompt-${Date.now()}`;
  const confirmationInfo = buildSandboxViolationConfirmationInfo(
    toolUseId,
    'Execute',
    { command: `[network request to ${domain}]`, url },
    violation
  );

  const options = getSandboxPromptOptions(violation);

  // Race between user response and timeout.
  // clearTimeout ensures no late side-effects after settlement.
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<{
    approvedToolIds: string[];
    outcome: ToolConfirmationOutcome;
  }>((resolve) => {
    timeoutId = setTimeout(
      () =>
        resolve({
          approvedToolIds: [],
          outcome: ToolConfirmationOutcome.Cancel,
        }),
      DOMAIN_PROMPT_TIMEOUT_MS
    );
  });

  try {
    const permissionPromise = requestFn({
      toolUses: [confirmationInfo],
      options,
    });

    const result = await Promise.race([permissionPromise, timeoutPromise]);
    clearTimeout(timeoutId!);

    const approved = result.approvedToolIds.includes(toolUseId);

    if (approved) {
      const outcome = result.outcome ?? consumeLastSandboxPromptOutcome();
      if (outcome === ToolConfirmationOutcome.ProceedAlways) {
        const { handleAllowAlways } = await import(
          '@/sandbox/allowAlwaysPersistence'
        );
        await handleAllowAlways(violation);
        return {
          decision: 'allow_always',
          allowPattern: computeAllowAlwaysDomain(domain),
        };
      }
      return { decision: 'allow_once' };
    }

    // Clear any stale outcome from timeout/deny path
    consumeLastSandboxPromptOutcome();
    if (pendingDeniedDomains.length < MAX_PENDING_DENIED_DOMAINS) {
      pendingDeniedDomains.push(domain);
    }
    return { decision: 'deny' };
  } catch {
    clearTimeout(timeoutId!);
    consumeLastSandboxPromptOutcome();
    if (pendingDeniedDomains.length < MAX_PENDING_DENIED_DOMAINS) {
      pendingDeniedDomains.push(domain);
    }
    return { decision: 'deny', errorCode: 'prompt_error' };
  }
}

function isWouldBlock(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EAGAIN' || code === 'EWOULDBLOCK';
}

async function writeWholeProcessPermissionBridgeResponse(
  responseFifoPath: string,
  response: {
    id: string;
    token: string;
    host: string;
    port: number | undefined;
    deadlineMs: number;
    decision: WholeProcessPermissionDecision;
  }
): Promise<void> {
  const handle = await fs.open(responseFifoPath, FIFO_OPEN_FLAGS);
  try {
    const allowPattern =
      response.decision.decision === 'allow_always'
        ? response.decision.allowPattern
        : undefined;
    const frame = {
      version: 1,
      kind: 'network_permission_response',
      id: response.id,
      decision: response.decision.decision,
      allowPattern,
      errorCode:
        response.decision.decision === 'deny'
          ? response.decision.errorCode
          : undefined,
      mac: makeBridgeMac(
        response.token,
        permissionResponseMacPayload({
          id: response.id,
          host: response.host,
          port: response.port,
          deadlineMs: response.deadlineMs,
          responseFifoPath,
          decision: response.decision.decision,
          allowPattern,
        })
      ),
    };
    await handle.write(`${JSON.stringify(frame)}\n`);
  } finally {
    await handle.close();
  }
}

function getValidatedBridgeResponseFifoPath(
  bridge: WholeProcessPermissionBridgeState,
  responseFifoPath: unknown
): string | null {
  if (typeof responseFifoPath !== 'string') {
    return null;
  }

  const bridgeDirectoryPath = resolvePath(dirname(bridge.responseFifoPath));
  const resolvedResponseFifoPath = resolvePath(responseFifoPath);
  if (dirname(resolvedResponseFifoPath) !== bridgeDirectoryPath) {
    return null;
  }

  const responseFifoBasename = basename(resolvedResponseFifoPath);
  if (!responseFifoBasename.startsWith('permission-response-')) {
    return null;
  }

  return resolvedResponseFifoPath;
}

async function handleWholeProcessPermissionBridgeLine(
  bridge: WholeProcessPermissionBridgeState,
  line: string
): Promise<void> {
  try {
    if (Buffer.byteLength(line) >= PIPE_BUF_LIMIT) {
      return;
    }
    const request = JSON.parse(line) as {
      version?: unknown;
      kind?: unknown;
      id?: unknown;
      token?: unknown;
      host?: unknown;
      port?: unknown;
      responseFifoPath?: unknown;
      deadlineMs?: unknown;
    };
    if (
      request.version !== 1 ||
      request.kind !== 'network_permission_request' ||
      typeof request.id !== 'string' ||
      request.token !== bridge.token ||
      typeof request.host !== 'string' ||
      (request.port !== undefined &&
        !(
          typeof request.port === 'number' &&
          Number.isInteger(request.port) &&
          request.port >= 1 &&
          request.port <= 65535
        )) ||
      typeof request.deadlineMs !== 'number' ||
      Date.now() > request.deadlineMs
    ) {
      return;
    }

    const port = typeof request.port === 'number' ? request.port : undefined;
    const responseFifoPath = getValidatedBridgeResponseFifoPath(
      bridge,
      request.responseFifoPath
    );
    if (!responseFifoPath) {
      return;
    }

    const decision = await requestActiveSandboxDomainPermission({
      host: request.host,
      port,
    });
    await writeWholeProcessPermissionBridgeResponse(responseFifoPath, {
      id: request.id,
      token: bridge.token,
      host: request.host,
      port,
      deadlineMs: request.deadlineMs,
      decision,
    });
  } catch (error) {
    logWarn('[Sandbox] Failed to handle whole-process permission request', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function drainWholeProcessPermissionBridge(
  bridge: WholeProcessPermissionBridgeState
): Promise<void> {
  if (bridge.draining || activeWholeProcessBridge !== bridge) {
    return;
  }

  bridge.draining = true;
  try {
    while (activeWholeProcessBridge === bridge) {
      const buffer = Buffer.alloc(4096);
      try {
        const { bytesRead } = await bridge.requestHandle.read(
          buffer,
          0,
          buffer.length,
          null
        );
        if (bytesRead === 0) {
          return;
        }

        bridge.buffer += buffer.subarray(0, bytesRead).toString('utf8');
        const lines = bridge.buffer.split('\n');
        bridge.buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) {
            void handleWholeProcessPermissionBridgeLine(bridge, line);
          }
        }
      } catch (error) {
        if (isWouldBlock(error)) {
          return;
        }
        throw error;
      }
    }
  } catch (error) {
    logWarn('[Sandbox] Whole-process permission bridge failed', {
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    bridge.draining = false;
  }
}

function stopWholeProcessPermissionBridge(): void {
  wholeProcessBridgeGeneration += 1;
  const bridge = activeWholeProcessBridge;
  activeWholeProcessBridge = null;

  if (!bridge) {
    return;
  }

  clearInterval(bridge.timer);
  void bridge.requestHandle.close().catch((error) => {
    logWarn('[Sandbox] Failed to close whole-process permission bridge', {
      cause: error instanceof Error ? error.message : String(error),
    });
  });
}

function ensureWholeProcessPermissionBridge(): void {
  const requestFifoPath =
    process.env[DROOL_WHOLE_PROCESS_SANDBOX_PERMISSION_REQUEST_FIFO_ENV];
  const responseFifoPath =
    process.env[DROOL_WHOLE_PROCESS_SANDBOX_PERMISSION_RESPONSE_FIFO_ENV];
  const token = process.env[DROOL_WHOLE_PROCESS_SANDBOX_GUARD_TOKEN_ENV];
  const shouldRun =
    process.env[DROOL_SANDBOXED_ENV] === '1' &&
    Boolean(activeDomainRequestFn) &&
    Boolean(requestFifoPath) &&
    Boolean(responseFifoPath) &&
    Boolean(token);

  if (!shouldRun || !requestFifoPath || !responseFifoPath || !token) {
    stopWholeProcessPermissionBridge();
    return;
  }

  if (
    activeWholeProcessBridge &&
    activeWholeProcessBridge.requestFifoPath === requestFifoPath &&
    activeWholeProcessBridge.responseFifoPath === responseFifoPath
  ) {
    return;
  }

  stopWholeProcessPermissionBridge();
  const generation = wholeProcessBridgeGeneration;

  void (async () => {
    const requestHandle = await fs.open(requestFifoPath, FIFO_OPEN_FLAGS);
    if (generation !== wholeProcessBridgeGeneration) {
      await requestHandle.close();
      return;
    }

    const bridge: WholeProcessPermissionBridgeState = {
      requestFifoPath,
      responseFifoPath,
      token,
      requestHandle,
      timer: setInterval(() => {
        void drainWholeProcessPermissionBridge(bridge);
      }, 25),
      buffer: '',
      draining: false,
    };
    bridge.timer.unref?.();
    activeWholeProcessBridge = bridge;
    void drainWholeProcessPermissionBridge(bridge);
  })().catch((error) => {
    logWarn('[Sandbox] Failed to start whole-process permission bridge', {
      cause: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Set the active domain request function for SRT's proxy callback.
 * Call with the session's requestPermissionFn when a session starts,
 * and with null when the session ends.
 */
export function setSandboxDomainRequestFn(
  fn: SandboxPermissionRequestFn | null
): void {
  activeDomainRequestFn = fn;
  ensureWholeProcessPermissionBridge();
}

/**
 * Create a sandbox ask callback for SRT's domain prompt system.
 *
 * Always returns a callback (never undefined). Before a session starts
 * (no activeDomainRequestFn), it auto-denies. During a session, it
 * delegates to the TUI's requestPermissionFn for interactive prompts.
 * If no response within 60 seconds, auto-denies.
 *
 * @returns A callback compatible with SRT's sandboxAskCallback signature
 */
export function createSandboxAskCallback(): (params: {
  host: string;
  port: number | undefined;
}) => Promise<boolean> {
  return async (params) => {
    const result = await requestActiveSandboxDomainPermission(params);
    return result.decision !== 'deny';
  };
}
