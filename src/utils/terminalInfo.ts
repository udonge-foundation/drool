import { spawnSync } from 'child_process';

import type { TerminalInfo } from '@/utils/types';

type Detector = () => TerminalInfo | null;

const env = (key: string): string | undefined => {
  const value = process.env[key];
  return value && value.length > 0 ? value : undefined;
};

const info = (name?: string, version?: string): TerminalInfo | null => {
  if (!name) return null;
  return version && version.length > 0 ? { name, version } : { name };
};

const detectFromTermProgram: Detector = () => {
  const name = env('TERM_PROGRAM');
  const version = env('TERM_PROGRAM_VERSION');
  return info(name, version);
};

const detectFromTerminalEmulator: Detector = () => {
  const name = env('TERMINAL_EMULATOR');
  return name ? { name } : null;
};

const detectFromWindowsEnv: Detector = () => {
  // Windows Terminal
  if (env('WT_SESSION') || env('WT_PROFILE_ID')) {
    return { name: 'windows-terminal' };
  }

  // PowerShell (check PSModulePath which is set by PowerShell)
  // Only detect if not in Windows Terminal (which also runs PowerShell)
  const psModulePath = env('PSModulePath');
  if (psModulePath) {
    return { name: 'powershell' };
  }

  // Terminus (Sublime Text terminal)
  if (env('TERMINUS_SUBLIME') || env('TERMINUS_CONFIG')) {
    return { name: 'terminus' };
  }

  // ConEmu
  if (env('ConEmuPID') || env('ConEmuBaseDir') || env('ConEmuDir')) {
    const version = env('ConEmuBuild');
    return info('conemu', version);
  }

  // Cmder
  if (env('CMDER_ROOT')) {
    return { name: 'cmder' };
  }

  // Babun
  if (env('BABUN_HOME')) {
    return { name: 'babun' };
  }

  return null;
};

const detectFromLinuxEnv: Detector = () => {
  const term = env('TERM');

  // Kitty
  if (env('KITTY_PID')) {
    return { name: 'kitty' };
  }

  // Alacritty
  if (env('ALACRITTY_SOCKET')) {
    return { name: 'alacritty' };
  }

  // WezTerm
  if (env('WEZTERM_EXECUTABLE')) {
    return { name: 'wezterm' };
  }

  // Terminator
  if (env('TERMINATOR_UUID')) {
    return { name: 'terminator' };
  }

  // GNOME Terminal
  if (env('GNOME_TERMINAL_SERVICE') || env('GNOME_TERMINAL_SCREEN')) {
    const version = env('VTE_VERSION');
    return info('gnome-terminal', version);
  }

  // Konsole
  const konsoleVersion = env('KONSOLE_VERSION');
  if (konsoleVersion) {
    return info('konsole', konsoleVersion);
  }

  // VTE-based terminals
  const vteVersion = env('VTE_VERSION');
  if (vteVersion) {
    return info(term ?? 'vte', vteVersion);
  }

  // Xterm
  const xtermVersion = env('XTERM_VERSION');
  if (xtermVersion) {
    return info('xterm', xtermVersion);
  }

  return null;
};

const detectFromMultiplexers: Detector = () => {
  const term = env('TERM');

  // Tmux
  const tmux = env('TMUX');
  if (tmux) {
    return { name: 'tmux' };
  }

  // GNU Screen
  const screen = env('STY');
  if (screen) {
    return { name: 'screen' };
  }

  // Detect from TERM value as fallback
  if (term && (term.includes('tmux') || term.includes('screen'))) {
    return { name: term };
  }

  return null;
};

/**
 * Map of patterns in process commands to terminal names and versions.
 * Used when walking the process tree to detect terminals (e.g., when running with sudo).
 */
const PROCESS_TREE_TERMINAL_PATTERNS: Array<{
  pattern: RegExp;
  name: string;
  versionExtractor?: (
    match: RegExpMatchArray | null,
    cmd: string
  ) => string | undefined;
}> = [
  // iTerm2 - look for iTerm in the path
  { pattern: /iTerm\.app|iTerm2|iTermServer/i, name: 'iTerm.app' },
  // Alacritty
  { pattern: /alacritty/i, name: 'Alacritty' },
  // Kitty
  { pattern: /kitty/i, name: 'kitty' },
  // WezTerm
  { pattern: /wezterm/i, name: 'WezTerm' },
  // Hyper
  { pattern: /hyper/i, name: 'Hyper' },
  // Apple Terminal
  { pattern: /Terminal\.app/i, name: 'Apple_Terminal' },
  // GNOME Terminal
  { pattern: /gnome-terminal/i, name: 'gnome-terminal' },
  // Konsole
  { pattern: /konsole/i, name: 'konsole' },
  // Windows Terminal
  { pattern: /WindowsTerminal/i, name: 'windows-terminal' },
];

/**
 * Detect terminal by walking up the process tree.
 * This is useful when environment variables are not available (e.g., running with sudo).
 * Only works on Unix-like systems (macOS, Linux).
 */
const detectFromProcessTree: Detector = () => {
  // Only attempt on Unix-like systems
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return null;
  }

  try {
    // Walk up the process tree iteratively using ps commands
    // Start with current process and go up to 15 levels
    let currentPid = process.ppid;
    const commands: string[] = [];

    for (let i = 0; i < 10; i++) {
      if (!currentPid || currentPid <= 1) {
        break;
      }

      try {
        // Get command and parent PID for current process
        const result = spawnSync(
          'ps',
          ['-o', 'ppid=,command=', '-p', String(currentPid)],
          {
            encoding: 'utf8',
            timeout: 500,
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );

        const psOutput = result.stdout?.trim() ?? '';
        if (!psOutput) break;

        // Parse output: first token is ppid, rest is command
        const match = psOutput.match(/^\s*(\d+)\s+(.+)$/);
        if (!match) break;

        const parentPid = parseInt(match[1], 10);
        const command = match[2];

        commands.push(command);
        currentPid = parentPid;
      } catch {
        break;
      }
    }

    // Check each command against known terminal patterns
    for (const cmd of commands) {
      for (const { pattern, name } of PROCESS_TREE_TERMINAL_PATTERNS) {
        if (pattern.test(cmd)) {
          return { name };
        }
      }
    }
  } catch {
    // Silently fail - this is a best-effort fallback
  }

  return null;
};

const detectFromTerm: Detector = () => {
  const term = env('TERM');
  return term ? { name: term } : null;
};

let cachedTerminalInfo: TerminalInfo | null = null;

export function getTerminalInfo(): TerminalInfo {
  if (cachedTerminalInfo) return cachedTerminalInfo;

  const detectors: Detector[] = [
    detectFromTermProgram,
    detectFromTerminalEmulator,
    detectFromWindowsEnv,
    detectFromLinuxEnv,
    detectFromMultiplexers,
    // Process tree detection as fallback before TERM variable (e.g., for sudo)
    detectFromProcessTree,
    detectFromTerm,
  ];

  for (const detector of detectors) {
    const result = detector();
    if (result) {
      cachedTerminalInfo = result;
      return result;
    }
  }

  cachedTerminalInfo = { name: 'unknown' };
  return cachedTerminalInfo;
}
