/**
 * Normalize an executable token to its bare command name by stripping any
 * quoting/escaping and leading path components. E.g. `"rm"` -> `rm`,
 * `/bin/rm` -> `rm`, `'/usr/bin/git'` -> `git`, `sh"utdown"` -> `shutdown`,
 * `\shutdown` -> `shutdown`. This is the canonical form the shell itself
 * resolves and executes, so denylist/blocklist matching must use it to avoid
 * trivial quote/path/escape evasions.
 */

// Drive-letter (C:\...) or UNC (\\server\...) prefixes, where backslash is a
// path separator rather than a POSIX escape character.
const WINDOWS_PATH_PREFIX = /^(?:[A-Za-z]:[\\/]|\\\\)/;

function stripWrappingQuotes(token: string): string {
  let cmd = token;
  while (
    cmd.length >= 2 &&
    ((cmd.startsWith('"') && cmd.endsWith('"')) ||
      (cmd.startsWith("'") && cmd.endsWith("'")))
  ) {
    cmd = cmd.slice(1, -1);
  }
  return cmd;
}

/**
 * Resolve a single shell word the way the shell would: drop quote pairs
 * (including embedded ones like `sh"utdown"`) and backslash escapes (like
 * `\shutdown`), keeping the escaped/quoted characters themselves.
 */
export function dequoteShellWord(token: string): string {
  let result = '';
  let inSingleQuotes = false;
  let inDoubleQuotes = false;
  let i = 0;

  while (i < token.length) {
    const char = token[i];

    if (inSingleQuotes) {
      if (char === "'") {
        inSingleQuotes = false;
      } else {
        result += char;
      }
      i++;
      continue;
    }

    if (char === '\\' && i + 1 < token.length) {
      result += token[i + 1];
      i += 2;
      continue;
    }

    if (char === "'" && !inDoubleQuotes) {
      inSingleQuotes = true;
      i++;
      continue;
    }

    if (char === '"') {
      inDoubleQuotes = !inDoubleQuotes;
      i++;
      continue;
    }

    result += char;
    i++;
  }

  return result;
}

export function normalizeExecutableToken(token: string): string {
  const unquoted = stripWrappingQuotes(token);

  // Windows-style paths keep backslashes as separators instead of escapes.
  let cmd = WINDOWS_PATH_PREFIX.test(unquoted)
    ? unquoted
    : dequoteShellWord(token);

  // Strip leading path components (POSIX and Windows separators)
  if (cmd.includes('/')) {
    cmd = cmd.split('/').pop() || cmd;
  }
  if (cmd.includes('\\')) {
    cmd = cmd.split('\\').pop() || cmd;
  }

  return cmd;
}
