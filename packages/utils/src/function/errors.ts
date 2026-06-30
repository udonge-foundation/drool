import { MetaError } from '@industry/logging/errors';

export class RetryableError extends MetaError {
  canRetry: boolean;

  constructor(...args: ConstructorParameters<typeof MetaError>) {
    super(...args);
    Object.setPrototypeOf(this, RetryableError.prototype);
    this.name = 'RetryableError';
    this.canRetry = true;
  }
}

export class AbortError extends Error {
  constructor(message: string = 'The operation was aborted') {
    super(message);
    Object.setPrototypeOf(this, AbortError.prototype);
    this.name = 'AbortError';
  }
}
