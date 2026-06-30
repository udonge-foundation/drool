import _ from 'lodash';

import { ExecutionEnvironment } from './enums';
import { LogMetadata } from './metadata/types';

export function getErrorStack(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || '';
  }

  if (_.has(error, 'stack') && typeof error.stack === 'string') {
    return error.stack;
  }

  return '';
}

export function getCause(error: unknown): unknown | undefined {
  if (error instanceof Error) {
    return error.cause;
  }
  return undefined;
}

export function getNameAndMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  if (
    _.has(error, 'name') &&
    _.has(error, 'message') &&
    typeof error.name === 'string' &&
    typeof error.message === 'string'
  ) {
    return `${error.name}: ${error.message}`;
  }

  if (_.has(error, 'name') && typeof error.name === 'string') {
    return error.name;
  }

  return '';
}

function extractKeyFromPath(path: string, key: string): string | null {
  const pathSegments = path.split('/').filter(Boolean);
  const keyIndex = pathSegments.indexOf(key);
  if (keyIndex !== -1 && pathSegments[keyIndex + 1]) {
    return pathSegments[keyIndex + 1];
  }
  return null;
}

export function extractOrgIdFromPath(path: string): string | null {
  return extractKeyFromPath(path, 'organizations');
}

export function extractSessionIdFromPath(path: string): string | null {
  return extractKeyFromPath(path, 'sessions');
}

/**
 * Returns the current execution environment (client or server) based on the presence of the window object or Node.js environment variables.
 */
export function getExecutionEnvironment(
  nextRuntime?: string
): ExecutionEnvironment {
  // Check for window object (only exists in browser/client environment)
  if (typeof window !== 'undefined') {
    return ExecutionEnvironment.CLIENT;
  }

  // Check for specific Node.js/server environment variables
  if (
    typeof process !== 'undefined' &&
    process.versions &&
    process.versions.node
  ) {
    return ExecutionEnvironment.SERVER;
  }

  // Optional signal for Next.js server components.
  // Callers can pass this when they already have runtime config available.
  // The default branch remains fully environment-agnostic.
  if (nextRuntime === 'nodejs') {
    return ExecutionEnvironment.SERVER;
  }

  // Default to client if environment is ambiguous
  return ExecutionEnvironment.CLIENT;
}

export function toSentryError(
  error: unknown,
  message: string,
  cause?: unknown
): Error {
  const sentryErrorOptions = cause === undefined ? undefined : { cause };
  const sentryError = new Error(message, sentryErrorOptions);
  // Sentry uses the Error name as the title of the issue and the message as the subtitle
  // https://github.com/getsentry/sentry-react-native/issues/1033#issuecomment-2143619805.
  sentryError.name = getNameAndMessage(error);
  sentryError.stack = getErrorStack(error);
  if (cause) sentryError.cause = cause;
  return sentryError;
}

export function normalizedMetadata(
  metadata: Record<string, unknown> | LogMetadata | undefined
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([_key, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        value instanceof Error
          ? {
              name: value.name,
              message: value.message,
              stack: value.stack,
            }
          : value,
      ])
  );
}
