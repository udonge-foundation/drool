import { RelayHealthResponseSchema } from '@industry/common/relay/schemas';
import { logWarn } from '@industry/logging';

import { RelayAuthRequirement } from './enums';

function getRelayHealthUrl(relayWsUrl: string): string {
  return relayWsUrl
    .replace(/^wss:/, 'https:')
    .replace(/^ws:/, 'http:')
    .replace(/\/v0\/computer\/.*$/, '/health');
}

/**
 * Probe the relay's /health endpoint to check if it requires authentication.
 *
 * - authRequired === true   -> new relay, send relay.authenticate
 * - authRequired absent/false -> old relay, skip auth for backward compatibility
 * - fetch fails / non-200   -> probe failed, caller should decide whether to fail fast
 *
 * Temporary backward-compat shim. Once all relays are deployed
 * with auth support, remove this function and make auth unconditional.
 */
export async function probeRelayAuthRequirement(
  relayWsUrl: string
): Promise<RelayAuthRequirement> {
  try {
    // eslint-disable-next-line no-restricted-globals -- relay health URL, not the Industry backend
    const res = await fetch(getRelayHealthUrl(relayWsUrl), {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return RelayAuthRequirement.ProbeFailed;

    const result = RelayHealthResponseSchema.safeParse(await res.json());
    if (!result.success) return RelayAuthRequirement.ProbeFailed;

    return result.data.authRequired === true
      ? RelayAuthRequirement.RequiresAuth
      : RelayAuthRequirement.LegacyRelay;
  } catch (err) {
    logWarn('Failed to probe relay auth requirement', { cause: err });
    return RelayAuthRequirement.ProbeFailed;
  }
}
