/**
 * Terminal setup utility for configuring Shift+Enter and Ctrl+Enter support.
 *
 * Configures VS Code-style terminals to send "\u001b[13;2u" for Shift+Enter and
 * "\u001b[13;5u" for Ctrl+Enter.
 * If Kitty protocol is already enabled, no action is required.
 */

import { exec, execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import { parse as parseJsonc } from 'jsonc-parser';

import { logWarn } from '@industry/logging';

import { getI18n } from '@/i18n';
import { SupportedTerminal } from '@/utils/enums';
import { requestTmuxExtendedKeyMode } from '@/utils/interactiveTerminalState';
import { isWsl } from '@/utils/isWsl';
import { isKittyProtocolEnabled } from '@/utils/kittyProtocolDetector';
import { isQueuedMessagesFeatureEnabled } from '@/utils/queuedMessagesFeatureFlag';
import type { TerminalSetupResult } from '@/utils/types';

const execAsync = promisify(exec);

const VSCODE_SHIFT_ENTER_SEQUENCE = '\u001b[13;2u';
const VSCODE_CTRL_ENTER_SEQUENCE = '\u001b[13;5u';
const WINDOWS_TERMINAL_SHIFT_ENTER_SEQUENCE = '\u001b[13;2u';
const WINDOWS_TERMINAL_CTRL_ENTER_SEQUENCE = '\u001b[13;5u';
const TMUX_EXTENDED_KEYS_FEATURE = 'xterm*:extkeys';

type TmuxSetupState = {
  extendedKeys: boolean;
  extendedKeysFormat: boolean;
  extendedKeysFormatSupported: boolean;
  terminalFeatures: boolean;
};

type TmuxConfigRequirement = {
  line: string;
  isConfigured: (content: string) => boolean;
  isSupported?: (state: TmuxSetupState | undefined) => boolean;
};

const TMUX_CONFIG_REQUIREMENTS: TmuxConfigRequirement[] = [
  {
    line: 'set -s extended-keys on',
    isConfigured: (content: string) =>
      /^\s*set(?:-option)?\s+-s\s+extended-keys\s+on\s*(?:#.*)?$/m.test(
        content
      ),
  },
  {
    line: 'set -g extended-keys-format csi-u',
    isConfigured: (content: string) =>
      /^\s*set(?:-option)?\s+-g\s+extended-keys-format\s+csi-u\s*(?:#.*)?$/m.test(
        content
      ),
    isSupported: (state) => state?.extendedKeysFormatSupported ?? true,
  },
  {
    line: "set -as terminal-features 'xterm\\*:extkeys'",
    isConfigured: (content: string) =>
      /^\s*set(?:-option)?\s+-as\s+terminal-features\s+['"]?xterm\\?\*:extkeys['"]?\s*(?:#.*)?$/m.test(
        content
      ),
  },
];

type TmuxLiveRequirement = {
  args: string[];
  isSupported?: (state: TmuxSetupState) => boolean;
  isConfigured: (state: TmuxSetupState) => boolean;
};

const TMUX_LIVE_REQUIREMENTS: TmuxLiveRequirement[] = [
  {
    args: ['set-option', '-s', 'extended-keys', 'on'],
    isConfigured: (state) => state.extendedKeys,
  },
  {
    args: ['set-option', '-g', 'extended-keys-format', 'csi-u'],
    isSupported: (state) => state.extendedKeysFormatSupported,
    isConfigured: (state) => state.extendedKeysFormat,
  },
  {
    args: [
      'set-option',
      '-as',
      'terminal-features',
      TMUX_EXTENDED_KEYS_FEATURE,
    ],
    isConfigured: (state) => state.terminalFeatures,
  },
];

function getConfiguredKeybindingList(includeCtrlEnter: boolean): string {
  return includeCtrlEnter ? 'Shift+Enter and Ctrl+Enter' : 'Shift+Enter';
}

type VSCodeKeybinding = {
  key?: string;
  command?: string;
  when?: string;
  args?: { text?: string };
  [k: string]: unknown;
};

type WindowsTerminalAction = {
  keys?: string;
  command?: { action?: string; input?: string };
  [k: string]: unknown;
};

type WindowsTerminalSettings = {
  actions?: WindowsTerminalAction[];
  keybindings?: WindowsTerminalAction[];
  [k: string]: unknown;
};

type TerminalSetupOptions = {
  includeCtrlEnter?: boolean;
};

function isVSCodeTerminalSequenceBinding(
  binding: VSCodeKeybinding,
  key: 'shift+enter' | 'ctrl+enter',
  text: string
): boolean {
  return (
    binding.key?.toLowerCase() === key &&
    binding.command === 'workbench.action.terminal.sendSequence' &&
    binding.args?.text === text
  );
}

function isWindowsTerminalSendInputBinding(
  action: WindowsTerminalAction,
  key: 'shift+enter' | 'ctrl+enter',
  input: string
): boolean {
  return (
    typeof action.keys === 'string' &&
    action.keys.toLowerCase() === key &&
    action.command?.action === 'sendInput' &&
    action.command?.input === input
  );
}

async function detectTerminal(): Promise<SupportedTerminal | null> {
  const termProgram = process.env.TERM_PROGRAM;

  if (process.env.TMUX) {
    return SupportedTerminal.Tmux;
  }

  // Cursor indicators first
  if (
    process.env.CURSOR_TRACE_ID ||
    process.env.VSCODE_GIT_ASKPASS_MAIN?.toLowerCase().includes('cursor')
  ) {
    return SupportedTerminal.Cursor;
  }

  // Windsurf indicators
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.toLowerCase().includes('windsurf')) {
    return SupportedTerminal.Windsurf;
  }

  // VS Code
  if (termProgram === 'vscode' || process.env.VSCODE_GIT_IPC_HANDLE) {
    return SupportedTerminal.Vscode;
  }

  // Warp terminal detection
  if (termProgram === 'WarpTerminal' || process.env.WARP_USE_SSH_WRAPPER) {
    return SupportedTerminal.Warp;
  }

  // iTerm2 detection
  if (termProgram === 'iTerm.app') {
    return SupportedTerminal.Iterm2;
  }

  // macOS Terminal.app detection
  if (termProgram === 'Apple_Terminal') {
    return SupportedTerminal.MacosTerminal;
  }

  // PowerShell detection (Windows)
  // Check for PSModulePath which is unique to PowerShell
  if (process.env.PSModulePath && process.platform === 'win32') {
    return SupportedTerminal.Powershell;
  }

  // Parent process name check (non-Windows)
  if (os.platform() !== 'win32') {
    try {
      const { stdout } = await execAsync('ps -o comm= -p $PPID');
      const parentName = stdout.trim();
      if (parentName.includes('windsurf') || parentName.includes('Windsurf'))
        return SupportedTerminal.Windsurf;
      if (parentName.includes('cursor') || parentName.includes('Cursor'))
        return SupportedTerminal.Cursor;
      if (parentName.includes('code') || parentName.includes('Code'))
        return SupportedTerminal.Vscode;
    } catch {
      // ignore
    }
  }

  // Windows Terminal detection (WT_SESSION/WT_PROFILE_ID env vars)
  if (process.env.WT_SESSION || process.env.WT_PROFILE_ID) {
    return SupportedTerminal.WindowsTerminal;
  }

  return null;
}

async function backupFile(
  filePath: string,
  options: { required?: boolean } = {}
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.backup.${timestamp}`;
  if (options.required) {
    await fs.copyFile(filePath, backupPath);
    return;
  }

  try {
    await fs.copyFile(filePath, backupPath);
  } catch (error) {
    logWarn('[TerminalSetup] Failed to back up config file', {
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function getErrorOutput(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const parts = [error.message];
  if ('stderr' in error && typeof error.stderr === 'string') {
    parts.push(error.stderr);
  }
  if ('stdout' in error && typeof error.stdout === 'string') {
    parts.push(error.stdout);
  }
  return parts.join('\n');
}

function isTmuxInvalidOptionError(error: unknown, option: string): boolean {
  return getErrorOutput(error).includes(`invalid option: ${option}`);
}

function hasTmuxExtendedKeysFeature(terminalFeatures: string): boolean {
  return terminalFeatures
    .split('\n')
    .some((entry) => entry.split(':').slice(1).includes('extkeys'));
}

async function execTmux(args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile('tmux', args, { encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(stdout);
    });
  });
}

async function getTmuxSetupState(): Promise<TmuxSetupState> {
  const [extendedKeys, extendedKeysFormatResult, terminalFeatures] =
    await Promise.all([
      execTmux(['show-options', '-s', '-v', 'extended-keys']),
      execTmux(['show-options', '-s', '-v', 'extended-keys-format']).then(
        (value) => ({ supported: true, value }),
        (error: unknown) => {
          if (isTmuxInvalidOptionError(error, 'extended-keys-format')) {
            return { supported: false, value: '' };
          }
          throw error;
        }
      ),
      execTmux(['show-options', '-s', '-v', 'terminal-features']),
    ]);
  const normalizedExtendedKeys = extendedKeys.trim();

  return {
    extendedKeys:
      normalizedExtendedKeys === 'on' || normalizedExtendedKeys === 'always',
    extendedKeysFormatSupported: extendedKeysFormatResult.supported,
    extendedKeysFormat:
      !extendedKeysFormatResult.supported ||
      extendedKeysFormatResult.value.trim() === 'csi-u',
    terminalFeatures: hasTmuxExtendedKeysFeature(terminalFeatures.trim()),
  };
}

function isTmuxSetupComplete(state: TmuxSetupState): boolean {
  return (
    state.extendedKeys && state.extendedKeysFormat && state.terminalFeatures
  );
}

async function persistTmuxConfig(state: TmuxSetupState | undefined): Promise<{
  configPath: string;
  updated: boolean;
}> {
  const configPath = path.join(os.homedir(), '.tmux.conf');
  let content = '';

  try {
    content = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }

  const missingLines = TMUX_CONFIG_REQUIREMENTS.filter(
    ({ isSupported }) => !isSupported || isSupported(state)
  )
    .filter(({ isConfigured }) => !isConfigured(content))
    .map(({ line }) => line);
  if (missingLines.length === 0) {
    return { configPath, updated: false };
  }

  if (content.length > 0) {
    await backupFile(configPath, { required: true });
  }

  const separator =
    content.length === 0 ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  await fs.writeFile(
    configPath,
    `${content}${separator}${missingLines.join('\n')}\n`
  );
  return { configPath, updated: true };
}

async function applyTmuxLiveSetup(
  state: TmuxSetupState | undefined
): Promise<boolean> {
  const requirements = state
    ? TMUX_LIVE_REQUIREMENTS.filter(
        ({ isSupported }) => !isSupported || isSupported(state)
      ).filter(({ isConfigured }) => !isConfigured(state))
    : TMUX_LIVE_REQUIREMENTS;

  for (const { args } of requirements) {
    await execTmux(args);
  }

  return requirements.length > 0;
}

async function configureTmux(): Promise<TerminalSetupResult> {
  const t = getI18n().t.bind(getI18n());
  const configPath = path.join(os.homedir(), '.tmux.conf');
  let state: TmuxSetupState | undefined;

  try {
    state = await getTmuxSetupState();
  } catch (error) {
    logWarn('[TerminalSetup] Failed to inspect tmux options', {
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  let persisted: { configPath: string; updated: boolean };

  try {
    persisted = await persistTmuxConfig(state);
  } catch (error) {
    return {
      success: false,
      message: t('commands:slashMessages.terminalSetup.tmuxConfigureFailed', {
        file: configPath,
        error: String(error),
      }),
    };
  }

  try {
    const applied = await applyTmuxLiveSetup(state);
    requestTmuxExtendedKeyMode();
    return {
      success: true,
      message: t(
        persisted.updated || applied
          ? 'commands:slashMessages.terminalSetup.tmuxUpdated'
          : 'commands:slashMessages.terminalSetup.tmuxAlreadyConfigured',
        { file: persisted.configPath }
      ),
    };
  } catch {
    return {
      success: false,
      message: t('commands:slashMessages.terminalSetup.tmuxPartialFailure', {
        file: persisted.configPath,
      }),
    };
  }
}

function getVSCodeStyleConfigDir(appName: string): string | null {
  const platform = os.platform();
  if (platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      appName,
      'User'
    );
  }
  if (platform === 'win32') {
    if (!process.env.APPDATA) return null;
    return path.join(process.env.APPDATA, appName, 'User');
  }
  return path.join(os.homedir(), '.config', appName, 'User');
}

// Generic helper to ensure a keybinding/action exists with our exact spec.
// If an entry for the key exists but differs, it is replaced; otherwise it's added.
function ensureBinding<T, K extends keyof T>(
  list: T[],
  keyProp: K,
  keyName: 'shift+enter' | 'ctrl+enter',
  isExact: (item: T) => boolean,
  newItem: T,
  label: 'Shift+Enter' | 'Ctrl+Enter'
): { updated: T[]; change?: string } {
  const hasExact = list.some(isExact);
  const hasAny = list.some((i) => {
    const v = i[keyProp];
    return typeof v === 'string'
      ? (v as string).toLowerCase() === keyName
      : v === keyName;
  });
  if (hasExact) return { updated: list };
  const updated = list.filter((i) => {
    const v = i[keyProp];
    return typeof v === 'string'
      ? (v as string).toLowerCase() !== keyName
      : v !== keyName;
  });
  updated.unshift(newItem);
  return { updated, change: `${hasAny ? 'Replaced' : 'Added'} ${label}` };
}

async function configureVSCodeStyle(
  terminalName: string,
  appName: string,
  options: TerminalSetupOptions = {}
): Promise<TerminalSetupResult> {
  const includeCtrlEnter = options.includeCtrlEnter ?? true;
  const configDir = getVSCodeStyleConfigDir(appName);

  if (!configDir) {
    const t = getI18n().t.bind(getI18n());
    return {
      success: false,
      message: t('commands:slashMessages.terminalSetup.configPathNotFound', {
        terminal: terminalName,
      }),
    };
  }

  const keybindingsFile = path.join(configDir, 'keybindings.json');

  try {
    await fs.mkdir(configDir, { recursive: true });

    let keybindings: VSCodeKeybinding[] = [];
    try {
      const content = await fs.readFile(keybindingsFile, 'utf8');
      if (content) {
        await backupFile(keybindingsFile);
        try {
          const parsedContent = parseJsonc(content);
          if (!Array.isArray(parsedContent)) {
            const t = getI18n().t.bind(getI18n());
            return {
              success: false,
              message: t(
                'commands:slashMessages.terminalSetup.invalidKeybindingsArray',
                { terminal: terminalName, file: keybindingsFile }
              ),
            };
          }
          keybindings = parsedContent.filter(
            (v): v is VSCodeKeybinding => typeof v === 'object' && v !== null
          );
        } catch (parseError) {
          const t = getI18n().t.bind(getI18n());
          return {
            success: false,
            message: t(
              'commands:slashMessages.terminalSetup.invalidKeybindingsJson',
              {
                terminal: terminalName,
                file: keybindingsFile,
                error: String(parseError),
              }
            ),
          };
        }
      }
    } catch {
      // file does not exist, will create
    }

    const shiftEnterBinding = {
      key: 'shift+enter',
      command: 'workbench.action.terminal.sendSequence',
      when: 'terminalFocus',
      args: { text: VSCODE_SHIFT_ENTER_SEQUENCE },
    } as const;

    const ctrlEnterBinding = {
      key: 'ctrl+enter',
      command: 'workbench.action.terminal.sendSequence',
      when: 'terminalFocus',
      args: { text: VSCODE_CTRL_ENTER_SEQUENCE },
    } as const;
    let updatedKeybindings: VSCodeKeybinding[] = [...keybindings];
    const changes: string[] = [];

    const r1 = ensureBinding<VSCodeKeybinding, 'key'>(
      updatedKeybindings,
      'key',
      'shift+enter',
      (kb) =>
        isVSCodeTerminalSequenceBinding(
          kb,
          'shift+enter',
          shiftEnterBinding.args.text
        ),
      shiftEnterBinding,
      'Shift+Enter'
    );
    updatedKeybindings = r1.updated;
    if (r1.change) changes.push(r1.change);

    if (includeCtrlEnter) {
      const r2 = ensureBinding<VSCodeKeybinding, 'key'>(
        updatedKeybindings,
        'key',
        'ctrl+enter',
        (kb) =>
          isVSCodeTerminalSequenceBinding(
            kb,
            'ctrl+enter',
            ctrlEnterBinding.args.text
          ),
        ctrlEnterBinding,
        'Ctrl+Enter'
      );
      updatedKeybindings = r2.updated;
      if (r2.change) changes.push(r2.change);
    }

    if (changes.length > 0) {
      await fs.writeFile(
        keybindingsFile,
        JSON.stringify(updatedKeybindings, null, 4)
      );
      const t = getI18n().t.bind(getI18n());
      return {
        success: true,
        message: t('commands:slashMessages.terminalSetup.updatedKeybindings', {
          terminal: terminalName,
          changes: changes.join('; '),
          file: keybindingsFile,
        }),
      };
    }

    const t = getI18n().t.bind(getI18n());
    return {
      success: true,
      message: t('commands:slashMessages.terminalSetup.noChangesNeeded', {
        terminal: terminalName,
        file: keybindingsFile,
        keybindings: getConfiguredKeybindingList(includeCtrlEnter),
      }),
    };
  } catch (error) {
    const t = getI18n().t.bind(getI18n());
    return {
      success: false,
      message: t('commands:slashMessages.terminalSetup.configureFailed', {
        terminal: terminalName,
        file: keybindingsFile,
        error: String(error),
      }),
    };
  }
}

async function configureVSCode(
  options?: TerminalSetupOptions
): Promise<TerminalSetupResult> {
  return configureVSCodeStyle('VS Code', 'Code', options);
}

async function configureCursor(
  options?: TerminalSetupOptions
): Promise<TerminalSetupResult> {
  return configureVSCodeStyle('Cursor', 'Cursor', options);
}

async function configureWindsurf(
  options?: TerminalSetupOptions
): Promise<TerminalSetupResult> {
  return configureVSCodeStyle('Windsurf', 'Windsurf', options);
}

/**
 * Configure Windows Terminal keybindings to send Kitty CSI-u sequences for
 * Shift+Enter newlines and Ctrl+Enter end-of-loop queueing.
 */
async function configureWindowsTerminal(
  options: TerminalSetupOptions = {}
): Promise<TerminalSetupResult> {
  const includeCtrlEnter = options.includeCtrlEnter ?? true;
  const inWsl = isWsl();

  if (os.platform() !== 'win32' && !inWsl) {
    const t = getI18n().t.bind(getI18n());
    return {
      success: false,
      message: t('commands:slashMessages.terminalSetup.windowsOnly'),
    };
  }

  // In WSL, we need to find Windows Terminal settings via the mounted Windows filesystem
  let localAppData: string | null = null;
  if (inWsl) {
    // Try to find the Windows user's LocalAppData via common mount paths
    // WSL mounts Windows drives under /mnt/
    const windowsUsername = process.env.LOGNAME || process.env.USER;
    const possiblePaths = [
      // Try USERPROFILE if available (sometimes set in WSL)
      process.env.USERPROFILE
        ? `${process.env.USERPROFILE.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`)}/AppData/Local`
        : null,
      // Common default path
      `/mnt/c/Users/${windowsUsername}/AppData/Local`,
      // Try common Windows usernames
      '/mnt/c/Users/Default/AppData/Local',
    ].filter(Boolean) as string[];

    for (const p of possiblePaths) {
      try {
        await fs.access(p);
        localAppData = p;
        break;
      } catch {
        /* continue */
      }
    }

    if (!localAppData) {
      const t = getI18n().t.bind(getI18n());
      return {
        success: false,
        message: t('commands:slashMessages.terminalSetup.wslManualConfig'),
      };
    }
  } else {
    localAppData = process.env.LOCALAPPDATA ?? null;
    if (!localAppData) {
      const t = getI18n().t.bind(getI18n());
      return {
        success: false,
        message: t('commands:slashMessages.terminalSetup.localAppDataNotSet'),
      };
    }
  }

  // Stable then preview package names
  const packageIds = [
    'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
    'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe',
  ];

  let settingsPath: string | null = null;
  for (const pkg of packageIds) {
    const candidate = path.join(
      localAppData,
      'Packages',
      pkg,
      'LocalState',
      'settings.json'
    );
    try {
      await fs.access(candidate);
      settingsPath = candidate;
      break;
    } catch {
      /* continue */
    }
  }

  if (!settingsPath) {
    const t = getI18n().t.bind(getI18n());
    return {
      success: false,
      message: t('commands:slashMessages.terminalSetup.wtSettingsNotFound'),
    };
  }

  let settings: WindowsTerminalSettings = {};
  let created = false;
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    await backupFile(settingsPath);
    const parsed = parseJsonc(raw);
    settings =
      parsed && typeof parsed === 'object'
        ? (parsed as WindowsTerminalSettings)
        : {};
  } catch {
    // File may not exist or be invalid – start fresh
    created = true;
    settings = {};
  }

  // Determine where actions/keys live
  if (
    !Array.isArray(settings.actions) &&
    !Array.isArray(settings.keybindings)
  ) {
    settings.actions = [];
  }
  let actions: WindowsTerminalAction[] = Array.isArray(settings.actions)
    ? settings.actions
    : Array.isArray(settings.keybindings)
      ? settings.keybindings
      : [];

  const shiftEnterBinding = {
    keys: 'shift+enter',
    command: {
      action: 'sendInput',
      input: WINDOWS_TERMINAL_SHIFT_ENTER_SEQUENCE,
    },
  };

  const ctrlEnterBinding = {
    keys: 'ctrl+enter',
    command: {
      action: 'sendInput',
      input: WINDOWS_TERMINAL_CTRL_ENTER_SEQUENCE,
    },
  };
  // Apply replacements/additions via shared helper
  const changes: string[] = [];

  const w1 = ensureBinding<WindowsTerminalAction, 'keys'>(
    actions,
    'keys',
    'shift+enter',
    (a) =>
      isWindowsTerminalSendInputBinding(
        a,
        'shift+enter',
        WINDOWS_TERMINAL_SHIFT_ENTER_SEQUENCE
      ),
    shiftEnterBinding,
    'Shift+Enter'
  );
  actions = w1.updated;
  if (w1.change) changes.push(w1.change);

  if (includeCtrlEnter) {
    const w2 = ensureBinding<WindowsTerminalAction, 'keys'>(
      actions,
      'keys',
      'ctrl+enter',
      (a) =>
        isWindowsTerminalSendInputBinding(
          a,
          'ctrl+enter',
          WINDOWS_TERMINAL_CTRL_ENTER_SEQUENCE
        ),
      ctrlEnterBinding,
      'Ctrl+Enter'
    );
    actions = w2.updated;
    if (w2.change) changes.push(w2.change);
  }

  // Write if we changed anything or if the file was created
  if (changes.length > 0 || created) {
    // Write back – respect original container (actions vs keybindings)
    if (Array.isArray(settings.actions)) {
      settings.actions = actions;
    } else {
      settings.keybindings = actions;
    }
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  }

  const t = getI18n().t.bind(getI18n());

  if (changes.length === 0) {
    return {
      success: true,
      message: t('commands:slashMessages.terminalSetup.wtNoChanges', {
        keybindings: getConfiguredKeybindingList(includeCtrlEnter),
      }),
    };
  }

  return {
    success: true,
    message: t('commands:slashMessages.terminalSetup.wtUpdated', {
      changes: changes.join('; '),
      file: settingsPath,
    }),
  };
}

/**
 * Main entry: detect terminal and configure keybindings as needed.
 */
export async function terminalSetup(
  options: TerminalSetupOptions = {}
): Promise<TerminalSetupResult> {
  const includeCtrlEnter =
    options.includeCtrlEnter ?? isQueuedMessagesFeatureEnabled();
  const terminal = await detectTerminal();
  const t = getI18n().t.bind(getI18n());

  if (terminal === SupportedTerminal.Tmux) {
    return await configureTmux();
  }

  // If Kitty keyboard protocol is enabled, provide terminal-specific message
  if (isKittyProtocolEnabled()) {
    if (terminal === SupportedTerminal.Iterm2) {
      return {
        success: true,
        message: t('commands:slashMessages.terminalSetup.kittyIterm2'),
      };
    }
    return {
      success: true,
      message: t('commands:slashMessages.terminalSetup.kittyEnabled'),
    };
  }
  if (!terminal) {
    return {
      success: false,
      message: t('commands:slashMessages.terminalSetup.cannotDetect'),
    };
  }

  switch (terminal) {
    case SupportedTerminal.Vscode:
      return configureVSCode({ includeCtrlEnter });
    case SupportedTerminal.Cursor:
      return configureCursor({ includeCtrlEnter });
    case SupportedTerminal.Windsurf:
      return configureWindsurf({ includeCtrlEnter });
    case SupportedTerminal.WindowsTerminal:
      return configureWindowsTerminal({ includeCtrlEnter });
    case SupportedTerminal.Warp:
      return {
        success: true,
        message: t('commands:slashMessages.terminalSetup.warpVerified'),
      };
    case SupportedTerminal.Iterm2:
      return {
        success: true,
        message: t('commands:slashMessages.terminalSetup.iterm2Verified'),
      };
    case SupportedTerminal.MacosTerminal:
      return {
        success: true,
        message: t('commands:slashMessages.terminalSetup.macosTerminalNote'),
      };
    case SupportedTerminal.Powershell:
      return {
        success: true,
        message: t('commands:slashMessages.terminalSetup.powershellVerified'),
      };
    default:
      return {
        success: false,
        message: t('commands:slashMessages.terminalSetup.unsupportedTerminal', {
          terminal,
        }),
      };
  }
}

/**
 * Returns true when the current environment would benefit from running /terminal-setup.
 * - Kitty keyboard protocol enabled => false
 * - Unsupported terminal => false
 * - VS Code/Cursor/Windsurf: keybindings.json missing our entries => true
 * - Windows Terminal: settings.json missing our entries => true
 */
export async function shouldNudgeTerminalSetup(
  options: TerminalSetupOptions = {}
): Promise<{
  shouldNudge: boolean;
  terminal: SupportedTerminal | null;
}> {
  const includeCtrlEnter =
    options.includeCtrlEnter ?? isQueuedMessagesFeatureEnabled();

  const terminal = await detectTerminal();
  if (terminal === SupportedTerminal.Tmux) {
    try {
      return {
        shouldNudge: !isTmuxSetupComplete(await getTmuxSetupState()),
        terminal,
      };
    } catch (error) {
      logWarn('[TerminalSetup] Failed to inspect tmux options for nudge', {
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return { shouldNudge: true, terminal };
    }
  }

  if (isKittyProtocolEnabled()) {
    return { shouldNudge: false, terminal: null };
  }

  if (!terminal) return { shouldNudge: false, terminal: null };

  // Helper: VS Code-style keybindings check
  const needsVSCodeStyle = async (appName: string): Promise<boolean> => {
    const dir = getVSCodeStyleConfigDir(appName);
    if (!dir) return true; // cannot verify; nudge
    const file = path.join(dir, 'keybindings.json');
    try {
      const content = await fs.readFile(file, 'utf8');
      const parsed = parseJsonc(content);
      if (!Array.isArray(parsed)) return true;
      const arr: VSCodeKeybinding[] = parsed.filter(
        (v): v is VSCodeKeybinding => typeof v === 'object' && v !== null
      );
      const hasShift = arr.some((kb) =>
        isVSCodeTerminalSequenceBinding(
          kb,
          'shift+enter',
          VSCODE_SHIFT_ENTER_SEQUENCE
        )
      );
      const hasCtrl = arr.some((kb) =>
        isVSCodeTerminalSequenceBinding(
          kb,
          'ctrl+enter',
          VSCODE_CTRL_ENTER_SEQUENCE
        )
      );
      return !hasShift || (includeCtrlEnter && !hasCtrl);
    } catch {
      // File missing or unreadable: nudge to set it up
      return true;
    }
  };

  // Helper: Windows Terminal check
  const needsWindowsTerminal = async (): Promise<boolean> => {
    const inWsl = isWsl();
    if (os.platform() !== 'win32' && !inWsl) return false;

    // Find localAppData - on Windows use env var, on WSL try to find via mount
    let localAppData: string | null = null;
    if (inWsl) {
      const windowsUsername = process.env.LOGNAME || process.env.USER;
      const possiblePaths = [
        process.env.USERPROFILE
          ? `${process.env.USERPROFILE.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`)}/AppData/Local`
          : null,
        `/mnt/c/Users/${windowsUsername}/AppData/Local`,
      ].filter(Boolean) as string[];

      for (const p of possiblePaths) {
        try {
          await fs.access(p);
          localAppData = p;
          break;
        } catch {
          /* continue */
        }
      }
    } else {
      localAppData = process.env.LOCALAPPDATA ?? null;
    }

    if (!localAppData) return true;
    const packageIds = [
      'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
      'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe',
    ];
    let settingsPath: string | null = null;
    for (const pkg of packageIds) {
      const candidate = path.join(
        localAppData,
        'Packages',
        pkg,
        'LocalState',
        'settings.json'
      );
      try {
        await fs.access(candidate);
        settingsPath = candidate;
        break;
      } catch {
        /* continue */
      }
    }
    if (!settingsPath) return true;
    try {
      const raw = await fs.readFile(settingsPath, 'utf8');
      const parsed = parseJsonc(raw);
      let actions: WindowsTerminalAction[] = [];
      if (parsed && typeof parsed === 'object') {
        const maybe = parsed as { actions?: unknown; keybindings?: unknown };
        if (Array.isArray(maybe.actions)) {
          actions = maybe.actions.filter(
            (v): v is WindowsTerminalAction =>
              typeof v === 'object' && v !== null
          );
        } else if (Array.isArray(maybe.keybindings)) {
          actions = maybe.keybindings.filter(
            (v): v is WindowsTerminalAction =>
              typeof v === 'object' && v !== null
          );
        }
      }
      const hasShift = actions.some((action) =>
        isWindowsTerminalSendInputBinding(
          action,
          'shift+enter',
          WINDOWS_TERMINAL_SHIFT_ENTER_SEQUENCE
        )
      );
      const hasCtrl = actions.some((action) =>
        isWindowsTerminalSendInputBinding(
          action,
          'ctrl+enter',
          WINDOWS_TERMINAL_CTRL_ENTER_SEQUENCE
        )
      );
      return !hasShift || (includeCtrlEnter && !hasCtrl);
    } catch {
      return true;
    }
  };

  switch (terminal) {
    case SupportedTerminal.Vscode:
      return { shouldNudge: await needsVSCodeStyle('Code'), terminal };
    case SupportedTerminal.Cursor:
      return { shouldNudge: await needsVSCodeStyle('Cursor'), terminal };
    case SupportedTerminal.Windsurf:
      return { shouldNudge: await needsVSCodeStyle('Windsurf'), terminal };
    case SupportedTerminal.WindowsTerminal:
      return { shouldNudge: await needsWindowsTerminal(), terminal };
    case SupportedTerminal.Warp:
      // Warp supports Shift+Enter natively, no nudge needed
      return { shouldNudge: false, terminal };
    case SupportedTerminal.Iterm2:
      // iTerm2 with Kitty keyboard protocol, no nudge needed
      return { shouldNudge: false, terminal };
    case SupportedTerminal.MacosTerminal:
      // macOS Terminal doesn't support Shift+Enter, but we can inform users
      // Only nudge once so they know about the workaround
      return { shouldNudge: false, terminal };
    case SupportedTerminal.Powershell:
      // PowerShell supports Shift+Enter natively, no nudge needed
      return { shouldNudge: false, terminal };
    default:
      return { shouldNudge: false, terminal: null };
  }
}
