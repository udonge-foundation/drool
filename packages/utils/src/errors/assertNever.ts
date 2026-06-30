import { MetaError } from '@industry/logging/errors';

/**
 * Exhaustive check helper for discriminated unions / switch statements.
 *
 * By typing the parameter as `never`, TypeScript will produce a compile-time
 * error if any variant of the union is not handled before reaching this call.
 * At runtime it throws a MetaError as a safety net in case the value somehow
 * slips through (e.g. untyped JS callers or unexpected data).
 *
 * Usage:
 * ```ts
 * switch (action.type) {
 *   case 'a': …; break;
 *   case 'b': …; break;
 *   default: assertNever(action); // TS error if a new variant isn't handled
 * }
 * ```
 */
export function assertNever(value: never, message?: string): never {
  throw new MetaError(message ?? 'Unexpected value', { value });
}
