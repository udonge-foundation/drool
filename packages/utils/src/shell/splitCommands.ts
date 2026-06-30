/**
 * Splits a shell command into a list of individual commands, respecting quotes.
 * This is used to separate chained commands (e.g., using &&, ||, ;).
 */
export function splitCommands(command: string): string[] {
  const commands: string[] = [];
  let currentCommand = '';
  let inSingleQuotes = false;
  let inDoubleQuotes = false;
  let i = 0;

  while (i < command.length) {
    const char = command[i];
    const nextChar = command[i + 1];

    if (char === '\\' && i < command.length - 1) {
      currentCommand += char + command[i + 1];
      i += 2;
      continue;
    }

    if (char === "'" && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes;
    } else if (char === '"' && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
    }

    if (!inSingleQuotes && !inDoubleQuotes) {
      if (
        (char === '&' && nextChar === '&') ||
        (char === '|' && nextChar === '|')
      ) {
        commands.push(currentCommand.trim());
        currentCommand = '';
        i++; // Skip the next character
      } else if (char === ';' || char === '|') {
        commands.push(currentCommand.trim());
        currentCommand = '';
      } else if (char === '&') {
        // Check if this & is part of a redirection operator
        if (nextChar === '>') {
          // This is &> redirection, don't split
          currentCommand += char;
        } else if (/\d>$/.test(currentCommand.slice(-2))) {
          // This is part of a file descriptor redirection like 2>&1, don't split
          currentCommand += char;
        } else if (nextChar !== '&') {
          // This is a background operator, split here
          commands.push(currentCommand.trim());
          currentCommand = '';
        } else {
          currentCommand += char;
        }
      } else {
        currentCommand += char;
      }
    } else {
      currentCommand += char;
    }
    i++;
  }

  if (currentCommand.trim()) {
    commands.push(currentCommand.trim());
  }

  return commands.filter(Boolean); // Filter out any empty strings
}
