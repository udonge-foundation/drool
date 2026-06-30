import { MISSION_SESSION_TAG } from '@industry/common/session';
import { DecompSessionType } from '@industry/drool-sdk-ext/protocol/drool';
import { type SessionTag } from '@industry/drool-sdk-ext/protocol/session';
import { DroolInteractionMode } from '@industry/drool-sdk-ext/protocol/shared';
import { logInfo } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { SettingsManager } from '@industry/runtime/settings';

function hasMissionTags(tags: SessionTag[] | undefined): boolean {
  if (!tags) return false;
  return tags.some(
    (tag) =>
      tag.name === MISSION_SESSION_TAG &&
      (tag.metadata?.role === DecompSessionType.Orchestrator ||
        tag.metadata?.role === DecompSessionType.Worker)
  );
}

/**
 * Enforce mission access policy at the daemon level.
 * Called before allowing a session to enter mission mode.
 * Reads the resolved settings (which include org-level missionPolicy)
 * and blocks restricted users.
 *
 * @throws {MetaError} If the user is restricted from using missions
 */
export async function enforceMissionPolicyForDaemon(
  interactionMode: DroolInteractionMode | undefined,
  userId: string,
  decompSessionType?: DecompSessionType,
  tags?: SessionTag[]
): Promise<void> {
  const isMissionEntry =
    interactionMode === DroolInteractionMode.Mission ||
    decompSessionType === DecompSessionType.Orchestrator ||
    decompSessionType === DecompSessionType.Worker ||
    hasMissionTags(tags);
  if (!isMissionEntry) {
    return;
  }

  const settingsManager = SettingsManager.getInstance();
  settingsManager.refresh();
  const resolved = await settingsManager.getResolvedSettings();
  const policy = resolved.general?.missionPolicy;

  if (!policy || !policy.restrictedAccess) {
    return;
  }

  const allowedUserIds = policy.allowedUserIds ?? [];
  const isAllowed = allowedUserIds.includes(userId);

  logInfo('[Daemon] Enforcing mission policy', {
    userId,
    success: isAllowed,
    isEnabled: !policy.restrictedAccess,
    count: allowedUserIds.length,
  });

  if (!isAllowed) {
    throw new MetaError(
      'Missions have been restricted by your organization admin. Contact your admin to request access.'
    );
  }
}
