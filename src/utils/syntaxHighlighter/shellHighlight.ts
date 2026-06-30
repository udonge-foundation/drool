import chalk from 'chalk';

import { SYNTAX_COLORS } from '@/utils/syntaxHighlighter/constants';

function applyColor(text: string, color: string): string {
  if (color.startsWith('#')) {
    return chalk.hex(color)(text);
  }
  const fn = (chalk as unknown as Record<string, unknown>)[color];
  return typeof fn === 'function'
    ? (fn as (str: string) => string)(text)
    : text;
}

function colorCommand(text: string): string {
  return applyColor(text, SYNTAX_COLORS['hljs-title']);
}

function colorFlag(text: string): string {
  return applyColor(text, SYNTAX_COLORS['hljs-built_in']);
}

function colorString(text: string): string {
  return applyColor(text, SYNTAX_COLORS['hljs-string']);
}

function colorOperator(text: string): string {
  return applyColor(text, SYNTAX_COLORS['hljs-keyword']);
}

function colorVariable(text: string): string {
  return applyColor(text, SYNTAX_COLORS['hljs-variable']);
}

function colorNumber(text: string): string {
  return applyColor(text, SYNTAX_COLORS['hljs-number']);
}

const OPERATOR_RE = /(&&|\|\||[|;])/;
const REDIRECT_RE = /^(>>?|<|2>&1)$/;
const FLAG_RE = /^-/;
const VARIABLE_RE = /\$[\w{]/;
const PURE_NUMBER_RE = /^\d+$/;

/**
 * Tokenize a shell segment (the part between operators) respecting quoted strings.
 * Returns an array of tokens where quoted strings are kept as single tokens.
 */
function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];

    if (inQuote) {
      current += ch;
      if (ch === inQuote) {
        inQuote = null;
        tokens.push(current);
        current = '';
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      if (current) {
        tokens.push(current);
        current = '';
      }
      inQuote = ch;
      current = ch;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      tokens.push(ch);
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function colorToken(token: string, isCommand: boolean): string {
  if (/^\s+$/.test(token)) return token;

  if (isCommand) return colorCommand(token);

  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return colorString(token);
  }

  if (REDIRECT_RE.test(token)) return colorOperator(token);
  if (VARIABLE_RE.test(token)) return colorVariable(token);
  if (FLAG_RE.test(token)) return colorFlag(token);
  if (PURE_NUMBER_RE.test(token)) return colorNumber(token);

  return token;
}

function highlightLine(line: string): string {
  const parts = line.split(OPERATOR_RE);
  let result = '';
  let expectCommand = true;

  for (const part of parts) {
    if (OPERATOR_RE.test(part)) {
      result += colorOperator(part);
      expectCommand = true;
      continue;
    }

    const tokens = tokenizeSegment(part);
    let foundCommand = false;

    for (const token of tokens) {
      if (/^\s+$/.test(token)) {
        result += token;
        continue;
      }

      const isCmd = expectCommand && !foundCommand;
      result += colorToken(token, isCmd);
      if (isCmd) foundCommand = true;
    }
  }

  return result;
}

/**
 * Syntax-highlight a shell command string using theme-aware colors.
 * Handles multi-line commands (e.g. && / || split across lines).
 */
export function highlightShellCommand(command: string): string {
  if (!command.trim()) return command;
  return command.split('\n').map(highlightLine).join('\n');
}
