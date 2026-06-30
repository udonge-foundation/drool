/**
 * Recursive extraction of the command invocations a shell would actually
 * execute for a given command string. Used by denylist/blocklist matching so
 * patterns are tested against real executable contexts instead of raw text,
 * defeating evasions via shell wrappers (`/bin/bash -c "..."`), command
 * prefixes (`sudo -n ...`), command substitutions (`$(...)`, backticks), and
 * quote/escape tricks (`sh"utdown"`, `\shutdown`).
 */

import {
  findCommandWordIndex,
  tokenizeRespectingQuotes,
} from './commandExtraction';
import {
  dequoteShellWord,
  normalizeExecutableToken,
} from './normalizeExecutableToken';
import { splitCommands } from './splitCommands';

const MAX_RECURSION_DEPTH = 8;
const MAX_INVOCATIONS = 64;

const SHELL_WRAPPERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'cmd',
  'cmd.exe',
]);

interface SubstitutionExtraction {
  /** Command with substitution spans blanked out */
  outer: string;
  /** Bodies of `$(...)` and backtick substitutions */
  bodies: string[];
}

function findClosingParen(command: string, startIndex: number): number {
  let depth = 1;
  let inSingleQuotes = false;
  let inDoubleQuotes = false;
  let i = startIndex;

  while (i < command.length) {
    const char = command[i];
    if (char === '\\' && !inSingleQuotes && i + 1 < command.length) {
      i += 2;
      continue;
    }
    if (char === "'" && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes;
    } else if (char === '"' && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
    } else if (!inSingleQuotes && !inDoubleQuotes) {
      if (char === '(') depth++;
      if (char === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    i++;
  }

  return command.length;
}

function findClosingBacktick(command: string, startIndex: number): number {
  let i = startIndex;
  while (i < command.length) {
    const char = command[i];
    if (char === '\\' && i + 1 < command.length) {
      i += 2;
      continue;
    }
    if (char === '`') return i;
    i++;
  }
  return command.length;
}

/**
 * Pull out the bodies of `$(...)` and backtick command substitutions
 * (anywhere outside single quotes, including inside double quotes, matching
 * shell expansion rules) and blank their spans in the returned outer command.
 */
function extractSubstitutionBodies(command: string): SubstitutionExtraction {
  const bodies: string[] = [];
  let outer = '';
  let inSingleQuotes = false;
  let i = 0;

  while (i < command.length) {
    const char = command[i];

    if (char === '\\' && !inSingleQuotes && i + 1 < command.length) {
      outer += char + command[i + 1];
      i += 2;
      continue;
    }

    if (char === "'") {
      inSingleQuotes = !inSingleQuotes;
      outer += char;
      i++;
      continue;
    }

    if (!inSingleQuotes && char === '$' && command[i + 1] === '(') {
      const end = findClosingParen(command, i + 2);
      bodies.push(command.slice(i + 2, end));
      outer += ' ';
      i = end + 1;
      continue;
    }

    if (!inSingleQuotes && char === '`') {
      const end = findClosingBacktick(command, i + 1);
      // Inside backticks the shell unescapes \` \$ \\ before re-parsing,
      // which is how backtick substitutions nest.
      bodies.push(command.slice(i + 1, end).replace(/\\([`$\\])/g, '$1'));
      outer += ' ';
      i = end + 1;
      continue;
    }

    outer += char;
    i++;
  }

  return { outer, bodies };
}

/**
 * Locate the payload of a shell wrapper's command flag (`-c`, `-lc`, `/c`)
 * among its arguments and return it dequoted, or null when absent.
 */
function findWrapperPayload(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      return null;
    }
    if (/^-[A-Za-z]*c$/.test(arg) || arg === '/c' || arg === '/C') {
      const payload = args[i + 1];
      return payload ? dequoteShellWord(payload) : null;
    }
  }
  return null;
}

interface ExtractInvocationsOptions {
  /**
   * Also resolve quoting/escaping inside argument words (`rm "-rf" /` ->
   * `rm -rf /`). Defaults to true, matching what the shell hands to the
   * executable. Pass false to keep argument quoting visible so callers can
   * treat quoted text as inert data (the denylist contract).
   */
  dequoteArguments?: boolean;
}

function collectInvocations(
  command: string,
  depth: number,
  dequoteArguments: boolean,
  out: string[],
  seen: Set<string>
): void {
  if (depth > MAX_RECURSION_DEPTH || out.length >= MAX_INVOCATIONS) return;

  const { outer, bodies } = extractSubstitutionBodies(command);
  for (const body of bodies) {
    collectInvocations(body, depth + 1, dequoteArguments, out, seen);
  }

  for (const segment of splitCommands(outer)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const words = tokenizeRespectingQuotes(trimmed);
    if (words.length === 0) continue;

    const cmdIndex = findCommandWordIndex(words);
    if (cmdIndex === -1) continue;

    const executable = normalizeExecutableToken(words[cmdIndex]);
    if (!executable) continue;

    const rawArgs = words.slice(cmdIndex + 1);
    const args = dequoteArguments ? rawArgs.map(dequoteShellWord) : rawArgs;
    const invocation = [executable, ...args].join(' ').trim();
    if (!seen.has(invocation) && out.length < MAX_INVOCATIONS) {
      seen.add(invocation);
      out.push(invocation);
    }

    if (SHELL_WRAPPERS.has(executable.toLowerCase())) {
      const payload = findWrapperPayload(rawArgs);
      if (payload) {
        collectInvocations(payload, depth + 1, dequoteArguments, out, seen);
      }
    }
  }
}

/**
 * Extract every command invocation a shell would execute for the given
 * command string, recursively descending into command substitutions and
 * shell-wrapper `-c` payloads. Each invocation is returned as a normalized
 * string whose first word is the bare (dequoted, path-stripped) executable
 * followed by its arguments.
 */
export function extractExecutableInvocations(
  fullCommand: string,
  options?: ExtractInvocationsOptions
): string[] {
  if (typeof fullCommand !== 'string' || !fullCommand.trim()) {
    return [];
  }
  const invocations: string[] = [];
  collectInvocations(
    fullCommand,
    0,
    options?.dequoteArguments ?? true,
    invocations,
    new Set<string>()
  );
  return invocations;
}
