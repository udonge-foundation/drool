import { ComputerProviderType } from '@industry/common/api/v0/computers';
import { MetaError } from '@industry/logging/errors';

/**
 * Minimal computer fields needed to determine connection URL.
 * This matches the shape of the Computer API type but only includes
 * the fields needed for connection decisions.
 */
interface GetComputerConnectionParams {
  /** Relay client WebSocket URL (all computers route through relay) */
  relayClientUrl?: string;
  /** Provider type (BYOM or E2B) */
  providerType: ComputerProviderType;
}

/**
 * Information about how to connect to a computer daemon.
 */
interface GetComputerConnectionResult {
  /** WebSocket URL to connect to the computer daemon */
  url: string;
  /** Whether this is a managed (non-BYOM) computer */
  isManaged: boolean;
}

/**
 * Determine the WebSocket URL and connection type for a computer.
 *
 * All computer connections route through the Industry relay.
 *
 * @param computer - Computer object with connection fields
 * @returns Connection info with URL and managed flag
 * @throws {MetaError} If computer has no relayClientUrl (not fully provisioned)
 *
 * @example
 * ```typescript
 * const { url, isManaged } = getComputerConnectionInfo(computer);
 * ```
 */
export function getComputerConnectionInfo(
  computer: GetComputerConnectionParams
): GetComputerConnectionResult {
  if (!computer.relayClientUrl) {
    throw new MetaError(
      'Computer has no connection URL — it may not be fully provisioned'
    );
  }

  return {
    url: computer.relayClientUrl,
    isManaged: computer.providerType !== ComputerProviderType.Byom,
  };
}
