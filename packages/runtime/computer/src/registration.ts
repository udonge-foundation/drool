import { logException, logWarn } from '@industry/logging';
import { getHostIdentityService } from '@industry/runtime/host';

import {
  ComputerRegistrationClearedReason,
  ComputerRegistrationReconcileStatus,
} from './enums';

import type {
  ReconcileComputerRegistrationParams,
  ReconcileComputerRegistrationResult,
  RegisteredHostIdentity,
} from './types';
import type { Computer } from '@industry/common/api/v0/computers';
import type { ResolvedHostIdentity } from '@industry/drool-sdk-ext/protocol/host';
import type { HostIdentityAuthContext } from '@industry/runtime/host';

/** Return true when a resolved host identity includes an active local computer registration. */
export function hasComputerRegistration(
  hostIdentity: ResolvedHostIdentity | null
): hostIdentity is RegisteredHostIdentity {
  return hostIdentity?.computerRegistration !== undefined;
}

/** Clear local computer registration while preserving the stable host identity. */
export async function clearLocalComputerRegistration(
  authContext: HostIdentityAuthContext
): Promise<void> {
  await getHostIdentityService().removeComputerRegistration(authContext);
}

/**
 * Reconcile local computer registration against backend Computer state.
 *
 * Definitive stale states clear the local registration unless caller
 * confirmation is requested. Uncertain backend lookup failures return `Error`
 * and preserve local state.
 */
export async function reconcileComputerRegistration({
  authContext,
  hostIdentity,
  backend,
  clearStaleRegistration = true,
}: ReconcileComputerRegistrationParams): Promise<ReconcileComputerRegistrationResult> {
  if (!hasComputerRegistration(hostIdentity)) {
    return { status: ComputerRegistrationReconcileStatus.Missing };
  }

  const { computerRegistration } = hostIdentity;
  const computerId = computerRegistration.computerId;
  let computer: Computer | null;
  try {
    computer = await backend.getComputerById(computerId);
  } catch (error) {
    logException(
      error,
      'Failed to verify local computer registration on backend',
      {
        computerId,
      }
    );
    return {
      status: ComputerRegistrationReconcileStatus.Error,
      previousComputerId: computerId,
      error,
      hostIdentity,
    };
  }

  if (!computer) {
    logWarn(
      'Local computer registration no longer exists on backend; clearing local registration',
      { computerId }
    );
    if (clearStaleRegistration) {
      await clearLocalComputerRegistration(authContext);
    }
    return {
      status: clearStaleRegistration
        ? ComputerRegistrationReconcileStatus.Cleared
        : ComputerRegistrationReconcileStatus.Stale,
      previousComputerId: computerId,
      reason: ComputerRegistrationClearedReason.BackendMissing,
    };
  }

  if (!computer.hostId) {
    try {
      await backend.repairComputerHostId({
        computerId,
        hostId: hostIdentity.hostId,
      });
    } catch (error) {
      logException(
        error,
        '[computer] Failed to repair backend computer hostId',
        {
          computerId,
        }
      );
      return {
        status: ComputerRegistrationReconcileStatus.Error,
        previousComputerId: computerId,
        error,
        hostIdentity,
      };
    }
  } else if (computer.hostId !== hostIdentity.hostId) {
    logWarn('Backend computer hostId conflicts with local host identity', {
      computerId,
    });
    if (clearStaleRegistration) {
      await clearLocalComputerRegistration(authContext);
    }
    return {
      status: clearStaleRegistration
        ? ComputerRegistrationReconcileStatus.Cleared
        : ComputerRegistrationReconcileStatus.Stale,
      previousComputerId: computerId,
      reason: ComputerRegistrationClearedReason.HostConflict,
    };
  }

  return {
    status: ComputerRegistrationReconcileStatus.Registered,
    computer,
    hostIdentity,
  };
}
