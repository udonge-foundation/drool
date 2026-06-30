import { MetaError } from '@industry/logging/errors';

/** Every candidate AND the Opus safety-net fallback are blocked by policy. */
export class IndustryRouterUnavailableError extends MetaError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, metadata);
    this.name = 'IndustryRouterUnavailableError';
    Object.setPrototypeOf(this, IndustryRouterUnavailableError.prototype);
  }
}
