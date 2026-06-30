import type { ErrorMetadata } from './types';

/**
 * An error class that supports metadata and standard error cause.
 *
 * Lives in @industry/common so that leaf packages (e.g. @industry/environment)
 * can throw structured errors without pulling in @industry/logging.
 * @industry/logging re-exports this class from its own `errors` entry point
 * for backwards compatibility with existing `import { MetaError } from
 * '@industry/logging/errors'` consumers.
 */
export class MetaError extends Error {
  /**
   * Additional metadata associated with this error
   */
  readonly metadata?: ErrorMetadata;

  /**
   * Creates a new meta error
   * @param message The fixed error message
   * @param options Options including cause and arbitrary metadata properties
   */
  constructor(message: string, options?: ErrorMetadata) {
    const { cause, ...metadata } = options || {};
    super(message, { cause });

    // Ensure proper inheritance in transpiled JavaScript
    Object.setPrototypeOf(this, MetaError.prototype);

    this.name = 'MetaError';
    this.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
  }
}
