/**
 * Utility functions for command execution
 */

import * as os from 'os';

/**
 * Windows special characters that require quoting in shell commands.
 * These characters have special meaning in Windows Command Prompt and PowerShell.
 */
const WINDOWS_SPECIAL_CHARS = [
  '&', // Command separator
  '|', // Pipe operator
  '<', // Input redirection
  '>', // Output redirection
  '^', // Escape character
  '(', // Command grouping
  ')', // Command grouping
  '[', // Used in wildcards
  ']', // Used in wildcards
  '{', // Used in PowerShell
  '}', // Used in PowerShell
  '!', // History expansion
  '%', // Variable expansion
  ',', // Parameter separator
  ';', // Command separator
  '=', // Assignment operator
] as const;

/**
 * Unix-like special characters that require quoting in shell commands.
 * These characters have special meaning in bash, zsh, and other Unix shells.
 */
const UNIX_SPECIAL_CHARS = [
  '&', // Background process / command separator
  '|', // Pipe operator
  '<', // Input redirection
  '>', // Output redirection
  '(', // Subshell
  ')', // Subshell
  '[', // Character class / test command
  ']', // Character class / test command
  '{', // Brace expansion
  '}', // Brace expansion
  '!', // History expansion
  '$', // Variable expansion
  '*', // Wildcard
  '?', // Wildcard
  ';', // Command separator
  '\\', // Escape character
] as const;

/**
 * Determines if a command needs to be quoted based on the presence of special characters
 * or spaces that could cause issues in shell execution.
 *
 * @param command - The command to check
 * @returns True if the command needs quoting, false otherwise
 */
function shouldQuoteCommand(command: string): boolean {
  // Empty strings don't need quoting
  if (!command) {
    return false;
  }

  // If already quoted, no need to quote again
  if (
    (command.startsWith('"') && command.endsWith('"')) ||
    (command.startsWith("'") && command.endsWith("'"))
  ) {
    return false;
  }

  // Check for spaces
  if (command.includes(' ')) {
    return true;
  }

  // Platform-specific checks
  const specialChars =
    os.platform() === 'win32' ? WINDOWS_SPECIAL_CHARS : UNIX_SPECIAL_CHARS;

  return specialChars.some((char) => command.includes(char));
}

/**
 * Quotes a command or path if it contains spaces or special characters that require escaping.
 * Handles platform-specific quoting requirements.
 *
 * @param command - The command or path to potentially quote
 * @returns The command with quotes if needed, otherwise returns it unchanged
 *
 * @example
 * ```typescript
 * quoteCommand('code') // Returns: 'code'
 * quoteCommand('/usr/local/bin/code') // Returns: '/usr/local/bin/code'
 * quoteCommand('C:\\Program Files\\VSCode\\bin\\code.cmd') // Returns: '"C:\\Program Files\\VSCode\\bin\\code.cmd"'
 * quoteCommand('/path/with spaces/app') // Returns: '"/path/with spaces/app"'
 * ```
 */
export function quoteCommand(command: string): string {
  // Check if quoting is needed
  if (!shouldQuoteCommand(command)) {
    return command;
  }

  // Use double quotes for cross-platform compatibility
  return `"${command}"`;
}

/**
 * Parses stdout output into an array of trimmed, non-empty lines.
 * This is useful for parsing command output where each line represents a distinct item.
 *
 * @param stdout - The stdout string to parse
 * @returns An array of trimmed, non-empty lines
 *
 * @example
 * ```typescript
 * parseStdoutLines('  line1\n\n  line2  \n  ') // Returns: ['line1', 'line2']
 * parseStdoutLines('') // Returns: []
 * parseStdoutLines('  \n  \n  ') // Returns: []
 * ```
 */
export function parseStdoutLines(stdout: string): string[] {
  return stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
