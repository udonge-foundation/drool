const AGENT_BROWSER_COMMAND = 'agent-browser';

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

function isCommandBoundary(char: string | undefined): boolean {
  return (
    char === ';' ||
    char === '|' ||
    char === '&' ||
    char === '(' ||
    char === ')' ||
    char === '\n'
  );
}

function isNameStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_]/.test(char);
}

function isNamePart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

function skipWhitespace(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length && isWhitespace(value[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function skipShellWord(command: string, start: number): number {
  let cursor = start;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  while (cursor < command.length) {
    const char = command[cursor];

    if (escaped) {
      escaped = false;
      cursor += 1;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      escaped = true;
      cursor += 1;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      cursor += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      cursor += 1;
      continue;
    }

    if (isWhitespace(char) || isCommandBoundary(char)) break;
    cursor += 1;
  }

  return cursor;
}

function skipAssignmentWord(command: string, start: number): number {
  if (!isNameStart(command[start])) return start;

  let cursor = start + 1;
  while (cursor < command.length && isNamePart(command[cursor])) {
    cursor += 1;
  }

  if (command[cursor] !== '=') return start;

  cursor += 1;
  return skipShellWord(command, cursor);
}

function skipCommandPrefix(command: string, start: number): number {
  let cursor = skipWhitespace(command, start);

  while (cursor < command.length) {
    const nextCursor = skipAssignmentWord(command, cursor);
    if (nextCursor === cursor) break;
    cursor = skipWhitespace(command, nextCursor);
  }

  return cursor;
}

function hasCommandTokenAt(command: string, index: number): boolean {
  return (
    command.slice(index, index + AGENT_BROWSER_COMMAND.length) ===
      AGENT_BROWSER_COMMAND &&
    (index + AGENT_BROWSER_COMMAND.length === command.length ||
      isWhitespace(command[index + AGENT_BROWSER_COMMAND.length]) ||
      isCommandBoundary(command[index + AGENT_BROWSER_COMMAND.length]))
  );
}

function findNextCommandBoundary(
  command: string,
  start: number
): number | null {
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let cursor = start; cursor < command.length; cursor += 1) {
    const char = command[cursor];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (isCommandBoundary(char)) return cursor;
  }

  return null;
}

function skipBoundaryOperator(command: string, boundaryIndex: number): number {
  const char = command[boundaryIndex];
  const nextChar = command[boundaryIndex + 1];
  if (
    (char === '&' && nextChar === '&') ||
    (char === '|' && nextChar === '|')
  ) {
    return boundaryIndex + 2;
  }

  return boundaryIndex + 1;
}

export function isAgentBrowserCommand(command: string): boolean {
  let segmentStart = 0;

  while (segmentStart < command.length) {
    const commandIndex = skipCommandPrefix(command, segmentStart);
    if (hasCommandTokenAt(command, commandIndex)) return true;

    const boundaryIndex = findNextCommandBoundary(command, segmentStart);
    if (boundaryIndex === null) return false;
    segmentStart = skipBoundaryOperator(command, boundaryIndex);
  }

  return false;
}
