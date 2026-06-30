import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import sshpk from 'sshpk';

import { MetaError, logWarn } from '@industry/logging';

interface AppendSshKeyParams {
  authorizedKeysPath: string;
  publicKey: string;
}

interface AuthorizedKeysPathParams {
  authorizedKeysPath: string;
}

interface PublicKeyParams {
  publicKey: string;
}

function getWindowsProgramDataPath(): string | undefined {
  const driveMatch = os.homedir().match(/^([A-Z]:)\\Users\\/i);
  return driveMatch ? `${driveMatch[1]}\\ProgramData` : undefined;
}

function appendSshKey({
  authorizedKeysPath,
  publicKey,
}: AppendSshKeyParams): void {
  let existingKeys = '';
  if (fs.existsSync(authorizedKeysPath)) {
    existingKeys = fs.readFileSync(authorizedKeysPath, 'utf-8');
  }

  if (existingKeys.includes(publicKey)) return;

  const newContent =
    existingKeys.endsWith('\n') || existingKeys === ''
      ? `${existingKeys + publicKey}\n`
      : `${existingKeys}\n${publicKey}\n`;

  fs.writeFileSync(authorizedKeysPath, newContent, { mode: 0o600 });
}

function lockDownWindowsAdminAuthorizedKeys({
  authorizedKeysPath,
}: AuthorizedKeysPathParams): void {
  // Use well-known SIDs instead of localized account names:
  // S-1-5-32-544 = BUILTIN\Administrators, S-1-5-18 = Local System.
  const result = spawnSync(
    'icacls',
    [
      authorizedKeysPath,
      '/inheritance:r',
      '/grant',
      '*S-1-5-32-544:F',
      '/grant',
      '*S-1-5-18:F',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  if (result.status !== 0) {
    logWarn('Failed to update Windows administrators_authorized_keys ACL', {
      stderr: result.stderr?.toString() ?? '',
    });
  }
}

function installWindowsAdminSshKey({
  publicKey,
  programData,
}: PublicKeyParams & { programData?: string }): void {
  if (process.platform !== 'win32' || !programData) return;

  const sshDir = path.join(programData, 'ssh');
  const authorizedKeysPath = path.join(
    sshDir,
    'administrators_authorized_keys'
  );

  try {
    if (!fs.existsSync(sshDir)) {
      fs.mkdirSync(sshDir, { recursive: true });
    }
    appendSshKey({ authorizedKeysPath, publicKey });
    lockDownWindowsAdminAuthorizedKeys({ authorizedKeysPath });
  } catch (err) {
    logWarn('Failed to install SSH key for Windows administrator login', {
      cause: err,
    });
  }
}

/**
 * Install an SSH public key into ~/.ssh/authorized_keys.
 * Validates the key structurally via sshpk, ensures the .ssh directory exists,
 * and appends the key if not already present.
 */
export function installSshKey(publicKey: string): void {
  const trimmed = publicKey.trim();
  try {
    sshpk.parseKey(trimmed, 'ssh');
  } catch (err) {
    logWarn('Failed to parse SSH public key', { cause: err });
    throw new MetaError('Invalid SSH public key');
  }

  const sshDir = path.join(os.homedir(), '.ssh');
  const authorizedKeysPath = path.join(sshDir, 'authorized_keys');

  if (!fs.existsSync(sshDir)) {
    fs.mkdirSync(sshDir, { mode: 0o700, recursive: true });
  }

  appendSshKey({ authorizedKeysPath, publicKey: trimmed });
  installWindowsAdminSshKey({
    publicKey: trimmed,
    programData: getWindowsProgramDataPath(),
  });
}
