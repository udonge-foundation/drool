import { existsSync } from 'fs';
import { appendFile, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

import { DROOL_ENV_SHELL_SNIPPET } from '@industry/common/api/v0/computers';
import { logException, logInfo } from '@industry/logging';

const MARKER_BEGIN = '# >>> industry drool managed env >>>';
const MARKER_END = '# <<< industry drool managed env <<<';

/**
 * Ensure interactive/SSH login shells on a managed computer load the machine
 * environment (INDUSTRY_API_KEY, REMOTE_MACHINE_ID, ...).
 *
 * Provisioning writes a system-wide `/etc/profile.d` drop-in, but that only
 * lands on newly provisioned computers. Existing computers reach this code via
 * the daemon's auto-update, so the daemon self-heals on startup by appending an
 * idempotent, marker-delimited block to the user's `~/.profile` (owned by the
 * daemon's own user, so no privilege escalation is needed). Without it, an
 * interactive `drool` started over SSH sees no API key, prompts a WorkOS
 * sign-in, and writes shared credentials that shadow the daemon's baked key.
 *
 * Gated by the caller on `MachineType.Computer`, which is only ever set on E2B
 * managed computers (the same gate HeartbeatService uses for Computer-only
 * behaviour). Best-effort: failures are logged but never block daemon startup.
 */
export async function ensureManagedLoginShellEnv(
  homeDir: string = homedir()
): Promise<void> {
  const profilePath = join(homeDir, '.profile');
  const block = `${MARKER_BEGIN}\n${DROOL_ENV_SHELL_SNIPPET}\n${MARKER_END}\n`;

  try {
    // A missing ~/.profile is expected (appendFile creates it). Reading only
    // when it exists keeps any real read failure in the outer handler.
    const existing = existsSync(profilePath)
      ? await readFile(profilePath, 'utf8')
      : '';

    if (existing.includes(MARKER_BEGIN)) return;

    const separator =
      existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await appendFile(profilePath, `${separator}${block}`);
    logInfo('Ensured managed login-shell env hook', { path: profilePath });
  } catch (error) {
    logException(error, 'Failed to ensure managed login-shell env hook', {
      path: profilePath,
    });
  }
}
