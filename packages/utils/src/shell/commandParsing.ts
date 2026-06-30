/**
 * Command parsing utilities for extracting command roots and normalizing commands
 */

/**
 * Strip shell wrapper from command (e.g., bash -c "command")
 */
export function stripShellWrapper(command: unknown): string {
  if (typeof command !== 'string') {
    return '';
  }
  // Match:
  //   <shell> /c <cmd>         (Windows cmd wrapper)
  //   <shell> -c  <cmd>        (standard POSIX wrapper)
  //   <shell> -lc <cmd>        (login + command)
  //   <shell> -xic <cmd>       (multiple short flags ending with 'c')
  // Essentially: any dash-flag group that ends with 'c'
  const pattern = /^\s*(?:sh|bash|zsh|cmd(?:\.exe)?)\s+(?:\/c|-[A-Za-z]*c)\s+/;
  const match = command.match(pattern);
  if (match) {
    let newCommand = command.substring(match[0].length).trim();
    if (
      (newCommand.startsWith('"') && newCommand.endsWith('"')) ||
      (newCommand.startsWith("'") && newCommand.endsWith("'"))
    ) {
      newCommand = newCommand.substring(1, newCommand.length - 1);
    }
    return newCommand;
  }
  return command.trim();
}
