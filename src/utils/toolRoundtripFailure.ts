import type { ToolRoundtripFailure } from '@/utils/toolRoundtripFailure/types';

function stringifyFailureData(data: unknown): string | undefined {
  if (data === undefined || data === null) {
    return undefined;
  }

  if (typeof data === 'string') {
    return data;
  }

  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function truncate(value: string, maxLength = 200): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

function isNoActiveListenerFailure(failure: ToolRoundtripFailure): boolean {
  const haystack = `${failure.message} ${stringifyFailureData(failure.data) ?? ''}`;
  return /no active listener for session/i.test(haystack);
}

export function formatToolRoundtripFailure(
  failure: ToolRoundtripFailure
): string {
  if (isNoActiveListenerFailure(failure)) {
    return 'UI disconnected (no active listener)';
  }

  const message = failure.message.trim() || 'Request failed';
  const data = stringifyFailureData(failure.data);

  const withCode =
    failure.code !== undefined ? `[code ${failure.code}] ${message}` : message;

  if (!data || data.trim() === '' || data === message) {
    return withCode;
  }

  return `${withCode}: ${truncate(data)}`;
}
