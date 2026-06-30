/**
 * Utilities for formatting bash commands and results
 */

import { truncateForDisplay } from '@/utils/truncateForDisplay';

/**
 * Prepare bash result for storage, with optional truncation
 */
export function prepareBashResultForStorage(
  command: string,
  stdout: string,
  stderr: string,
  exitCode: number,
  options?: {
    truncateCommand?: boolean;
    truncateOutput?: boolean;
    maxLines?: number;
  }
): {
  type: 'bash_result';
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  metadata?: {
    commandTruncated?: boolean;
    commandTotalLines?: number;
    commandAdditionalLines?: number;
    stdoutTruncated?: boolean;
    stdoutTotalLines?: number;
    stdoutAdditionalLines?: number;
    stderrTruncated?: boolean;
    stderrTotalLines?: number;
    stderrAdditionalLines?: number;
  };
} {
  const maxLines = options?.maxLines ?? 10;
  const result: ReturnType<typeof prepareBashResultForStorage> = {
    type: 'bash_result',
    command,
    stdout,
    stderr,
    exitCode,
  };

  const metadata: NonNullable<typeof result.metadata> = {};
  let hasMetadata = false;

  // Truncate command if requested
  if (options?.truncateCommand) {
    const commandTruncation = truncateForDisplay(command, maxLines);
    if (commandTruncation.isTruncated) {
      result.command = commandTruncation.displayText;
      metadata.commandTruncated = true;
      metadata.commandTotalLines = commandTruncation.totalLines;
      metadata.commandAdditionalLines = commandTruncation.additionalLines;
      hasMetadata = true;
    }
  }

  // Truncate output if requested
  if (options?.truncateOutput) {
    const stdoutTruncation = truncateForDisplay(stdout, maxLines);
    if (stdoutTruncation.isTruncated) {
      result.stdout = stdoutTruncation.displayText;
      metadata.stdoutTruncated = true;
      metadata.stdoutTotalLines = stdoutTruncation.totalLines;
      metadata.stdoutAdditionalLines = stdoutTruncation.additionalLines;
      hasMetadata = true;
    }

    const stderrTruncation = truncateForDisplay(stderr, maxLines);
    if (stderrTruncation.isTruncated) {
      result.stderr = stderrTruncation.displayText;
      metadata.stderrTruncated = true;
      metadata.stderrTotalLines = stderrTruncation.totalLines;
      metadata.stderrAdditionalLines = stderrTruncation.additionalLines;
      hasMetadata = true;
    }
  }

  if (hasMetadata) {
    result.metadata = metadata;
  }

  return result;
}
