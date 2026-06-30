/**
 * Terminal State Tracker
 *
 * Maintains a headless xterm instance to track rendered terminal state
 * for restoration after frontend disconnect/refresh.
 */

import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal as HeadlessTerminal } from '@xterm/headless';

import {
  CURSOR_ESCAPE_SEQUENCES,
  ESCAPE_BUFFER_LENGTH,
  TERMINAL_BASE_OPTIONS,
} from '@industry/common/terminal';

import type { TerminalSnapshot } from './types';

export class TerminalStateTracker {
  private headlessTerminal: HeadlessTerminal;

  private serializeAddon: SerializeAddon;

  private cursorHidden: boolean = false;

  private escapeBuffer: string = '';

  constructor(cols: number, rows: number) {
    this.headlessTerminal = new HeadlessTerminal({
      ...TERMINAL_BASE_OPTIONS,
      cols,
      rows,
      allowProposedApi: true,
    });

    this.serializeAddon = new SerializeAddon();
    this.headlessTerminal.loadAddon(this.serializeAddon);
  }

  /**
   * Process PTY output through headless terminal
   * This interprets ANSI sequences and updates the rendered buffer
   */
  processOutput(data: string, onProcessed?: () => void): void {
    this.trackCursorVisibility(data);
    this.headlessTerminal.write(data, onProcessed);
  }

  /**
   * Capture current terminal state as a snapshot
   */
  captureSnapshot(): TerminalSnapshot {
    const buffer = this.headlessTerminal.buffer.active;

    return {
      serialized: this.serializeAddon.serialize({
        excludeAltBuffer: true,
        excludeModes: true,
      }),
      plainText: this.getPlainTextBuffer(),
      cols: this.headlessTerminal.cols,
      rows: this.headlessTerminal.rows,
      timestamp: new Date(),
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      cursorHidden: this.cursorHidden,
    };
  }

  /**
   * Get plain text representation of buffer (no ANSI)
   */
  getPlainTextBuffer(): string {
    const buffer = this.headlessTerminal.buffer.active;
    let output = '';

    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (line) {
        output += line.translateToString(false);
        if (y < buffer.length - 1) {
          output += '\n';
        }
      }
    }

    return output;
  }

  /**
   * Resize the headless terminal
   */
  resize(cols: number, rows: number): void {
    this.headlessTerminal.resize(cols, rows);
  }

  private trackCursorVisibility(data: string): void {
    const combined = `${this.escapeBuffer}${data}`;

    if (combined.includes(CURSOR_ESCAPE_SEQUENCES.HIDE)) {
      this.cursorHidden = true;
    }
    if (combined.includes(CURSOR_ESCAPE_SEQUENCES.SHOW)) {
      this.cursorHidden = false;
    }

    this.escapeBuffer = combined.slice(-ESCAPE_BUFFER_LENGTH);
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.headlessTerminal.dispose();
  }
}
