import { ChildProcess } from 'child_process';
import fs from 'fs';
import * as readline from 'readline';

import { logWarn } from '@industry/logging';
import { isErrnoException } from '@industry/utils/errors';

import { TransportDirection } from './enums';
import { ConnectionError, ProcessExitError } from './errors';
import { logTransportMessage } from './transport-logger';

import type { ManagedProcess } from './types';

// Maximum length for non-JSON output in log messages (truncated if longer)
const MAX_NON_JSON_LOG_LENGTH = 200;

function describeSpawnError(
  error: Error,
  context?: { cwd?: string; execPath?: string }
): string {
  if (!isErrnoException(error)) {
    return `Failed to start Drool: ${error.message}`;
  }
  if (error.code === 'ENOENT') {
    if (context?.cwd && !fs.existsSync(context.cwd)) {
      return `Failed to start Drool: working directory does not exist (${context.cwd})`;
    }
    return `Failed to start Drool: executable not found${context?.execPath ? ` (${context.execPath})` : ''}`;
  }
  if (error.code === 'EACCES') {
    return `Failed to start Drool: permission denied${context?.execPath ? ` (${context.execPath})` : ''}`;
  }
  return `Failed to start Drool: ${error.code}`;
}

function describeExitError(
  code: number | null,
  signal: NodeJS.Signals | null
): string {
  if (signal) {
    return `Drool process was killed (${signal})`;
  }
  if (code !== null) {
    return `Drool process exited unexpectedly (exit code ${code})`;
  }
  return 'Drool process exited unexpectedly';
}

/**
 * Internal implementation of ManagedProcess
 */
export class ManagedProcessImpl implements ManagedProcess {
  private _childProcess: ChildProcess | null;

  private messageHandler: ((message: string) => void) | null = null;

  private errorHandler: ((error: Error) => void) | null = null;

  private readlineInterface: readline.Interface | null = null;

  private isClosing = false;

  /**
   * Sticky error from a process error or unexpected exit event. Once set,
   * all subsequent `send()` calls throw this error immediately instead of
   * hanging on a dead transport.
   */
  private processError: Error | null = null;

  private queuedSendPromise: Promise<void> = Promise.resolve();

  constructor(
    childProcess: ChildProcess,
    private readonly logPrefix: string,
    private readonly spawnContext?: { cwd?: string; execPath?: string }
  ) {
    this._childProcess = childProcess;
    this.setupHandlers();
  }

  get childProcess(): ChildProcess {
    if (!this._childProcess) {
      throw new ConnectionError('Process not connected');
    }
    return this._childProcess;
  }

  private setupHandlers(): void {
    if (!this.childProcess.stdout) {
      throw new ConnectionError('Failed to get process stdout');
    }

    this.readlineInterface = readline.createInterface({
      input: this.childProcess.stdout,
      crlfDelay: Infinity,
    });

    this.readlineInterface.on('line', (line) => {
      const trimmedLine = line.trim();
      if (this.messageHandler && trimmedLine) {
        if (trimmedLine.startsWith('{') || trimmedLine.startsWith('[')) {
          logTransportMessage(
            TransportDirection.In,
            trimmedLine,
            this._childProcess?.pid
          );
          this.messageHandler(trimmedLine);
        } else {
          const truncated =
            trimmedLine.length > MAX_NON_JSON_LOG_LENGTH
              ? trimmedLine.substring(0, MAX_NON_JSON_LOG_LENGTH)
              : trimmedLine;
          logWarn('[drool process] non-JSON output', {
            state: this.logPrefix,
            output: truncated,
          });
        }
      }
    });

    this.childProcess.on('error', (error) => {
      this.processError = new ConnectionError(
        describeSpawnError(error, this.spawnContext),
        {
          error,
          cwd: this.spawnContext?.cwd,
          execPath: this.spawnContext?.execPath,
        }
      );
      if (!this.isClosing && this.errorHandler) {
        this.errorHandler(this.processError);
      }
    });

    this.childProcess.on('exit', (code, signal) => {
      // Clean up dead process reference so transport can be reconnected
      this._childProcess = null;

      if (this.readlineInterface) {
        this.readlineInterface.close();
        this.readlineInterface = null;
      }

      if (!this.isClosing) {
        this.processError = new ProcessExitError(
          describeExitError(code, signal),
          {
            exitCode: code ?? undefined,
            signal: signal ?? undefined,
          }
        );
        if (this.errorHandler) {
          this.errorHandler(this.processError);
        }
      }
    });

    if (this.childProcess.stderr) {
      this.childProcess.stderr.on('data', (data) => {
        logWarn('[drool process] stderr', {
          state: this.logPrefix,
          output: data.toString(),
        });
      });
    }
  }

  async send(message: string): Promise<void> {
    if (this.processError) {
      throw this.processError;
    }
    if (!this._childProcess || !this._childProcess.stdin) {
      throw new ConnectionError('Process not connected');
    }

    const previousSends = this.queuedSendPromise;

    this.queuedSendPromise = (async () => {
      await previousSends.catch(() => {});

      if (
        !this._childProcess ||
        !this._childProcess.stdin ||
        this._childProcess.killed ||
        this.isClosing
      ) {
        throw new ConnectionError('Process disconnected before write');
      }

      await new Promise<void>((resolve, reject) => {
        try {
          if (!this._childProcess || !this._childProcess.stdin) {
            reject(new ConnectionError('Process stdin unavailable'));
            return;
          }

          const stdin = this._childProcess.stdin;
          if ('writable' in stdin && !stdin.writable) {
            reject(new ConnectionError('Process stdin is not writable'));
            return;
          }

          const childPid = this._childProcess?.pid;
          stdin.write(`${message}\n`, (error) => {
            if (error) {
              // Record the failed attempt so transport-log readers can see
              // messages that were enqueued but never made it to the child.
              logTransportMessage(
                TransportDirection.OutFailed,
                message,
                childPid
              );
              const errorMessage = error.message || String(error);
              if (
                errorMessage.includes('EPIPE') ||
                errorMessage.includes('ECONNRESET')
              ) {
                reject(
                  new ConnectionError('Process stdin closed during write', {
                    error,
                  })
                );
              } else {
                reject(
                  new ConnectionError('Failed to write to process stdin', {
                    error,
                  })
                );
              }
            } else {
              logTransportMessage(TransportDirection.Out, message, childPid);
              resolve();
            }
          });
        } catch (error) {
          logWarn('[ManagedProcess] Error writing to process stdin', {
            cause: error,
          });
          reject(
            new ConnectionError('Error writing to process stdin', {
              error: error instanceof Error ? error : new Error(String(error)),
            })
          );
        }
      });
    })();

    return this.queuedSendPromise;
  }

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  async close(): Promise<void> {
    this.isClosing = true;

    if (this._childProcess) {
      const processToClose = this._childProcess;

      // If the process never spawned (pid is undefined on spawn failure) or
      // already exited, skip waiting for exit event — it will never fire.
      if (
        processToClose.pid === undefined ||
        processToClose.exitCode !== null
      ) {
        this._childProcess = null;
      } else {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (processToClose.exitCode === null) {
              processToClose.kill('SIGKILL');
            }
          }, 5000);

          processToClose.once('exit', () => {
            clearTimeout(timeout);
            resolve();
          });

          if (processToClose.stdin) {
            processToClose.stdin.end();
          }

          processToClose.kill('SIGTERM');
        });
      }
    }

    if (this.readlineInterface) {
      this.readlineInterface.close();
      this.readlineInterface = null;
    }

    // Explicitly nullify and reset isClosing flag to allow potential reconnection
    this._childProcess = null;
    this.isClosing = false;
  }

  get isConnected(): boolean {
    return (
      this._childProcess !== null &&
      !this._childProcess.killed &&
      this._childProcess.stdin !== null &&
      !this._childProcess.stdin.destroyed &&
      ('writable' in this._childProcess.stdin
        ? this._childProcess.stdin.writable
        : true)
    );
  }
}
