import { spawnSync, type StdioOptions } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import shellQuote from 'shell-quote';

import { logInfo, logWarn, logException } from '@industry/logging';

import { ANSI } from '@/components/chat/constants';
import { getI18n } from '@/i18n';
import type { OpenTextInEditorResult } from '@/services/types';
import { TUI_SETTLE_DELAY_MS } from '@/utils/constants';
import { detectEditor } from '@/utils/editorDetection';
import {
  disableKittyProtocol,
  enableKittyProtocol,
  isKittyProtocolEnabled,
} from '@/utils/kittyProtocolDetector';
import type { OpenInEditorResult } from '@/utils/types';

/**
 * Service to manage editor suspension and TUI lifecycle
 */

type SuspendCallback = () => Promise<void>;
type ResumeCallback = () => Promise<void>;

interface EditorCallbacks {
  onSuspend: SuspendCallback;
  onResume: ResumeCallback;
}

function parseEditorCommand(
  editor: string,
  filePath: string
): { command: string; args: string[] } {
  const commandParts = shellQuote
    .parse(editor)
    .map((part) => part.toString())
    .filter((part) => part.length > 0);

  if (commandParts.length === 0) {
    throw new Error('Editor command is empty');
  }

  return {
    command: commandParts[0]!,
    args: [...commandParts.slice(1), filePath],
  };
}

class EditorService {
  private suspendCallback: SuspendCallback | null = null;

  private resumeCallback: ResumeCallback | null = null;

  /**
   * Register callbacks for suspending/resuming the TUI
   */
  registerCallbacks({ onSuspend, onResume }: EditorCallbacks): void {
    this.suspendCallback = onSuspend;
    this.resumeCallback = onResume;
  }

  /**
   * Suspend the TUI (called before opening editor)
   */
  async suspend(): Promise<void> {
    if (this.suspendCallback) {
      await this.suspendCallback();
    } else {
      logWarn(
        '[EditorService] suspend() called before callbacks were registered'
      );
    }
  }

  /**
   * Resume the TUI (called after editor closes)
   */
  async resume(): Promise<void> {
    if (this.resumeCallback) {
      await this.resumeCallback();
    } else {
      logWarn(
        '[EditorService] resume() called before callbacks were registered'
      );
    }
  }

  /**
   * Opens the given file in the user's preferred editor.
   *
   * For sync editors (CLI editors like vim/nano, or GUI editors invoked with a
   * wait flag like `code --wait`) the TUI is suspended and this method waits
   * for the editor process to exit before resuming.
   *
   * For async editors (GUI editors without a wait flag, including the system
   * default `open` command) the editor is launched and this method returns
   * immediately; the caller is responsible for prompting the user to confirm
   * once they have finished editing.
   *
   * @param filePath - Path to the file to open
   */
  async openFileAndWait(filePath: string): Promise<OpenInEditorResult> {
    // Determine which editor to use
    const editorInfo = detectEditor();
    const { editor, isSync, isCli } = editorInfo;
    const { command, args } = parseEditorCommand(editor, filePath);

    // GUI editors (including system default `open`) are treated as async:
    // the user closes the editor on their own time and presses Enter in the
    // CLI to confirm. We avoid `open -W`/spawn-blocking because GUI apps that
    // are already running (e.g. VSCode) won't quit when a single tab is
    // closed, which would leave the CLI hung indefinitely.
    const isAsyncEditor = !isSync;

    logInfo('[EditorService] Opening file in editor', {
      command,
      args,
      filePath,
    });

    // Kitty protocol toggling is only relevant for the sync path where the
    // TUI yields the terminal to a CLI editor.
    const kittyWasEnabled = !isAsyncEditor && isKittyProtocolEnabled();

    try {
      if (!isAsyncEditor) {
        // Suspend TUI rendering
        await this.suspend();

        // Switch to main screen buffer and prepare terminal for editor
        process.stdout.write(ANSI.CLEAR_SCREEN);
        process.stdout.write(ANSI.MOVE_CURSOR_HOME);
        process.stdout.write(ANSI.SHOW_CURSOR);
        process.stdout.write(getI18n().t('common:process.closeEditor'));

        // Disable Kitty keyboard protocol if enabled (fixes nano Ctrl-X issue)
        if (kittyWasEnabled) {
          await disableKittyProtocol();
        }
      }

      const stdio: StdioOptions =
        !isAsyncEditor && isCli
          ? ['inherit', 'inherit', 'pipe']
          : ['ignore', 'ignore', 'pipe'];
      const result = spawnSync(command, args, {
        stdio,
        encoding: 'utf-8',
      });

      if (result.error) {
        if (!isAsyncEditor) {
          // Wait for TUI to settle into steady state before resuming.
          // This race condition only happens if the CLI editor command failed.
          await new Promise((resolve) => {
            setTimeout(resolve, TUI_SETTLE_DELAY_MS);
          });
        }

        return {
          success: false,
          error: `Failed to open editor: ${result.error.message}`,
          isAsyncEditor,
        };
      }

      if (result.status !== 0 && result.status !== null) {
        // Include stderr in error message if available
        const stderrMsg = result.stderr?.toString().trim();
        const errorDetail = stderrMsg
          ? `Editor exited with code ${result.status}: ${stderrMsg}`
          : `Editor exited with code ${result.status}`;
        return {
          success: false,
          error: errorDetail,
          isAsyncEditor,
        };
      }

      if (result.signal != null || result.status === null) {
        const stderrMsg = result.stderr?.toString().trim();
        const signalName = result.signal ?? 'unknown signal';
        const errorDetail = stderrMsg
          ? `Editor exited with signal ${signalName}: ${stderrMsg}`
          : `Editor exited with signal ${signalName}`;
        return {
          success: false,
          error: errorDetail,
          isAsyncEditor,
        };
      }

      logInfo('[EditorService] Editor closed successfully');
      return { success: true, isAsyncEditor };
    } catch (error) {
      logException(error, '[EditorService] Exception while opening editor');

      if (!isAsyncEditor) {
        // Wait for TUI to settle into steady state before resuming.
        // This race condition only happens if the CLI editor command failed.
        await new Promise((resolve) => {
          setTimeout(resolve, TUI_SETTLE_DELAY_MS);
        });
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        isAsyncEditor,
      };
    } finally {
      if (!isAsyncEditor) {
        // Re-enable Kitty keyboard protocol if it was enabled
        if (kittyWasEnabled) {
          await enableKittyProtocol();
        }

        process.stdout.write(ANSI.HIDE_CURSOR);

        // Resume TUI rendering
        await this.resume();
      }
    }
  }

  async openTextAndWait({
    content,
    fileName = 'prompt.md',
    tempDirPrefix = 'industry-editor-',
  }: {
    content: string;
    fileName?: string;
    tempDirPrefix?: string;
  }): Promise<OpenTextInEditorResult> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), tempDirPrefix));
    const filePath = path.join(tempDir, fileName);
    let cleanedUp = false;

    const cleanup = async (): Promise<void> => {
      if (cleanedUp) return;
      cleanedUp = true;
      await fs.rm(tempDir, { recursive: true, force: true });
    };

    const readContent = (): Promise<string> => fs.readFile(filePath, 'utf8');

    try {
      await fs.writeFile(filePath, content, 'utf8');

      const editorResult = await this.openFileAndWait(filePath);
      if (!editorResult.success) {
        await cleanup();
        return {
          success: false,
          error: editorResult.error ?? 'Failed to open editor.',
          isAsyncEditor: editorResult.isAsyncEditor,
        };
      }

      if (editorResult.isAsyncEditor) {
        return {
          success: true,
          isAsyncEditor: true,
          filePath,
          readContent,
          cleanup,
        };
      }

      const editedContent = await readContent();
      await cleanup();
      return {
        success: true,
        isAsyncEditor: false,
        content: editedContent,
      };
    } catch (error) {
      await cleanup();
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

let editorServiceInstance: EditorService | null = null;

export function getEditorService(): EditorService {
  if (!editorServiceInstance) {
    editorServiceInstance = new EditorService();
  }
  return editorServiceInstance;
}
