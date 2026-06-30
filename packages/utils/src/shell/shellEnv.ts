/**
 * Shell Environment Loader
 *
 * Inspired by the shell-env package (https://github.com/sindresorhus/shell-env)
 * but with proper Windows support and simplified for our specific needs.
 *
 * This module provides a way to load fresh environment variables from the user's shell,
 * which is particularly useful in GUI applications like Electron apps that don't
 * inherit environment variables from shell configuration files.
 */

import { spawn } from 'child_process';

import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

/**
 * Parse environment output from Unix shell
 */
function coerceNodeEnv(
  value?: string
): NodeJS.ProcessEnv['NODE_ENV'] | undefined {
  if (value === 'development' || value === 'production' || value === 'test') {
    return value;
  }

  return undefined;
}

// This function merges the user's shell environment with process.env.
// We intentionally do NOT inject a default NODE_ENV. This env represents the
// user's actual shell state and is forwarded to spawned terminals; injecting
// NODE_ENV=production would cause tools like npm to skip devDependencies.
function toProcessEnv(
  env: Record<string, string | undefined>
): NodeJS.ProcessEnv {
  const baseEnv = process.env;
  const resolvedNodeEnv =
    coerceNodeEnv(env.NODE_ENV) ?? coerceNodeEnv(baseEnv.NODE_ENV);

  const result: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...env,
  };

  if (resolvedNodeEnv !== undefined) {
    result.NODE_ENV = resolvedNodeEnv;
  }

  return result;
}

function parseEnvOutput(output: string): NodeJS.ProcessEnv {
  // Extract environment section between delimiters
  const envSection = output.split('_SHELL_ENV_DELIMITER_')[1];
  if (!envSection) {
    throw new MetaError(
      'Failed to parse environment output: missing delimiter'
    );
  }

  const env: Record<string, string> = {};

  // Parse each line as KEY=VALUE
  for (const line of envSection.split('\n').filter(Boolean)) {
    const firstEquals = line.indexOf('=');
    if (firstEquals > 0) {
      const key = line.slice(0, firstEquals);
      const value = line.slice(firstEquals + 1);
      env[key] = value;
    }
  }

  return toProcessEnv(env);
}

/**
 * Load environment variables on Windows using PowerShell
 *
 * Properly combines machine + user PATH variables to ensure system-installed
 * tools like Git are available, even when installed at machine level.
 */
async function loadWindowsEnvironment(): Promise<NodeJS.ProcessEnv> {
  // PowerShell command to get properly combined environment variables
  // This ensures we get both machine and user PATH entries
  const powershellCmd = `
    # Get environment variables from all sources
    $envVars = [Environment]::GetEnvironmentVariables()

    # Properly combine machine + user PATH variables
    $machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    $processPath = [Environment]::GetEnvironmentVariable('PATH', 'Process')

    # Combine paths, ensuring we don't have empty segments
    $combinedPath = @()
    if ($machinePath) { $combinedPath += $machinePath }
    if ($userPath) { $combinedPath += $userPath }
    if ($processPath) { $combinedPath += $processPath }

    # Set the combined PATH in our result
    $envVars['PATH'] = $combinedPath -join ';'

    # Convert to JSON and output
    $envVars | ConvertTo-Json
  `;

  const ps = spawn('powershell.exe', ['-NoProfile', '-Command', powershellCmd]);

  // Collect stdout
  let stdout = '';
  ps.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  // Wait for process to complete, handling both success and spawn errors.
  // The 'error' event fires when the executable is not found (ENOENT) or
  // cannot be spawned. Without this handler the error becomes an uncaught
  // exception that crashes the process.
  const exitCode = await new Promise<number>((resolve, reject) => {
    ps.on('error', (err) => reject(err));
    ps.on('close', (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new MetaError('PowerShell exited with non-zero code:', { exitCode });
  }

  // Parse JSON output
  const envObj = JSON.parse(stdout);
  const freshEnv: Record<string, string> = {};

  // Convert to flat key-value pairs
  Object.keys(envObj).forEach((key) => {
    const value = envObj[key];
    if (value === undefined || value === null) return;
    freshEnv[key] = value.toString();
  });

  return toProcessEnv(freshEnv);
}

/**
 * Load environment variables on Unix/Mac using shell
 */
async function loadUnixEnvironment(
  customShellPath?: string
): Promise<NodeJS.ProcessEnv> {
  const shellPath = customShellPath || process.env.SHELL || '/bin/sh';

  // Arguments to load a login, interactive shell and dump environment
  const args = [
    '-ilc',
    'echo -n "_SHELL_ENV_DELIMITER_"; env; echo -n "_SHELL_ENV_DELIMITER_"; exit',
  ];

  // Environment variables to disable shell features that might block
  const shellEnv = {
    ...process.env,
    DISABLE_AUTO_UPDATE: 'true', // Disables Oh My Zsh auto-update prompt that can block the process
  };

  // Spawn shell process
  const shell = spawn(shellPath, args, { env: shellEnv });

  // Collect stdout
  let stdout = '';
  shell.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  // Wait for process to complete, handling spawn errors (e.g. ENOENT).
  const exitCode = await new Promise<number>((resolve, reject) => {
    shell.on('error', (err) => reject(err));
    shell.on('close', (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new MetaError('Shell exited with non-zero code:', { exitCode });
  }

  // Parse the environment output
  return parseEnvOutput(stdout);
}

/**
 * Loads environment variables from the user's shell.
 *
 * @param shellPath Optional custom shell path for Unix systems
 * @returns Promise resolving to environment variables (falls back to process.env on error)
 */
export async function loadShellEnvironment(
  shellPath?: string
): Promise<NodeJS.ProcessEnv> {
  try {
    // Platform-specific implementation
    let env: NodeJS.ProcessEnv;

    if (process.platform === 'win32') {
      env = await loadWindowsEnvironment();
    } else {
      env = await loadUnixEnvironment(shellPath);
    }

    return env;
  } catch (err) {
    logWarn('Failed to load shell environment, falling back to process.env', {
      cause: err,
    });
    return process.env;
  }
}
