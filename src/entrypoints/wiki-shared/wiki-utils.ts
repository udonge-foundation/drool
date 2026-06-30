import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { fetchFeatureFlags } from '@industry/runtime/feature-flags';

/**
 * Writes a message to stdout with a trailing newline.
 */
export function writeStdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * Writes a message to stderr with a trailing newline.
 */
export function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Asserts that the Wiki feature flag is enabled for the current user/org.
 * Throws `WIKI_FEATURE_DISABLED` or `WIKI_FEATURE_UNVERIFIED` on failure.
 */
export async function assertWikiFeatureEnabled(): Promise<void> {
  const flags = await fetchFeatureFlags();
  const wikiFlag = flags[IndustryFeatureFlags.Wiki.statsigName];

  if (wikiFlag === false) {
    throw new Error('WIKI_FEATURE_DISABLED');
  }

  if (wikiFlag !== true) {
    throw new Error('WIKI_FEATURE_UNVERIFIED');
  }
}

/**
 * Extracts a descriptive error message from a 403 response body.
 * Tries to parse JSON with an `error` or `message` field first,
 * then falls back to raw text.
 */
export async function extract403Message(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) {
    return 'Access forbidden (403)';
  }
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    if (typeof json.error === 'string') return json.error;
    if (typeof json.message === 'string') return json.message;
  } catch {
    // Not JSON – use raw text
  }
  return text;
}

/**
 * Returns true when the error message looks like a network-level failure
 * (connection refused / timeout / fetch failure / generic network).
 */
export function isNetworkErrorMessage(message: string): boolean {
  return (
    message.includes('ECONNREFUSED') ||
    message.includes('ETIMEDOUT') ||
    message.includes('fetch failed') ||
    message.includes('network')
  );
}
