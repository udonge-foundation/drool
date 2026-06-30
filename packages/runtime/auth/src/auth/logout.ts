/**
 * Logout - clear stored credentials.
 */

import { getCredentialsStorage } from '../credentials/CredentialsStorage';
import { clearUserCache } from './common/cache';

import type { RuntimeAuthConfig } from './common/types';

/**
 * DESTRUCTIVE: Permanently deletes all stored credentials from disk.
 *
 * This will:
 * - Delete the currently used credentials file
 * - Clear the in-memory user cache
 *
 * After calling this, the user will need to re-authenticate.
 *
 * WARNING: Only call this for explicit user sign-out actions.
 * Do NOT call this on errors - it will force the user to re-login.
 *
 * Note: This does not revoke tokens on the server side.
 */
export async function logout(config: RuntimeAuthConfig): Promise<void> {
  const storage = getCredentialsStorage({
    disableKeyring: config.disableKeyring,
  });
  await storage.clear();
  clearUserCache();
}
