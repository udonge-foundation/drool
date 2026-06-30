import { execFile, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import {
  BuiltInSound,
  SubagentSoundMode,
  SoundFocusMode,
} from '@industry/common/settings/enums';
import { logError, logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { getTerminalFocusState } from '@/contexts/terminalFocusState';
import { getI18n } from '@/i18n';
import { getExecRuntimeConfig } from '@/services/ExecRuntimeConfigService';
import { getSettingsService } from '@/services/SettingsService';
import fxAck01Sound from '@assets/sounds/fx-ack01.wav' with { type: 'file' };
import fxOk01Sound from '@assets/sounds/fx-ok01.wav' with { type: 'file' };
import { emitTerminalBell } from '@/utils/terminalBell';
import type { SoundOption } from '@/utils/types';

const execFileAsync = promisify(execFile);

interface PlaySoundOptions {
  fallbackToBell?: boolean;
  timeout?: number;
}

/**
 * Gets the embedded sound file path
 * Bun's --compile automatically embeds files imported with {type: 'file'}
 */
function getBuiltInSoundPath(sound: BuiltInSound): string {
  switch (sound) {
    case BuiltInSound.FX_OK01:
      return fxOk01Sound;
    case BuiltInSound.FX_ACK01:
      return fxAck01Sound;
    default:
      throw new MetaError('Unknown built-in sound');
  }
}

/**
 * Checks if a file path is a Bun virtual filesystem path (bunfs)
 * These paths need to be extracted to the real filesystem before use
 * - Unix: /$bunfs/root/...
 * - Windows: B:/~BUN/root/...
 */
function isBunfsPath(filePath: string): boolean {
  return filePath.startsWith('/$bunfs/') || /^[A-Z]:\/~BUN\//i.test(filePath);
}

/**
 * Checks if a command exists in the system PATH
 */
function commandExists(command: string): boolean {
  try {
    const result = spawnSync('which', [command], {
      stdio: 'ignore',
      timeout: 1000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Detects the platform and returns the appropriate command to play audio
 */
function getAudioCommand(
  filePath: string
): { command: string; args: string[] } | null {
  const platform = process.platform;

  switch (platform) {
    case 'darwin': // macOS
      return { command: 'afplay', args: [filePath] };
    case 'linux':
      // Try common Linux audio players in order of preference
      if (commandExists('paplay')) {
        return { command: 'paplay', args: [filePath] };
      }
      if (commandExists('aplay')) {
        return { command: 'aplay', args: ['-q', filePath] };
      }
      if (commandExists('ffplay')) {
        return { command: 'ffplay', args: ['-nodisp', '-autoexit', filePath] };
      }
      return null;
    case 'win32': {
      // Windows - escape single quotes in path for PowerShell
      const escapedPath = filePath.replace(/'/g, "''");
      return {
        command: 'powershell',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-c',
          `Add-Type -AssemblyName System.Windows.Forms; (New-Object Media.SoundPlayer '${escapedPath}').PlaySync()`,
        ],
      };
    }
    default:
      return null;
  }
}

/**
 * Validates if a file exists and is accessible
 */
function validateSoundFile(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch (error) {
    logWarn('Failed to validate sound file', {
      filePath,
      cause: error,
    });
    return false;
  }
}

/**
 * Extracts an embedded sound file to ~/.industry/sounds/
 * Returns the path to the extracted file on the real filesystem
 * Assumes the input is a bunfs path that needs extraction
 * Race-safe: handles concurrent extraction attempts gracefully
 */
function extractSoundToIndustryDir(
  embeddedPath: string,
  soundName: BuiltInSound
): string {
  try {
    const industryDir = path.join(getIndustryHome(), getIndustryDirName());
    const soundsDir = path.join(industryDir, 'sounds');
    const targetPath = path.join(soundsDir, `${soundName}.wav`);

    // Log environment info to help diagnose prod vs dev differences
    logInfo('Sound extraction path resolution', {
      filePath: embeddedPath,
      targetPath,
    });

    // If already extracted, return the existing path
    if (fs.existsSync(targetPath)) {
      logInfo('Sound file already extracted, reusing', {
        fileName: soundName,
        targetPath,
      });
      return targetPath;
    }

    // Create sounds directory if needed (recursive handles race)
    try {
      fs.mkdirSync(soundsDir, { recursive: true });
    } catch (err) {
      // Ignore EEXIST - another process created it
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'EEXIST') throw err;
    }

    // Use exclusive flag to prevent race conditions
    try {
      const content = fs.readFileSync(embeddedPath);
      fs.writeFileSync(targetPath, content, { flag: 'wx' });
    } catch (err) {
      // If file was created by another process, use it
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'EEXIST' && fs.existsSync(targetPath)) {
        return targetPath;
      }
      throw err;
    }

    logInfo('Extracted embedded sound file', {
      filePath: embeddedPath,
      targetPath,
      cwd: getIndustryDirName(),
    });

    return targetPath;
  } catch (error) {
    logError('Failed to extract embedded sound file', {
      cause: error,
    });
    // Return original path and let it fail downstream
    return embeddedPath;
  }
}

/**
 * Plays a sound file using system commands
 */
async function playSoundFile(
  filePath: string,
  soundName: BuiltInSound | null,
  options: PlaySoundOptions = {}
): Promise<boolean> {
  const { fallbackToBell = true, timeout = 2000 } = options;
  // Windows needs more time due to PowerShell startup overhead
  const effectiveTimeout =
    process.platform === 'win32' ? Math.max(timeout, 5000) : timeout;

  // Extract embedded bunfs files to real filesystem if needed
  const actualPath =
    soundName && isBunfsPath(filePath)
      ? extractSoundToIndustryDir(filePath, soundName)
      : filePath;

  if (!validateSoundFile(actualPath)) {
    logWarn('Sound file validation failed, falling back to terminal bell', {
      filePath: actualPath,
      fileName: soundName || 'custom',
    });
    if (fallbackToBell) {
      emitTerminalBell();
    }
    return false;
  }

  const audioCommand = getAudioCommand(actualPath);
  if (!audioCommand) {
    logWarn('No audio player available, falling back to terminal bell', {
      platform: process.platform,
      fileName: soundName || 'custom',
    });
    if (fallbackToBell) {
      emitTerminalBell();
    }
    return false;
  }

  try {
    await execFileAsync(audioCommand.command, audioCommand.args, {
      timeout: effectiveTimeout,
      // Use signal for clean timeout handling
      killSignal: 'SIGTERM',
    });
    return true;
  } catch (error) {
    const execError = error as Error & {
      code?: number | string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };
    logError('Failed to play sound file', {
      filePath: actualPath,
      command: audioCommand.command,
      cause: execError,
      stderr: execError.stderr,
      signal: execError.signal,
    });
    if (fallbackToBell) {
      logWarn('Falling back to terminal bell after playback failure');
      emitTerminalBell();
    }
    return false;
  }
}

/**
 * Plays a completion sound based on the configured sound option
 *
 * @param soundOption - Can be:
 *   - BuiltInSound enum (SUCCESS or WAITING)
 *   - 'bell' for terminal bell
 *   - 'off' to disable sound
 *   - Absolute path to a custom sound file
 * @param options - Optional configuration
 * @param focusMode - When to play sounds based on focus state (optional)
 */
export async function playCompletionSound(
  soundOption: SoundOption,
  options: PlaySoundOptions = {},
  focusMode: SoundFocusMode = SoundFocusMode.Always
): Promise<void> {
  // Handle special cases
  if (soundOption === 'off') {
    return;
  }

  // In subagent mode, respect the subagent sound setting
  if (getExecRuntimeConfig().getDepth() > 0) {
    const soundMode = getSettingsService().getSubagentSoundMode();
    if (soundMode === SubagentSoundMode.Off) {
      return;
    }
    if (soundMode === SubagentSoundMode.Quiet) {
      emitTerminalBell();
      return;
    }
  }

  // Check focus mode requirements (get real-time focus state at play time)
  if (focusMode !== SoundFocusMode.Always) {
    const isTerminalFocused = getTerminalFocusState();
    if (focusMode === SoundFocusMode.Focused && !isTerminalFocused) {
      return; // Don't play when unfocused if mode is FOCUSED
    }
    if (focusMode === SoundFocusMode.Unfocused && isTerminalFocused) {
      return; // Don't play when focused if mode is UNFOCUSED
    }
  }

  if (soundOption === 'bell') {
    emitTerminalBell();
    return;
  }

  // Check if it's a built-in sound
  if (Object.values(BuiltInSound).includes(soundOption as BuiltInSound)) {
    const builtInSound = soundOption as BuiltInSound;
    const soundPath = getBuiltInSoundPath(builtInSound);
    await playSoundFile(soundPath, builtInSound, options);
    return;
  }

  // Treat as custom sound file path
  await playSoundFile(soundOption, null, options);
}

/**
 * Gets a human-readable display name for a sound option
 */
export function getSoundDisplayName(soundOption: SoundOption): string {
  const t = getI18n().t;
  if (soundOption === 'off') {
    return t('common:soundSelector.displayNameOff');
  }
  if (soundOption === 'bell') {
    return t('common:soundSelector.displayNameTerminalBell');
  }
  if (soundOption === BuiltInSound.FX_OK01) {
    return t('common:soundSelector.displayNameFxOk01');
  }
  if (soundOption === BuiltInSound.FX_ACK01) {
    return t('common:soundSelector.displayNameFxAck01');
  }
  // Custom sound file path
  return t('common:soundSelector.displayNameCustom');
}

/**
 * Gets a human-readable display name for a sound focus mode
 */
export function getSoundFocusModeDisplayName(mode: SoundFocusMode): string {
  const t = getI18n().t;
  switch (mode) {
    case SoundFocusMode.Always:
      return t('common:soundFocusMode.displayNameAlways');
    case SoundFocusMode.Focused:
      return t('common:soundFocusMode.displayNameFocused');
    case SoundFocusMode.Unfocused:
      return t('common:soundFocusMode.displayNameUnfocused');
    default:
      return t('common:soundFocusMode.displayNameAlways');
  }
}
