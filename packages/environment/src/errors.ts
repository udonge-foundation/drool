import { MetaError, type LogMetadata } from '@industry/common/errors';

/**
 * Error thrown when environment configuration is invalid or missing.
 */
export class EnvironmentError extends MetaError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, metadata);
    Object.setPrototypeOf(this, EnvironmentError.prototype);
    this.name = 'EnvironmentError';
  }
}
