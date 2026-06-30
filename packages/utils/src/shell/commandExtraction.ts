/**
 * Advanced command extraction for analyzing and normalizing shell commands
 */

import { stripShellWrapper } from './commandParsing';
import { normalizeExecutableToken } from './normalizeExecutableToken';
import { splitCommands } from './splitCommands';

/**
 * Tokenize a single command segment into words, respecting single/double
 * quotes and backslash escapes. Quote characters are preserved in the
 * returned tokens (callers decide whether to strip them).
 */
export function tokenizeRespectingQuotes(segment: string): string[] {
  const words: string[] = [];
  let current = '';
  let inSingleQuotes = false;
  let inDoubleQuotes = false;
  let i = 0;

  while (i < segment.length) {
    const char = segment[i];

    if (char === '\\' && i < segment.length - 1) {
      current += char + segment[i + 1];
      i += 2;
      continue;
    }

    if (char === "'" && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes;
      current += char;
    } else if (char === '"' && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
      current += char;
    } else if (/\s/.test(char) && !inSingleQuotes && !inDoubleQuotes) {
      if (current) {
        words.push(current);
        current = '';
      }
    } else {
      current += char;
    }
    i++;
  }

  if (current) {
    words.push(current);
  }

  return words;
}

const COMMAND_PREFIXES = new Set(['sudo', 'time', 'nohup', 'env']);

// Prefix options that consume the following token as their value, so the
// value is never mistaken for the command word (e.g. `sudo -u root cmd`).
const PREFIX_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set([
    '-u',
    '-g',
    '-p',
    '-r',
    '-t',
    '-C',
    '-D',
    '-R',
    '-T',
    '-U',
    '-h',
    '--user',
    '--group',
    '--prompt',
    '--role',
    '--type',
    '--close-from',
    '--chdir',
    '--chroot',
    '--other-user',
    '--host',
  ]),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  time: new Set(['-f', '--format', '-o', '--output']),
  nohup: new Set<string>(),
};

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Find the index of the executable word in a tokenized segment, skipping
 * environment-variable assignments, redirections, and command prefixes
 * (sudo/time/nohup/env) along with the prefixes' own options and `--`.
 * Returns -1 when no command word is present.
 */
export function findCommandWordIndex(words: string[]): number {
  for (let idx = 0; idx < words.length; idx++) {
    const word = words[idx];

    // Skip environment variable assignments (VAR=value)
    if (ENV_ASSIGNMENT.test(word)) continue;

    // Skip redirections and their targets
    if (/^[0-9]*[<>&]/.test(word)) {
      // Special case: 2>&1 type redirections don't have a following filename
      if (/^[0-9]+>&[0-9]+$/.test(word)) {
        continue;
      }
      // If it's just > or < or &> (without fd numbers attached), skip the next word too (the filename)
      const withoutNumbers = word.replace(/[0-9]/g, '');
      if (/^[<>&]+$/.test(withoutNumbers) && !withoutNumbers.includes('>&')) {
        idx++; // Skip the filename
      }
      continue;
    }

    // Skip command prefixes together with their options, option values, and
    // the `--` end-of-options marker, so option tokens like `sudo -n` are
    // never returned as the command word.
    if (COMMAND_PREFIXES.has(word)) {
      const valueFlags = PREFIX_VALUE_FLAGS[word];
      while (idx + 1 < words.length) {
        const next = words[idx + 1];
        if (next === '--') {
          idx++;
          break;
        }
        if (word === 'env' && ENV_ASSIGNMENT.test(next)) {
          idx++;
          continue;
        }
        if (next.startsWith('-')) {
          idx += valueFlags.has(next) ? 2 : 1;
          continue;
        }
        break;
      }
      continue;
    }

    // Found the command
    return idx;
  }

  return -1;
}

/**
 * Rewrite a full command string so each command segment's executable token is
 * normalized to its bare name (quotes/path stripped) while arguments are left
 * intact. Segments are re-joined with `;` separators so downstream pattern
 * matching still treats them as distinct commands. Used to defeat trivial
 * denylist/blocklist evasions such as `"rm" -rf /` or `/bin/rm -rf /`.
 */
export function normalizeCommandExecutables(fullCommand: string): string {
  const strippedCommand = stripShellWrapper(fullCommand);
  const segments = splitCommands(strippedCommand);

  const normalizedSegments: string[] = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const words = tokenizeRespectingQuotes(trimmed);
    if (words.length === 0) {
      normalizedSegments.push(trimmed);
      continue;
    }

    const cmdIndex = findCommandWordIndex(words);
    if (cmdIndex === -1) {
      normalizedSegments.push(trimmed);
      continue;
    }

    words[cmdIndex] = normalizeExecutableToken(words[cmdIndex]);
    normalizedSegments.push(words.join(' '));
  }

  return normalizedSegments.join(' ; ');
}

/**
 * Extract normalized commands from a full command string.
 * Returns commands in format like "git commit", "npm install", etc.
 * Based on SessionConfigService.getExtractedCommands logic.
 */
export function extractNormalizedCommands(fullCommand: string): string[] {
  const strippedCommand = stripShellWrapper(fullCommand);

  // Use the quote-aware splitCommands function to split by shell operators
  const segments = splitCommands(strippedCommand);

  const commands: string[] = [];
  const seen = new Set<string>();

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    // Parse the command while respecting quotes
    const words = tokenizeRespectingQuotes(trimmed);

    if (words.length === 0) continue;

    // Find the actual command, skipping env vars, prefixes, and redirections
    const cmdIndex = findCommandWordIndex(words);

    if (cmdIndex === -1) continue;

    let cmd = words[cmdIndex];

    // Skip cd commands
    if (cmd === 'cd') continue;

    // Strip quotes from command name if present
    if (
      (cmd.startsWith('"') && cmd.endsWith('"')) ||
      (cmd.startsWith("'") && cmd.endsWith("'"))
    ) {
      cmd = cmd.slice(1, -1);
    }

    // Handle paths (e.g., /usr/bin/ls -> ls)
    if (cmd.includes('/')) {
      cmd = cmd.split('/').pop() || cmd;
    }

    // Skip if it's not a valid command name
    if (!cmd || cmd.startsWith('-') || /^\d+$/.test(cmd)) continue;

    // For package managers, version control, and CLI tools, find the subcommand
    const subcommandTools = ['git', 'npm', 'yarn', 'pnpm', 'bun', 'gh', 'glab'];
    // Tools that use two-level subcommands (e.g., gh pr create, glab mr create)
    const twoLevelSubcommandTools = ['gh', 'glab'];
    if (subcommandTools.includes(cmd)) {
      const maxSubcommands = twoLevelSubcommandTools.includes(cmd) ? 2 : 1;
      const subcommands: string[] = [];
      let skipNext = false;

      for (let j = cmdIndex + 1; j < words.length; j++) {
        const word = words[j];

        if (skipNext) {
          skipNext = false;
          continue;
        }

        // Skip redirections
        if (/^[0-9]*[<>&]/.test(word)) {
          if (/^[<>&]+$/.test(word.replace(/[0-9]/g, ''))) {
            skipNext = true; // Skip the filename
          }
          continue;
        }

        if (word.startsWith('-')) {
          // Check if this flag takes a value
          if (
            cmd === 'git' &&
            ['-C', '-c', '--git-dir', '--work-tree'].includes(word)
          ) {
            skipNext = true;
          } else if (
            (cmd === 'npm' ||
              cmd === 'yarn' ||
              cmd === 'pnpm' ||
              cmd === 'bun') &&
            ['--prefix', '--workspace', '--dir', '-C'].includes(word)
          ) {
            skipNext = true;
          } else if (
            (cmd === 'gh' || cmd === 'glab') &&
            ['-R', '--repo'].includes(word)
          ) {
            skipNext = true;
          } else if (word.includes('=')) {
            // Flags with = don't need to skip next
            continue;
          } else if (
            [
              '-g',
              '--global',
              '-D',
              '--dev',
              '-h',
              '--help',
              '-v',
              '--version',
            ].includes(word)
          ) {
            continue;
          }
          // For unknown flags, continue without skipping
          continue;
        }

        // Skip quoted arguments - they're not subcommands
        if (word.startsWith('"') || word.startsWith("'")) {
          continue;
        }

        // This should be a subcommand
        subcommands.push(word);
        if (subcommands.length >= maxSubcommands) break;
      }

      const fullCmd =
        subcommands.length > 0 ? `${cmd} ${subcommands.join(' ')}` : cmd;
      if (!seen.has(fullCmd)) {
        commands.push(fullCmd);
        seen.add(fullCmd);
      }
    } else if (!seen.has(cmd)) {
      // For other commands, just add the base command
      commands.push(cmd);
      seen.add(cmd);
    }
  }

  return commands;
}
