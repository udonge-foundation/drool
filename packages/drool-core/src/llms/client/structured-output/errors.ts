import type { StructuredOutputErrorInfo } from './types';

export class StructuredOutputError extends Error {
  readonly code: StructuredOutputErrorInfo['code'];

  readonly details?: unknown;

  constructor(info: StructuredOutputErrorInfo) {
    super(info.message);
    this.name = 'StructuredOutputError';
    this.code = info.code;
    this.details = info.details;
  }
}
