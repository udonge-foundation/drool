import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import path from 'path';

import { logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import {
  AGENT_BROWSER_BINARY_SHA256,
  AGENT_BROWSER_EMBEDDED_FILES,
} from '@/generated/agent-browser/assets';

const VERSION_CHECK_TIMEOUT_MS = 10_000;

function getIndustryDir(): string {
  return path.join(getIndustryHome(), getIndustryDirName());
}

export function getAgentBrowserSkillDataDir(): string {
  const industryDir = getIndustryDir();
  return path.join(industryDir, 'tools', 'agent-browser', 'skill-data');
}

export async function ensureAgentBrowserInstalled(): Promise<{
  commandPath: string;
  binaryPath: string;
}> {
  const industryDir = getIndustryDir();
  const binDir = path.join(industryDir, 'bin');
  const toolDir = path.join(industryDir, 'tools', 'agent-browser');

  const binaryName =
    process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser';
  const binaryPath = path.join(binDir, binaryName);

  // Check if binary needs extraction by comparing SHA against build-time constant.
  const skillDataDir = path.join(toolDir, 'skill-data');
  let needsExtraction = !existsSync(binaryPath) || !existsSync(skillDataDir);
  if (!needsExtraction) {
    const onDiskSha = createHash('sha256')
      .update(readFileSync(binaryPath))
      .digest('hex');
    needsExtraction = onDiskSha !== AGENT_BROWSER_BINARY_SHA256;
  }

  if (needsExtraction) {
    const lockPath = path.join(toolDir, '.extracting.lock');
    try {
      mkdirSync(toolDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });

      // Atomic lock: writeFileSync with 'wx' flag fails if file exists
      try {
        writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      } catch {
        // Another process is extracting; wait briefly and assume it completes
        logInfo('[agent-browser] Waiting for another process to extract...');
        const sleep = (ms: number) =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
          });
        const start = Date.now();
        while (existsSync(lockPath) && Date.now() - start < 30000) {
          await sleep(100);
        }
        if (!existsSync(binaryPath) || !existsSync(skillDataDir)) {
          throw new Error(
            'agent-browser extraction by another process did not complete successfully'
          );
        }
        return { commandPath: binaryPath, binaryPath };
      }

      for (const f of AGENT_BROWSER_EMBEDDED_FILES) {
        let finalPath: string;
        if (f.outputName === 'agent-browser') {
          finalPath = binaryPath;
        } else {
          // skill-data files go under tools/agent-browser/
          finalPath = path.join(toolDir, f.outputName);
        }

        mkdirSync(path.dirname(finalPath), { recursive: true });

        // On Windows, writing over an existing file can fail
        if (process.platform === 'win32' && existsSync(finalPath)) {
          rmSync(finalPath, { force: true });
        }

        writeFileSync(finalPath, readFileSync(f.embeddedPath));

        if (process.platform !== 'win32') {
          const mode = 'mode' in f ? f.mode : 0o644;
          chmodSync(finalPath, mode);
        }
      }

      // Clean up stale directories from older versions
      const staleBinDir = path.join(toolDir, 'bin');
      if (existsSync(staleBinDir)) {
        rmSync(staleBinDir, { recursive: true, force: true });
      }
      const staleDistDir = path.join(toolDir, 'dist');
      if (existsSync(staleDistDir)) {
        rmSync(staleDistDir, { recursive: true, force: true });
      }
      const staleShaFile = path.join(toolDir, '.agent-browser-sha256.json');
      if (existsSync(staleShaFile)) {
        rmSync(staleShaFile, { force: true });
      }

      logInfo('[agent-browser] Extracted embedded agent-browser');
    } catch (error) {
      logWarn('[agent-browser] Failed to extract embedded files', {
        cause: error,
      });
      throw error;
    } finally {
      try {
        rmSync(lockPath, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  return { commandPath: binaryPath, binaryPath };
}

export async function ensureAgentBrowserAvailable(): Promise<{
  commandPath: string;
  version?: string;
}> {
  const { binaryPath } = await ensureAgentBrowserInstalled();
  const result = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: VERSION_CHECK_TIMEOUT_MS,
  });

  if (result.error) {
    const message = [
      'agent-browser availability check failed',
      result.error.message,
    ].join(': ');
    throw new MetaError(message, {
      path: binaryPath,
      errorMessage: result.error.message,
    });
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const message = [
      'agent-browser availability check failed',
      `exit code ${result.status ?? 'unknown'}`,
      stderr,
    ]
      .filter(Boolean)
      .join(': ');
    throw new MetaError(message, {
      path: binaryPath,
      exitCode: result.status ?? undefined,
      stderr,
    });
  }

  const versionOutput = result.stdout?.trim() || result.stderr?.trim();
  const version = versionOutput?.split(/\r?\n/)[0];
  logInfo('[agent-browser] Availability check passed', {
    path: binaryPath,
    version,
  });

  return { commandPath: binaryPath, version };
}
