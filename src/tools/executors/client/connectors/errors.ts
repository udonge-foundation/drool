import { MetaError } from '@industry/logging/errors';

/**
 * Thrown when the connectors API returns a payload that does not match the
 * expected `tools/list` shape. Distinct from network/HTTP errors so callers can
 * surface the precise "unexpected response" feedback.
 */
export class ConnectorToolsResponseError extends MetaError {
  constructor() {
    super('Unexpected response shape from the connectors API.');
    // MetaError's constructor forces its own prototype; reset it so
    // `instanceof ConnectorToolsResponseError` holds for the locally-caught
    // sentinel.
    Object.setPrototypeOf(this, ConnectorToolsResponseError.prototype);
    this.name = 'ConnectorToolsResponseError';
  }
}
