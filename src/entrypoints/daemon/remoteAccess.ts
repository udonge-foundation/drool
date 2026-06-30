import os from 'os';

import { ManagedSettingsResponse } from '@industry/common/settings';
import { droolApi } from '@industry/drool-core/api/drool';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import {
  getAuthedUser,
  getFreshTokenWithSource,
  TokenSourceType,
} from '@industry/runtime/auth';
import {
  ComputerRegistrationReconcileStatus,
  hasComputerRegistration,
  reconcileComputerRegistration,
  type RegisteredHostIdentity,
} from '@industry/runtime/computer';
import {
  getHostIdentityService,
  getHostIdentityAuthContext,
} from '@industry/runtime/host';
import { normalizeComputerName } from '@industry/utils/computers';

import {
  getComputerById,
  registerByomComputer,
  repairComputerHostId,
  updateComputerRemoteUser,
} from '@/api/computer';
import { getRuntimeAuthConfig } from '@/environment';
import { getI18n } from '@/i18n';
import { promptForYesNo, promptLine } from '@/utils/prompt';

import type { AuthCredential } from '@industry/common/api/shared';
import type {
  ResolvedComputerRegistration,
  ResolvedHostIdentity,
} from '@industry/drool-sdk-ext/protocol/host';

interface ResolvedRelayConfig {
  relayUrl: string;
  computerId: string;
  computerName: string;
  /**
   * Resolves the relay auth credential. Called once at startup (fail-fast)
   * and again on every relay reconnect so that expired WorkOS access
   * tokens get refreshed instead of being frozen at daemon boot.
   */
  resolveCredential: () => Promise<AuthCredential>;
}

function getRemoteAccessRegistrationRequiredMessage(): string {
  return getI18n().t('commands:daemon.remoteAccessRegistrationRequired');
}

const BYOM_ADMIN_DISABLED_MESSAGE =
  'BYOM computers have been disabled by your organization administrator.';

/**
 * If the org admin has set `managedSettings.byomComputersEnabled = false`,
 * refuse to start remote access.
 */
export async function assertByomComputersAdminEnabled(): Promise<void> {
  // Fail closed: any error from getManagedSettings propagates as-is and
  // aborts remote-access startup, so a transient failure can't be used
  // to bypass an admin policy that explicitly disables BYOM computers.
  const body: ManagedSettingsResponse = await droolApi.getManagedSettings();

  if (body.success === true && body.settings?.byomComputersEnabled === false) {
    throw new MetaError(BYOM_ADMIN_DISABLED_MESSAGE);
  }
}

function getRelayAuthCredentialRequiredMessage(): string {
  return getI18n().t('commands:daemon.relayAuthCredentialRequired');
}

function getRelayConfigResolutionFailedMessage(): string {
  return getI18n().t('commands:daemon.relayConfigResolutionFailed');
}

function writeStdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function getHostAuthContext() {
  return getHostIdentityAuthContext(() =>
    getAuthedUser(getRuntimeAuthConfig())
  );
}

export async function readHostIdentity(): Promise<ResolvedHostIdentity> {
  return getHostIdentityService().getHostIdentity(await getHostAuthContext());
}

async function promptForRegistrationConfirmation(): Promise<boolean> {
  return promptForYesNo(getI18n().t('commands:daemon.promptRegisterNow'), {
    invalidAnswerMessage: getI18n().t('commands:daemon.promptInvalidYesNo'),
  });
}

async function promptForComputerName(): Promise<string> {
  const defaultName = normalizeComputerName(os.hostname());
  const answer = await promptLine(
    getI18n().t('commands:daemon.promptComputerName', { defaultName })
  );
  return answer || defaultName;
}

interface EnsureRegisteredHostIdentityForRemoteAccessParams {
  getHostIdentity: () => Promise<ResolvedHostIdentity | null>;
}

export async function ensureRegisteredHostIdentityForRemoteAccess({
  getHostIdentity,
}: EnsureRegisteredHostIdentityForRemoteAccessParams): Promise<RegisteredHostIdentity> {
  await assertByomComputersAdminEnabled();
  const hostIdentity = await getHostIdentity();
  const initialAuthContext = await getHostAuthContext();
  if (initialAuthContext) {
    const reconciliation = await reconcileComputerRegistration({
      authContext: initialAuthContext,
      hostIdentity,
      backend: {
        getComputerById,
        repairComputerHostId,
      },
    });
    if (reconciliation.status === ComputerRegistrationReconcileStatus.Error) {
      throw new MetaError(getRelayConfigResolutionFailedMessage(), {
        computerId: reconciliation.previousComputerId,
        cause: reconciliation.error,
      });
    }
    if (
      reconciliation.status === ComputerRegistrationReconcileStatus.Registered
    ) {
      return reconciliation.hostIdentity;
    }
  } else if (hasComputerRegistration(hostIdentity)) {
    return hostIdentity;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new MetaError(getRemoteAccessRegistrationRequiredMessage());
  }

  const confirmed = await promptForRegistrationConfirmation();
  if (!confirmed) {
    throw new MetaError(getRemoteAccessRegistrationRequiredMessage());
  }

  const name = await promptForComputerName();
  const authContext = await getHostAuthContext();
  if (!authContext) {
    throw new MetaError(getRelayAuthCredentialRequiredMessage());
  }

  const hostIdentityService = getHostIdentityService();
  const { hostId } = await hostIdentityService.getHostIdentity(authContext);
  const computer = await registerByomComputer({ name, hostId });
  await hostIdentityService.saveComputerRegistration({
    computerId: computer.id,
    authContext,
  });
  writeStdout(
    getI18n().t('commands:daemon.registeredComputer', {
      name: computer.name,
      id: computer.id,
    })
  );

  const updatedHostIdentity = await getHostIdentity();
  if (hasComputerRegistration(updatedHostIdentity)) {
    return updatedHostIdentity;
  }

  throw new MetaError(getRemoteAccessRegistrationRequiredMessage());
}

export async function resolveRelayConfig(
  computerRegistration: ResolvedComputerRegistration
): Promise<ResolvedRelayConfig | null> {
  try {
    await assertByomComputersAdminEnabled();
    const computer = await getComputerById(computerRegistration.computerId);
    if (!computer?.relayAgentUrl) {
      logWarn('No relay URL available for computer', {
        computerId: computerRegistration.computerId,
      });
      return null;
    }

    // Backfill remoteUser for existing computers that don't have it
    if (!computer.remoteUser) {
      try {
        await updateComputerRemoteUser(
          computerRegistration.computerId,
          os.userInfo().username
        );
      } catch {
        logWarn(
          'Failed to backfill remoteUser on computer while resolving relay config',
          {
            computerId: computerRegistration.computerId,
          }
        );
      }
    }

    const resolveCredential = async (): Promise<AuthCredential> => {
      // A configured INDUSTRY_API_KEY always takes priority over WorkOS, so the
      // baked-in machine key can't be shadowed by a stored WorkOS session that
      // later expires/revokes and strands the computer.
      const tokenWithSource = await getFreshTokenWithSource(
        getRuntimeAuthConfig()
      );
      if (!tokenWithSource) {
        throw new MetaError(getRelayAuthCredentialRequiredMessage(), {
          computerId: computerRegistration.computerId,
        });
      }
      return tokenWithSource.type === TokenSourceType.ApiKey
        ? ({ apiKey: tokenWithSource.token } satisfies AuthCredential)
        : ({ token: tokenWithSource.token } satisfies AuthCredential);
    };

    // Call the resolver once at startup so we fail fast if no credential
    // is available — matches the pre-refactor behaviour. The same
    // resolver is then handed to RelayConnection so that subsequent
    // reconnects re-read storage and refresh expired WorkOS tokens.
    await resolveCredential();

    return {
      relayUrl: computer.relayAgentUrl,
      computerId: computerRegistration.computerId,
      computerName: computer.name,
      resolveCredential,
    };
  } catch (error) {
    if (error instanceof MetaError) {
      throw error;
    }

    throw new MetaError(getRelayConfigResolutionFailedMessage(), {
      computerId: computerRegistration.computerId,
      cause: error,
    });
  }
}
