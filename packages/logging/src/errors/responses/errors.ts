import { LogMetadata } from '../../metadata/types';
import { HttpStatusTitle } from '../constants';
import { HttpStatusCode } from '../enums';
import { PublicErrorResponse } from '../types';

// Never use this class directly, use the specific error functions instead
export class ResponseError extends Error {
  readonly statusCode: HttpStatusCode;

  metadata?: LogMetadata;

  constructor(
    message: string,
    statusCode: HttpStatusCode,
    metadata?: LogMetadata
  ) {
    super(message);
    this.name = 'ResponseError';
    this.metadata = metadata;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, ResponseError.prototype);
  }

  toPublicObject(): PublicErrorResponse {
    const base: PublicErrorResponse = {
      detail: this.message,
      status: this.statusCode,
      title: HttpStatusTitle[this.statusCode],
    };
    // Pass through the `displayToUser` flag from metadata when set so
    // clients can render `detail` verbatim instead of parsing it.
    //
    // We also mirror the public fields under an `error` key. The
    // OpenAI SDK's `APIError.generate(status, body, ...)` reads only
    // `body.error` and discards the rest of the body — so flat fields
    // would be lost on OpenAI-compat clients (e.g. Drool Core models
    // routed through the OpenAI proxy). Anthropic-SDK clients keep
    // `body` whole and read `error.error`, so the duplicate is safe.
    if (this.metadata && this.metadata.displayToUser === true) {
      base.displayToUser = true;
      base.error = { ...base };
    }
    return base;
  }

  toDebugObject(): LogMetadata {
    const metadata = this.metadata || {};
    return {
      ...this.toPublicObject(),
      cause: this,
      ...metadata,
    };
  }
}

export class ResponseError400BadRequest extends ResponseError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, HttpStatusCode.BadRequest, metadata);
    this.name = 'ResponseError400BadRequest';
    Object.setPrototypeOf(this, ResponseError400BadRequest.prototype);
  }
}
export class ResponseError401Unauthorized extends ResponseError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, HttpStatusCode.Unauthorized, metadata);
    this.name = 'ResponseError401Unauthorized';
    Object.setPrototypeOf(this, ResponseError401Unauthorized.prototype);
  }
}

export class ResponseError402PaymentRequired extends ResponseError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, HttpStatusCode.PaymentRequired, metadata);
    this.name = 'ResponseError402PaymentRequired';
    Object.setPrototypeOf(this, ResponseError402PaymentRequired.prototype);
  }
}

export class ResponseError403Forbidden extends ResponseError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, HttpStatusCode.Forbidden, metadata);
    this.name = 'ResponseError403Forbidden';
    Object.setPrototypeOf(this, ResponseError403Forbidden.prototype);
  }
}

export class ResponseError404NotFound extends ResponseError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, HttpStatusCode.NotFound, metadata);
    this.name = 'ResponseError404NotFound';
    Object.setPrototypeOf(this, ResponseError404NotFound.prototype);
  }
}

export class ResponseError409RetryConflict extends ResponseError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, HttpStatusCode.Conflict, metadata);
    this.name = 'ResponseError409RetryConflict';
    Object.setPrototypeOf(this, ResponseError409RetryConflict.prototype);
  }
}

export class ResponseError409Conflict extends ResponseError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, HttpStatusCode.Conflict, metadata);
    this.name = 'ResponseError409Conflict';
    Object.setPrototypeOf(this, ResponseError409Conflict.prototype);
  }
}

export class ResponseError410Gone extends ResponseError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, HttpStatusCode.Gone, metadata);
    this.name = 'ResponseError410Gone';
    Object.setPrototypeOf(this, ResponseError410Gone.prototype);
  }
}

export class ResponseError413ContentTooLarge extends ResponseError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, HttpStatusCode.ContentTooLarge, metadata);
    this.name = 'ResponseError413ContentTooLarge';
    Object.setPrototypeOf(this, ResponseError413ContentTooLarge.prototype);
  }
}

export class ResponseError422InvalidData extends ResponseError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, HttpStatusCode.InvalidData, metadata);
    this.name = 'ResponseError422InvalidData';
    Object.setPrototypeOf(this, ResponseError422InvalidData.prototype);
  }
}

export class ResponseError424FailedDependency extends ResponseError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, HttpStatusCode.FailedDependency, metadata);
    this.name = 'ResponseError424FailedDependency';
    Object.setPrototypeOf(this, ResponseError424FailedDependency.prototype);
  }
}

export class ResponseError429RateLimitExceeded extends ResponseError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, HttpStatusCode.RateLimitExceeded, metadata);
    this.name = 'ResponseError429RateLimitExceeded';
    Object.setPrototypeOf(this, ResponseError429RateLimitExceeded.prototype);
  }
}

export class ResponseError451UnavailableForLegalReasons extends ResponseError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, HttpStatusCode.UnavailableForLegalReasons, metadata);
    this.name = 'ResponseError451UnavailableForLegalReasons';
    Object.setPrototypeOf(
      this,
      ResponseError451UnavailableForLegalReasons.prototype
    );
  }
}

// Looking for the HTTP 500 error? Simply throw a MetaError

export class ResponseError501NotImplemented extends ResponseError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, HttpStatusCode.NotImplemented, metadata);
    this.name = 'ResponseError501NotImplemented';
    Object.setPrototypeOf(this, ResponseError501NotImplemented.prototype);
  }
}

export class ResponseError502BadGateway extends ResponseError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, HttpStatusCode.BadGateway, metadata);
    this.name = 'ResponseError502BadGateway';
    Object.setPrototypeOf(this, ResponseError502BadGateway.prototype);
  }
}

export class ResponseError503ServiceUnavailable extends ResponseError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, HttpStatusCode.ServiceUnavailable, metadata);
    this.name = 'ResponseError503ServiceUnavailable';
    Object.setPrototypeOf(this, ResponseError503ServiceUnavailable.prototype);
  }
}

export class ResponseError504GatewayTimeout extends ResponseError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, HttpStatusCode.GatewayTimeout, metadata);
    this.name = 'ResponseError504GatewayTimeout';
    Object.setPrototypeOf(this, ResponseError504GatewayTimeout.prototype);
  }
}
