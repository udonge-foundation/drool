import { logWarn } from '@industry/logging';

import type { ServerTransport } from '../types';
import type { IpcProcessRef } from '@industry/drool-sdk-ext/protocol/node';

export class IpcServerTransport implements ServerTransport {
  private readonly processRef: IpcProcessRef;

  public constructor(processRef: IpcProcessRef) {
    this.processRef = processRef;
  }

  send(message: string): void {
    try {
      this.processRef.send?.(
        message,
        undefined,
        undefined,
        (error: Error | null) => {
          if (error) {
            logWarn('[IPC] Failed to send daemon message via callback', {
              cause: error,
            });
          }
        }
      );
    } catch (error) {
      logWarn('[IPC] Failed to send daemon message via throw', {
        cause: error,
      });
    }
  }

  isOpen(): boolean {
    return (
      typeof this.processRef.send === 'function' &&
      this.processRef.connected !== false
    );
  }

  close(): void {
    try {
      this.processRef.disconnect?.();
    } catch (error) {
      logWarn('[IPC] Failed to disconnect daemon IPC connection', {
        cause: error,
      });
    }
  }
}
