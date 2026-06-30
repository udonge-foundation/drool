/**
 * Allow-always persistence module.
 *
 * When a user selects "Allow always" on a sandbox violation prompt, this module
 * persists the change to user-level settings (~/.industry/settings.json) and
 * updates the in-memory sandbox config for immediate effect.
 *
 * - File write violations: adds parent directory to sandbox.filesystem.allowWrite
 * - File read violations: adds path/directory to sandbox.filesystem.allowRead
 *   (allowRead carve-outs override denyRead within denied regions)
 * - Domain violations: adds domain to sandbox.network.allowedDomains
 *   (with wildcard for 3+ part domains, e.g., registry.npmjs.org → *.npmjs.org)
 */

import { dirname } from 'path';

import {
  SandboxViolationReason,
  SandboxViolationType,
} from '@industry/drool-sdk-ext/protocol/drool';
import { logInfo, logWarn } from '@industry/logging';
import { resolveSandboxPath } from '@industry/utils/settings/sandbox-paths';

import { AgentEvent, agentEventBus } from '@/events/AgentEventBus';
import { SandboxDenyListKind } from '@/sandbox/enums';
import type { SandboxViolation } from '@/sandbox/types';
import { getSandboxService } from '@/services/SandboxService';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Resolve the path to persist for a file violation.
 * If fileLevel is true, uses the exact file path; otherwise uses the parent directory.
 */
function resolveAllowPath(violationPath: string, fileLevel: boolean): string {
  return fileLevel ? violationPath : dirname(violationPath);
}

// =============================================================================
// Domain wildcard logic
// =============================================================================

/**
 * Compute the domain string to grant/persist for "Allow always" on a domain
 * violation.
 *
 * - 2-part domains (e.g., github.com) → "github.com" (as-is, no widening)
 * - 3+ part domains (e.g., registry.npmjs.org) → "*.npmjs.org" (wildcard)
 *
 * The wildcard is kept only when a participating higher-level ceiling would also
 * permit it (e.g. the ceiling is already `*.example.com`). Otherwise the wildcard
 * would widen beyond the ceiling, so we clamp to the exact requested host — which
 * the violation prompt guarantees is within the ceiling. With no participating
 * ceiling the wildcard is not blocked and is returned unchanged. The label, the
 * persisted setting, and the in-memory grant all read this value, so the prompt
 * can never advertise more access than is granted.
 */
export function computeAllowAlwaysDomain(domain: string): string {
  const parts = domain.split('.');
  // 2 parts or fewer: no widening possible, grant the host as-is.
  if (parts.length < 3) return domain;

  const wildcard = `*.${parts.slice(1).join('.')}`;
  return getSettingsService().isDomainBlockedByHigherCeiling(wildcard)
    ? domain
    : wildcard;
}

// =============================================================================
// Settings persistence
// =============================================================================

/**
 * Persist an "Allow always" decision to user-level sandbox settings.
 *
 * Uses the SettingsService.updateUserSandboxSettings API which is serialized
 * by SettingsManager to prevent concurrent writes from clobbering each other.
 * Only the affected sandbox leaf is patched — sibling branches are preserved.
 *
 * Capability-broadening writes (allowWrite, allowedDomains) are blocked when
 * a higher-level ceiling owns that field.
 */
export async function persistAllowAlways(
  violation: SandboxViolation,
  fileLevel = false
): Promise<void> {
  try {
    const settingsService = getSettingsService();
    const userSandbox = settingsService.getUserSandboxSettings();

    switch (violation.type) {
      case SandboxViolationType.FilesystemWrite: {
        if (!violation.path) {
          logWarn(
            '[allowAlwaysPersistence] No path in filesystem-write violation'
          );
          return;
        }

        if (violation.reason === SandboxViolationReason.DenyList) {
          // Only remove user-owned deny entries
          if (
            !settingsService.hasUserLevelMatchingDeny(
              violation.path,
              SandboxDenyListKind.Write
            )
          ) {
            logInfo(
              '[allowAlwaysPersistence] Path not in user-level denyWrite',
              { path: violation.path }
            );
            return;
          }

          const currentDenyWrite = userSandbox?.filesystem?.denyWrite ?? [];
          const updatedDenyWrite = currentDenyWrite.filter((entry) => {
            const resolvedEntry = resolveSandboxPath({ rawPath: entry });
            return (
              resolvedEntry !== violation.path &&
              !violation.path!.startsWith(`${resolvedEntry}/`)
            );
          });

          await settingsService.updateUserSandboxSettings({
            filesystem: { denyWrite: updatedDenyWrite },
          });

          logInfo('[allowAlwaysPersistence] Removed path from denyWrite', {
            path: violation.path,
          });
        } else {
          // Defense-in-depth: block if a participating higher-level ceiling
          // excludes this path (Section 9.4). Even if the prompt was shown
          // incorrectly, this prevents broadening the sandbox beyond the
          // merged hierarchy.
          if (settingsService.isWriteBlockedByHigherCeiling(violation.path)) {
            logInfo(
              '[allowAlwaysPersistence] Higher-level ceiling on allowWrite — skipping',
              { path: violation.path }
            );
            return;
          }

          const pathToAllow = resolveAllowPath(violation.path, fileLevel);
          const currentAllowWrite = userSandbox?.filesystem?.allowWrite ?? [];

          if (currentAllowWrite.includes(pathToAllow)) {
            logInfo('[allowAlwaysPersistence] Path already in allowWrite', {
              path: pathToAllow,
            });
            return;
          }

          await settingsService.updateUserSandboxSettings({
            filesystem: { allowWrite: [...currentAllowWrite, pathToAllow] },
          });

          logInfo('[allowAlwaysPersistence] Added path to allowWrite', {
            path: pathToAllow,
            state: fileLevel ? 'file' : 'directory',
          });
        }
        break;
      }

      case SandboxViolationType.FilesystemRead: {
        if (!violation.path) {
          logWarn(
            '[allowAlwaysPersistence] No path in filesystem-read violation'
          );
          return;
        }

        // Defense-in-depth: block if a participating higher-level ceiling
        // excludes this path (Section 9.4).
        if (settingsService.isReadBlockedByHigherCeiling(violation.path)) {
          logInfo(
            '[allowAlwaysPersistence] Higher-level ceiling on allowRead — skipping',
            { path: violation.path }
          );
          return;
        }

        const pathToAllow = resolveAllowPath(violation.path, fileLevel);
        const currentAllowRead = userSandbox?.filesystem?.allowRead ?? [];

        if (currentAllowRead.includes(pathToAllow)) {
          logInfo('[allowAlwaysPersistence] Path already in allowRead', {
            path: pathToAllow,
          });
          return;
        }

        await settingsService.updateUserSandboxSettings({
          filesystem: { allowRead: [...currentAllowRead, pathToAllow] },
        });

        logInfo('[allowAlwaysPersistence] Added path to allowRead', {
          path: pathToAllow,
          state: fileLevel ? 'file' : 'directory',
        });
        break;
      }

      case SandboxViolationType.Network: {
        if (!violation.domain) {
          logWarn('[allowAlwaysPersistence] No domain in network violation');
          return;
        }

        // Defense-in-depth: block if a participating higher-level ceiling
        // excludes this domain (Section 9.4).
        if (settingsService.isDomainBlockedByHigherCeiling(violation.domain)) {
          logInfo(
            '[allowAlwaysPersistence] Higher-level ceiling on allowedDomains — skipping',
            { domain: violation.domain }
          );
          return;
        }

        const domainToAdd = computeAllowAlwaysDomain(violation.domain);
        const currentAllowedDomains =
          userSandbox?.network?.allowedDomains ?? [];

        if (currentAllowedDomains.includes(domainToAdd)) {
          logInfo('[allowAlwaysPersistence] Domain already in allowedDomains', {
            domain: domainToAdd,
          });
          return;
        }

        await settingsService.updateUserSandboxSettings({
          network: { allowedDomains: [...currentAllowedDomains, domainToAdd] },
        });

        logInfo('[allowAlwaysPersistence] Added domain to allowedDomains', {
          domain: domainToAdd,
        });
        break;
      }

      default:
        logWarn('[allowAlwaysPersistence] Unknown violation type', {
          type: violation.type,
        });
    }
  } catch (error) {
    logWarn('[allowAlwaysPersistence] Failed to persist allow-always setting', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

// =============================================================================
// Combined persist + immediate in-memory update
// =============================================================================

/**
 * Handle "Allow always" for a sandbox violation:
 * 1. Persist the change to user-level settings file
 * 2. Update the in-memory SandboxService config for immediate effect
 *
 * This is the main entry point called by tool executors after the user
 * selects "Allow always" on a sandbox violation prompt.
 *
 * @param violation - The sandbox violation that was approved
 * @param fileLevel - If true, persist the exact file path instead of the parent directory (for file write/read violations)
 */
export async function handleAllowAlways(
  violation: SandboxViolation,
  fileLevel = false
): Promise<void> {
  // 1. Persist to user settings
  await persistAllowAlways(violation, fileLevel);

  // 2. Update in-memory config for immediate effect
  const sandboxService = getSandboxService();

  switch (violation.type) {
    case SandboxViolationType.FilesystemWrite: {
      if (violation.path) {
        if (violation.reason === SandboxViolationReason.DenyList) {
          await sandboxService.removeDenyWritePath(violation.path);
        } else {
          await sandboxService.addAllowWritePath(
            resolveAllowPath(violation.path, fileLevel)
          );
        }
      }
      break;
    }

    case SandboxViolationType.FilesystemRead: {
      if (violation.path) {
        await sandboxService.addAllowReadPath(
          resolveAllowPath(violation.path, fileLevel)
        );
      }
      break;
    }

    case SandboxViolationType.Network: {
      if (violation.domain) {
        const wildcardDomain = computeAllowAlwaysDomain(violation.domain);
        await sandboxService.allowDomain(wildcardDomain);
      }
      break;
    }

    default:
      break;
  }

  // Notify listeners (JSON-RPC adapter) about sandbox config change
  const status = sandboxService.getStatus();
  agentEventBus.emit(AgentEvent.SettingsUpdated, {
    settings: {
      sandbox: status.enabled ? status : undefined,
    },
    sessionId: getSessionService().getCurrentSessionId() ?? '',
  });
}
