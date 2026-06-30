import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';

import {
  StructuredOutputErrorCode,
  type OutputFormat,
} from '@industry/drool-sdk-ext/protocol/drool';
import { logWarn } from '@industry/logging';

import type { StructuredOutputValidationResult } from './structured-output/types';

const ajv = new Ajv({
  allErrors: true,
  strict: false,
});
addFormats(ajv);
const validatorCache = new WeakMap<
  Record<string, unknown>,
  ReturnType<typeof ajv.compile>
>();

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return 'Structured output does not match the requested schema.';
  }

  return errors
    .map((error) => {
      const path = error.instancePath || '/';
      return `${path} ${error.message ?? 'is invalid'}`;
    })
    .join('; ');
}

export function validateStructuredOutput(
  value: unknown,
  outputFormat: OutputFormat
): StructuredOutputValidationResult {
  if (!isJsonObject(value)) {
    return {
      ok: false,
      code: StructuredOutputErrorCode.InvalidStructuredOutput,
      message: 'Structured output must be a JSON object.',
    };
  }

  let validate: ReturnType<typeof ajv.compile>;
  try {
    const cached = validatorCache.get(outputFormat.schema);
    if (cached) {
      validate = cached;
    } else {
      validate = ajv.compile(outputFormat.schema);
      validatorCache.set(outputFormat.schema, validate);
    }
  } catch (error) {
    logWarn('[StructuredOutput] Invalid output schema', { cause: error });
    return {
      ok: false,
      code: StructuredOutputErrorCode.InvalidSchema,
      message:
        error instanceof Error
          ? error.message
          : 'The requested structured output schema is invalid.',
    };
  }

  if (!validate(value)) {
    const details = validate.errors ?? undefined;
    return {
      ok: false,
      code: StructuredOutputErrorCode.SchemaValidationFailed,
      message: formatAjvErrors(validate.errors),
      details,
    };
  }

  return { ok: true, value };
}
