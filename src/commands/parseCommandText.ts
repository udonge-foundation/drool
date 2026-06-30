import shellQuote from 'shell-quote';

import { logWarn } from '@industry/logging';

export function parseCommandText(
  commandText: string
): { commandName: string; args: string[] } | null {
  const trimmed = commandText.trim();
  if (!trimmed) {
    return null;
  }

  const normalizedText = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;

  let parts: string[];
  try {
    parts = shellQuote.parse(normalizedText).map((part) => part.toString());
  } catch {
    // shell-quote throws synchronously on inputs containing shell-substitution
    // syntax (e.g. `${error:msg}` in a TS template literal), which is common
    // in pasted code that happens to start with "/". Treat unparseable input
    // as "not a slash command" rather than crashing the CLI.
    // Static message only — input content and the thrown error message may
    // contain user paste data, which the CMEK logging policy forbids.
    logWarn(
      'parseCommandText: shell-quote parse failed, treating input as chat message'
    );
    return null;
  }

  if (parts.length === 0) {
    return null;
  }

  return {
    commandName: parts[0].toLowerCase(),
    args: parts.slice(1),
  };
}
