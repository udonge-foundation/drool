import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';

export function getSanitizedExecuteCommand(
  input: Record<string, unknown>
): string | null {
  if (typeof input.command !== 'string' || input.command.length === 0) {
    return null;
  }

  return sanitizeTerminalDisplayText(input.command, { stripSgr: true });
}

export function formatExecuteCommand(command: string): string {
  return command.replace(/ (&&|\|\|) /g, '\n$1 ');
}
