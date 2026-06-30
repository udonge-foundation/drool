import os from 'os';

import { AuthenticationError, isFetchError } from '@industry/logging/errors';
import { getAuthedUser } from '@industry/runtime/auth';
import {
  clearLocalComputerRegistration,
  ComputerRegistrationClearedReason,
  ComputerRegistrationReconcileStatus,
  reconcileComputerRegistration,
} from '@industry/runtime/computer';
import {
  getHostIdentityService,
  getHostIdentityAuthContext,
} from '@industry/runtime/host';
import {
  normalizeComputerName,
  pickAvailableComputerName,
  validateComputerName,
} from '@industry/utils/computers';

import {
  deleteComputer,
  getComputerById,
  listComputers,
  registerByomComputer,
  repairComputerHostId,
} from '@/api/computer';
import { assertByomComputersAdminEnabled } from '@/entrypoints/daemon/remoteAccess';
import { getRuntimeAuthConfig } from '@/environment';
import { getI18n } from '@/i18n';
import { exitWithCode } from '@/utils/exitWithCode';
import { promptForYesNo, promptLine } from '@/utils/prompt';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getHostAuthContext() {
  return getHostIdentityAuthContext(() =>
    getAuthedUser(getRuntimeAuthConfig())
  );
}

async function getRequiredHostAuthContext() {
  const authContext = await getHostAuthContext();
  if (!authContext) {
    throw new AuthenticationError(
      'No authenticated user with organization available'
    );
  }
  return authContext;
}

function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

function printError(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function extractErrorDetail(error: unknown): string {
  if (isFetchError(error)) {
    const raw = error.message.replace(/^\d+\s*/, '');
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.detail === 'string') {
        return parsed.detail;
      }
    } catch {
      // Not JSON — fall through
    }
  }
  return error instanceof Error ? error.message : String(error);
}

async function tryGetComputerNameForDisplay(
  computerId: string
): Promise<string | null> {
  try {
    const computer = await getComputerById(computerId);
    return computer?.name ?? null;
  } catch {
    return null;
  }
}

function printAutostartHintForPlatform(
  t: ReturnType<typeof getI18n>['t'],
  mode: 'register' | 'remove'
): void {
  const platform = os.platform();
  const keys =
    mode === 'register'
      ? {
          darwin: 'commands:computer.registerAutostartMac',
          win32: 'commands:computer.registerAutostartWindows',
          linux: 'commands:computer.registerAutostartLinux',
        }
      : {
          darwin: 'commands:computer.removeAutostartMac',
          win32: 'commands:computer.removeAutostartWindows',
          linux: 'commands:computer.removeAutostartLinux',
        };
  if (platform === 'darwin') print(t(keys.darwin));
  else if (platform === 'win32') print(t(keys.win32));
  else print(t(keys.linux));
}

async function promptForComputerName(
  t: ReturnType<typeof getI18n>['t'],
  defaultName: string
): Promise<string> {
  while (true) {
    const answer = (
      await promptLine(
        t('commands:computer.registerNamePrompt', { default: defaultName })
      )
    ).trim();
    if (!answer) return defaultName;
    if (validateComputerName(answer) !== null) {
      printError(t('commands:computer.registerNameInvalid'));
      continue;
    }
    return answer;
  }
}

// ---------------------------------------------------------------------------
// Subcommand actions
// ---------------------------------------------------------------------------

export async function runRegister(
  nameArg: string | undefined,
  opts: { yes?: boolean }
): Promise<void> {
  const skipConfirm = Boolean(opts.yes);
  const t = getI18n().t;

  try {
    await assertByomComputersAdminEnabled();
    const hostIdentityService = getHostIdentityService();
    const authContext = await getRequiredHostAuthContext();
    const reconciliation = await reconcileComputerRegistration({
      authContext,
      hostIdentity: await hostIdentityService.getHostIdentity(authContext),
      backend: {
        getComputerById,
        repairComputerHostId,
      },
      clearStaleRegistration: false,
    });

    if (reconciliation.status === ComputerRegistrationReconcileStatus.Error) {
      printError(
        t('commands:computer.registerVerifyFailed', {
          id: reconciliation.previousComputerId,
        })
      );
      return exitWithCode(1);
    }

    if (
      reconciliation.status === ComputerRegistrationReconcileStatus.Registered
    ) {
      printError(
        t('commands:computer.alreadyRegisteredNamed', {
          name: reconciliation.computer.name,
          id: reconciliation.computer.id,
        })
      );
      return exitWithCode(1);
    }

    if (reconciliation.status === ComputerRegistrationReconcileStatus.Stale) {
      printError(
        t(
          reconciliation.reason ===
            ComputerRegistrationClearedReason.HostConflict
            ? 'commands:computer.registerHostConflictConfig'
            : 'commands:computer.registerStaleConfig',
          {
            id: reconciliation.previousComputerId,
          }
        )
      );
      const shouldClear =
        skipConfirm ||
        (await promptForYesNo(t('commands:computer.registerStaleClearPrompt'), {
          defaultValue: true,
        }));
      if (!shouldClear) {
        print(t('commands:computer.registerAborted'));
        return exitWithCode(0);
      }
      await clearLocalComputerRegistration(authContext);
      print(t('commands:computer.registerStaleCleared'));
    }

    const takenNames: string[] = await listComputers()
      .then((r) => r.computers.map((c) => c.name))
      .catch(() => []);
    const hostDefault = pickAvailableComputerName(
      normalizeComputerName(os.hostname()),
      takenNames
    );

    let computerName: string;
    if (nameArg) {
      const trimmed = nameArg.trim();
      const validationError = validateComputerName(trimmed);
      if (validationError !== null) {
        printError(
          t('commands:computer.failedToRegister', {
            message: validationError,
          })
        );
        return exitWithCode(1);
      }
      computerName = trimmed;
    } else if (skipConfirm) {
      computerName = hostDefault;
    } else {
      computerName = await promptForComputerName(t, hostDefault);
    }

    const { hostId } = await hostIdentityService.getHostIdentity(authContext);
    const computer = await registerByomComputer({
      name: computerName,
      hostId,
    });
    await hostIdentityService.saveComputerRegistration({
      computerId: computer.id,
      authContext,
    });

    print(
      t('commands:computer.registered', {
        name: computer.name,
        id: computer.id,
      })
    );
    print(t('commands:computer.registerNextStep'));
    printAutostartHintForPlatform(t, 'register');
    return exitWithCode(0);
  } catch (error) {
    printError(
      t('commands:computer.failedToRegister', {
        message: extractErrorDetail(error),
      })
    );
    return exitWithCode(1);
  }
}

export async function runRemove(opts: { yes?: boolean }): Promise<void> {
  const skipConfirm = Boolean(opts.yes);
  const t = getI18n().t;

  try {
    const hostIdentity = getHostIdentityService();
    const authContext = await getRequiredHostAuthContext();
    const registration =
      await hostIdentity.getComputerRegistration(authContext);
    if (!registration) {
      printError(t('commands:computer.noComputerRegistered'));
      return exitWithCode(1);
    }
    const computerName = await tryGetComputerNameForDisplay(
      registration.computerId
    );
    const displayName = computerName ?? registration.computerId;

    if (!skipConfirm) {
      print(
        t('commands:computer.removeWarning', {
          name: displayName,
          id: registration.computerId,
        })
      );
      const confirmed = await promptForYesNo(
        t('commands:computer.removeConfirmPrompt'),
        { defaultValue: false }
      );
      if (!confirmed) {
        print(t('commands:computer.removeAborted'));
        return exitWithCode(0);
      }
    }

    let alreadyGone = false;
    try {
      await deleteComputer(registration.computerId);
    } catch (error) {
      const isAlreadyGone =
        isFetchError(error) &&
        (error.response.status === 404 || error.response.status === 410);
      if (!isAlreadyGone) {
        throw error;
      }
      alreadyGone = true;
    }
    await hostIdentity.removeComputerRegistration(authContext);

    if (alreadyGone) {
      print(
        t('commands:computer.removeAlreadyGone', {
          id: registration.computerId,
        })
      );
      try {
        const { computers } = await listComputers();
        const hostName = normalizeComputerName(os.hostname());
        const candidate = computers.find(
          (c) => normalizeComputerName(c.name) === hostName
        );
        if (candidate) {
          print(
            t('commands:computer.removeDriftHint', {
              name: candidate.name,
              id: candidate.id,
            })
          );
        }
      } catch {
        // Best-effort; ignore.
      }
    } else {
      const successKey = computerName
        ? 'commands:computer.removedNamed'
        : 'commands:computer.removed';
      print(
        t(successKey, {
          name: computerName ?? '',
          id: registration.computerId,
        })
      );
    }

    printAutostartHintForPlatform(t, 'remove');
    return exitWithCode(0);
  } catch (error) {
    printError(
      t('commands:computer.failedToRemove', {
        message: extractErrorDetail(error),
      })
    );
    return exitWithCode(1);
  }
}

export async function runSsh(
  computerName: string,
  opts: { debug?: boolean; proxy?: boolean; port?: string }
): Promise<void> {
  const { runSshAction } = await import('@/entrypoints/computer/ssh');
  await runSshAction(computerName, opts);
}

export async function runList(): Promise<void> {
  const t = getI18n().t;

  try {
    const hostIdentity = getHostIdentityService();
    const local = await hostIdentity.getComputerRegistration(
      await getRequiredHostAuthContext()
    );
    const { computers } = await listComputers();

    if (computers.length === 0) {
      print(t('commands:computer.noComputers'));
      return exitWithCode(0);
    }

    for (const c of computers) {
      const current =
        local?.computerId === c.id ? t('commands:computer.thisMachine') : '';
      const status = c.status ?? 'unknown';
      const statusColumn = status === 'active' ? '' : `\t${status}`;
      print(`${c.name}\t${c.id}${statusColumn}${current}`);
    }
    return exitWithCode(0);
  } catch (error) {
    printError(
      t('commands:computer.failedToList', {
        message: extractErrorDetail(error),
      })
    );
    return exitWithCode(1);
  }
}
