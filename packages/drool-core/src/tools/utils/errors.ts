import { LogMetadata } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

/**
 * Custom error class for patch parsing and application errors
 */
export class PatchApplicationError extends MetaError {
  constructor(message: string, options?: LogMetadata) {
    super(message, options);
    this.name = 'PatchApplicationError';
    Object.setPrototypeOf(this, PatchApplicationError.prototype);
  }
}
