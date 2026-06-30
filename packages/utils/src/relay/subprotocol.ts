import {
  RELAY_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION_INITIATE_PING,
  RELAY_SUBPROTOCOL_PREFIX,
} from '@industry/common/relay';

function subprotocolToken(version: number): string {
  return `${RELAY_SUBPROTOCOL_PREFIX}.${version}`;
}

/**
 * Integer version of a canonical relay subprotocol token, or null.
 * The suffix must be a canonical positive integer (no leading zeros,
 * sign, or decimal/exponent forms) so we never treat a non-canonical
 * token like `industry-relay.01` as equivalent to `industry-relay.1`;
 * echoing the reconstructed form would violate RFC 6455's requirement
 * to echo a token the client actually offered.
 */
function parseRelayProtocolVersion(token: string): number | null {
  const prefix = `${RELAY_SUBPROTOCOL_PREFIX}.`;
  if (!token.startsWith(prefix)) return null;
  const suffix = token.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(suffix)) return null;
  return Number(suffix);
}

/**
 * Descending subprotocol offer (e.g. `['industry-relay.2','industry-relay.1']`).
 * RFC 6455 requires the server to echo a token the client offered, so the
 * daemon offers every version down to 1. This lets a rolled-back relay
 * (whose max version is below the daemon's) still negotiate a shared version.
 */
export function relaySubprotocolOffer(
  maxVersion: number = RELAY_PROTOCOL_VERSION
): string[] {
  const offer: string[] = [];
  for (let version = maxVersion; version >= 1; version--) {
    offer.push(subprotocolToken(version));
  }
  return offer;
}

/**
 * Server-side selection: highest mutually supported subprotocol token,
 * or null. Echoes back the exact trimmed token the client offered
 * (never a reconstructed one) so the response always matches an
 * offered token as RFC 6455 requires.
 */
export function negotiateRelaySubprotocol(
  offeredHeader: string | null | undefined,
  serverMaxVersion: number = RELAY_PROTOCOL_VERSION
): string | null {
  if (!offeredHeader) return null;
  let best = 0;
  let bestToken: string | null = null;
  for (const raw of offeredHeader.split(',')) {
    const token = raw.trim();
    const version = parseRelayProtocolVersion(token);
    if (version !== null && version <= serverMaxVersion && version > best) {
      best = version;
      bestToken = token;
    }
  }
  return bestToken;
}

/** Negotiated integer version from a selected token (0 when none). */
function relayNegotiatedVersion(selected: string | null | undefined): number {
  if (!selected) return 0;
  return parseRelayProtocolVersion(selected) ?? 0;
}

/** Whether the negotiated version enables relay-initiated ping/pong. */
export function relaySupportsInitiatePing(
  selected: string | null | undefined
): boolean {
  return (
    relayNegotiatedVersion(selected) >= RELAY_PROTOCOL_VERSION_INITIATE_PING
  );
}
