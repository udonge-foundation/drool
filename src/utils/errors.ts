import { LogMetadata } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

/**
 * Error thrown when the VSCode CLI is not available
 *
 * This can happen when:
 * - VSCode is not installed
 * - The 'code' command is not in PATH
 * - VSCode is installed but CLI tools are not set up
 */
export class VSCodeCliNotAvailableError extends Error {
  constructor(message?: string) {
    const defaultMessage = 'VSCode CLI is not available';
    super(message || defaultMessage);
    this.name = 'VSCodeCliNotAvailableError';
    Object.setPrototypeOf(this, VSCodeCliNotAvailableError.prototype);
  }
}

/**
 * Custom error class for ripgrep execution failures
 */
export class RipgrepError extends MetaError {
  public readonly exitCode: number | null;

  public readonly stderr: string;

  constructor(
    message: string,
    exitCode: number | null,
    stderr: string,
    cause?: unknown
  ) {
    const errorDetails = [];
    if (exitCode !== null) {
      errorDetails.push(`exit code: ${exitCode}`);
    }
    if (stderr) {
      errorDetails.push(`stderr: ${stderr}`);
    }

    const fullMessage =
      errorDetails.length > 0
        ? `${message} (${errorDetails.join(', ')})`
        : message;

    super(fullMessage, {
      cause,
      exitCode: exitCode as number,
      errorMessage: stderr,
    });
    this.name = 'RipgrepError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class WindowsPowerShellNotFoundError extends Error {
  constructor() {
    super(
      'Unable to execute command because no Windows PowerShell executable is available in PATH. Tried: pwsh.exe, powershell.exe. Install PowerShell (pwsh) or add powershell.exe to PATH.'
    );
    this.name = 'WindowsPowerShellNotFoundError';
  }
}

export class SessionNotFoundError extends MetaError {
  constructor(options: LogMetadata & { sessionId: string }) {
    const message = 'Session not found';
    super(message, options);
    this.name = 'SessionNotFoundError';
    Object.setPrototypeOf(this, SessionNotFoundError.prototype);
  }
}
