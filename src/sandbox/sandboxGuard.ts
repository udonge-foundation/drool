/**
 * Shared sandbox enforcement for tool executors.
 *
 * Encapsulates the check → prompt → allow/deny → persist pattern used by
 * every file- and network-tool executor, eliminating ~20 lines of duplication
 * per tool.
 */

import { handleAllowAlways } from '@/sandbox/allowAlwaysPersistence';
import { SandboxPromptResult } from '@/sandbox/enums';
import { requestSandboxPermission } from '@/sandbox/SandboxPermissionPrompt';
import type { SandboxPermissionRequestFn } from '@/sandbox/types';
import { getSandboxService } from '@/services/SandboxService';

import type { SandboxOperationType } from '@industry/drool-sdk-ext/protocol/drool';

// Serialize sandbox prompts so parallel tools don't overwrite each other's
// _pendingConfirmation slot in ToolExecutor.
let promptQueue: Promise<void> = Promise.resolve();

function withPromptLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = promptQueue.then(fn);
  // Swallow errors so the queue continues after rejections
  promptQueue = result.then(
    () => {},
    () => {}
  );
  return result;
}

interface SandboxGuardContext {
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requestPermissionFn?: SandboxPermissionRequestFn;
}

/**
 * Enforce sandbox file-access policy. Returns a denial message string if
 * the operation is blocked, or `null` if it is allowed.
 */
export async function enforceSandboxFileAccess(
  filePath: string,
  operation: SandboxOperationType.Read | SandboxOperationType.Write,
  ctx: SandboxGuardContext
): Promise<string | null> {
  const sandboxService = getSandboxService();
  if (!sandboxService.isEnabled()) return null;

  const violation = sandboxService.checkFileAccess(filePath, operation);
  if (!violation) return null;

  const result = await withPromptLock(() =>
    requestSandboxPermission(
      ctx.toolCallId,
      ctx.toolName,
      ctx.toolInput,
      violation,
      ctx.requestPermissionFn
    )
  );

  if (
    result === SandboxPromptResult.AllowOnce ||
    result === SandboxPromptResult.AllowAlways ||
    result === SandboxPromptResult.AllowAlwaysForExactPath
  ) {
    if (result === SandboxPromptResult.AllowAlways) {
      await handleAllowAlways(violation);
    } else if (result === SandboxPromptResult.AllowAlwaysForExactPath) {
      await handleAllowAlways(violation, true);
    }
    return null;
  }

  return `Sandbox: ${operation} denied to ${filePath}`;
}

/**
 * Enforce sandbox network-access policy. Returns a denial message string if
 * the operation is blocked, or `null` if it is allowed.
 */
export async function enforceSandboxNetworkAccess(
  url: string,
  ctx: SandboxGuardContext
): Promise<string | null> {
  const sandboxService = getSandboxService();
  if (!sandboxService.isEnabled()) return null;

  const violation = sandboxService.checkNetworkAccess(url);
  if (!violation) return null;

  const result = await withPromptLock(() =>
    requestSandboxPermission(
      ctx.toolCallId,
      ctx.toolName,
      ctx.toolInput,
      violation,
      ctx.requestPermissionFn
    )
  );

  if (
    result === SandboxPromptResult.AllowOnce ||
    result === SandboxPromptResult.AllowAlways ||
    result === SandboxPromptResult.AllowAlwaysForExactPath
  ) {
    if (result === SandboxPromptResult.AllowAlways) {
      await handleAllowAlways(violation);
    } else if (result === SandboxPromptResult.AllowAlwaysForExactPath) {
      await handleAllowAlways(violation, true);
    }
    return null;
  }

  return `Sandbox: network access denied to ${violation.domain ?? url}`;
}
