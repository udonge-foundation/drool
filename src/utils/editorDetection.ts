/**
 * Utility for detecting which editor will be used for opening files.
 * Checks IDE client connection first, then $VISUAL and $EDITOR environment variables,
 * or falls back to system default.
 * Priority: IDE client > $VISUAL > $EDITOR > system default
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';

import type { JetBrainsIdeClient } from '@/services/JetBrainsIdeClient';
import type { VSCodeIdeClient } from '@/services/VSCodeIdeClient';
import { getSystemOpenCommand } from '@/utils/getSystemOpenCommand';
import { IdeDetector } from '@/utils/ide-detector';
import type { EditorDetectionResult } from '@/utils/types';

// Known GUI editors (async unless wait flag present)
const KNOWN_GUI_EDITORS = new Set([
  'code',
  'vscode',
  'cursor',
  'surf',
  'sublime',
  'subl',
  'atom',
  // Windows editors (without .exe extension for comparison)
  'notepad',
  'notepad++',
  'wordpad',
  'write',
]);

// Known CLI editors (always sync)
const KNOWN_CLI_EDITORS = new Set([
  'vim',
  'vi',
  'nvim',
  'neovim',
  'nano',
  'emacs',
  'emacsclient',
  'joe',
  'pico',
  'micro',
  'ed',
  'ex',
  'fresh',
  // Windows CLI editors (without .exe extension for comparison)
  'edit',
]);

// Wait flags that make GUI editors synchronous
const WAIT_FLAGS = ['--wait', '-w'];

/**
 * Checks if a command is available in the system PATH or if a full path exists
 * @param command - Command name or full path to check (e.g., 'code' or 'C:\Windows\notepad.exe')
 * @returns true if command exists, false otherwise
 */
function isCommandAvailable(command: string): boolean {
  try {
    // If it's a full path (absolute), check if file exists
    if (command.includes('/') || command.includes('\\')) {
      return existsSync(command);
    }

    // Otherwise check if command is in PATH
    const checkCommand =
      process.platform === 'win32'
        ? `where ${command}`
        : `command -v ${command}`;
    execSync(checkCommand, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts the base command from an editor string
 * Handles quoted paths, full paths with spaces, and .exe extensions
 * @param editor - Full editor command (e.g., "code --wait", "C:\Program Files\Editor\editor.exe")
 * @returns Base command name (e.g., "code", "editor")
 */
function getBaseCommand(editor: string): string {
  let command = editor.trim();

  // Remove surrounding quotes if present
  if (
    (command.startsWith('"') && command.endsWith('"')) ||
    (command.startsWith("'") && command.endsWith("'"))
  ) {
    command = command.slice(1, -1);
  }

  // Extract first part (command/path) before any space
  const spaceIndex = command.indexOf(' ');
  if (spaceIndex > 0) {
    command = command.substring(0, spaceIndex);
  }

  // Extract filename from full path (works for both / and \)
  const pathParts = command.split(/[\\/]/);
  const filename = pathParts[pathParts.length - 1] ?? command;

  // Remove .exe extension for comparison (Windows)
  return filename.toLowerCase().replace(/\.exe$/i, '');
}

/**
 * Checks if editor command contains wait flags
 * @param editor - Full editor command
 * @returns true if contains --wait or -w flags
 */
function hasWaitFlag(editor: string): boolean {
  return WAIT_FLAGS.some((flag: string): boolean => editor.includes(flag));
}

/**
 * Processes an editor choice and determines its properties
 * Handles the special case of nano → VSCode fallback
 * @param editor - Editor command string
 * @param source - Original source of the editor
 * @returns Editor detection result or null if nano should be replaced
 */
function processEditorChoice(
  editor: string,
  source: '$VISUAL' | '$EDITOR'
): EditorDetectionResult | null {
  const baseCommand = getBaseCommand(editor);

  // Special case: nano should be replaced with VSCode if available
  if (baseCommand === 'nano') {
    if (isCommandAvailable('code')) {
      return {
        editor: 'code',
        editorSource: 'drool default',
        isCli: false,
        isSync: false,
      };
    }
    // nano detected but VSCode not available - fall through to system default
    return null;
  }

  // Special case: Windows notepad - always available but check for better alternatives
  if (process.platform === 'win32' && baseCommand === 'notepad') {
    // Check if VSCode is available as better alternative
    if (isCommandAvailable('code')) {
      return {
        editor: 'code',
        editorSource: 'drool default',
        isCli: false,
        isSync: false,
      };
    }
    // Use notepad if no better option
    return {
      editor: 'notepad',
      editorSource: source,
      isCli: false,
      isSync: false,
    };
  }

  // Determine if it's a CLI or GUI editor
  let isCli: boolean;
  if (KNOWN_CLI_EDITORS.has(baseCommand)) {
    isCli = true;
  } else if (KNOWN_GUI_EDITORS.has(baseCommand)) {
    isCli = false;
  } else {
    // Unknown editor - use heuristic
    const openCommandBase = getBaseCommand(getSystemOpenCommand());
    isCli = baseCommand !== openCommandBase;
  }

  // Determine if it's synchronous
  let isSync: boolean;
  if (isCli) {
    // CLI editors are always synchronous
    isSync = true;
  } else {
    // GUI editors are sync only if they have wait flags
    isSync = hasWaitFlag(editor);
  }

  return {
    editor,
    editorSource: source,
    isCli,
    isSync,
  };
}

/**
 * Detects which editor will be used based on IDE client connection, environment variables, and platform.
 * Priority: IDE client > $VISUAL > $EDITOR > system default (open/explorer.exe/xdg-open)
 *
 * @param ideClient - Optional IDE client instance (VSCode or JetBrains)
 * @returns Object containing editor command, source, and behavior flags
 */
export function detectEditor(
  ideClient?: VSCodeIdeClient | JetBrainsIdeClient
): EditorDetectionResult {
  // Priority 0: Check IDE client connection
  if (ideClient?.isConnected()) {
    // Check if it's a VSCodeIdeClient (includes VSCode, Cursor, Windsurf)
    if ('openFile' in ideClient) {
      // VSCodeIdeClient - detect specific IDE type
      const ideDetector = IdeDetector.getInstance();
      const ideInfo = ideDetector.detectIde();
      return {
        editor: ideInfo.displayName, // 'VS Code', 'Cursor', or 'Windsurf'
        editorSource: 'IDE',
        isCli: false,
        isSync: false,
      };
    }
    // JetBrainsIdeClient
    return {
      editor: 'JetBrains IDE',
      editorSource: 'IDE',
      isCli: false,
      isSync: false,
    };
  }

  // Priority 1: Check $VISUAL
  const visualEditor = process.env.VISUAL;
  if (visualEditor) {
    const result = processEditorChoice(visualEditor, '$VISUAL');
    if (result) return result;
    // If null, nano was detected but VSCode not available - continue to check $EDITOR
  }

  // Priority 2: Check $EDITOR
  const editorEnv = process.env.EDITOR;
  if (editorEnv) {
    const result = processEditorChoice(editorEnv, '$EDITOR');
    if (result) return result;
    // If null, nano was detected but VSCode not available - fall through to system default
  }

  // Priority 3: System default
  if (process.platform === 'win32') {
    // On Windows, use notepad as better default than 'start'
    return {
      editor: 'notepad',
      editorSource: 'system default',
      isCli: false,
      isSync: false,
    };
  }

  const openCommand = getSystemOpenCommand();
  return {
    editor: openCommand,
    editorSource: 'system default',
    isCli: false,
    isSync: false,
  };
}
