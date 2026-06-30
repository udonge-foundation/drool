import { clearLine, cursorTo } from 'readline';

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface SpinnerOptions {
  message: string;
  color?: string;
}

export class TerminalSpinner {
  private intervalId: NodeJS.Timeout | null = null;

  private currentFrame = 0;

  private message: string;

  private color: string;

  constructor(options: SpinnerOptions) {
    this.message = options.message;
    this.color = options.color || '\x1b[32m'; // Default to green
  }

  start(): void {
    if (this.intervalId) {
      return; // Already started
    }

    // Hide cursor
    process.stdout.write('\x1b[?25l');

    // Render initial frame immediately so the message is visible before
    // the first setInterval tick (80ms). Without this, fast state transitions
    // (e.g. localhost update checks completing in <1ms) can change the message
    // before the first frame is ever written.
    const initialFrame = spinnerFrames[this.currentFrame];
    process.stdout.write(`${this.color}${initialFrame} ${this.message}\x1b[0m`);
    this.currentFrame = (this.currentFrame + 1) % spinnerFrames.length;

    this.intervalId = setInterval(() => {
      // Clear current line and move cursor to beginning
      clearLine(process.stdout, 0);
      cursorTo(process.stdout, 0);

      // Write spinner frame with message
      const frame = spinnerFrames[this.currentFrame];
      process.stdout.write(`${this.color}${frame} ${this.message}\x1b[0m`);

      this.currentFrame = (this.currentFrame + 1) % spinnerFrames.length;
    }, 80);
  }

  updateMessage(message: string): void {
    this.message = message;
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Clear current line
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);

    // Show cursor
    process.stdout.write('\x1b[?25h');
  }

  stopWithMessage(message: string, color?: string): void {
    this.stop();

    const messageColor = color || '\x1b[32m'; // Default to green
    process.stdout.write(`${messageColor}✓ ${message}\x1b[0m\n`);
  }

  stopWithError(message: string): void {
    this.stop();

    process.stdout.write(`\x1b[31m✗ ${message}\x1b[0m\n`);
  }
}

export function createSpinner(options: SpinnerOptions): TerminalSpinner {
  return new TerminalSpinner(options);
}
