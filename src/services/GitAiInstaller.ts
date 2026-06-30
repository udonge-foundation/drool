import { exec, execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import shellQuote from 'shell-quote';
import { z } from 'zod';

import { IndustryEnv } from '@industry/environment';
import { MetaError } from '@industry/logging/errors';
import { resolveDroolBinary } from '@industry/utils/cli';
import { findGitRoot } from '@industry/utils/shell/node';

import { getEnv, getRuntimeAuthConfig } from '@/environment';
import {
  DROOL_GIT_AI_CHECKPOINT_HOOK_MARKER,
  GIT_AI_VERSION,
} from '@/services/constants';
import { isDroolGitAiCheckpointHookCommand as isDroolGitAiCheckpointHookCommandImpl } from '@/utils/gitAiHookCommand';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const GIT_AI_RELEASE_BASE = `https://github.com/git-ai-project/git-ai/releases/download/v${GIT_AI_VERSION}`;
const GIT_AI_FETCH_TIMEOUT_MS = 30_000;

export function getExpectedBinaryPath(): string {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(os.homedir(), '.git-ai', 'bin', `git-ai${ext}`);
}

export async function getGitAiBinaryPath(): Promise<string | null> {
  const expectedPath = getExpectedBinaryPath();
  if (fs.existsSync(expectedPath)) {
    return expectedPath;
  }
  try {
    const cmd = process.platform === 'win32' ? 'where git-ai' : 'which git-ai';
    const { stdout } = await execAsync(cmd, { timeout: 5_000 });
    const resolved = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (resolved && fs.existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // not in PATH
  }
  return null;
}

export async function getGitAiVersion(
  binOverride?: string
): Promise<string | null> {
  const bin = binOverride ?? (await getGitAiBinaryPath());
  if (!bin) return null;
  try {
    const { stdout } = await execFileAsync(bin, ['version'], {
      timeout: 10_000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export function parseVersion(versionOutput: string): string | null {
  const match = versionOutput.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function getInstallCommand(): string {
  const installCmdUnix = `curl -fsSL ${GIT_AI_RELEASE_BASE}/install.sh | bash`;
  const installCmdWindows = `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://github.com/git-ai-project/git-ai/releases/download/v${GIT_AI_VERSION}/install.ps1 | iex"`;
  return process.platform === 'win32' ? installCmdWindows : installCmdUnix;
}

export { getInstallCommand };

function sha256(content: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function quoteHookCommand(args: string[]): string {
  if (process.platform === 'win32') {
    return args
      .map((arg) =>
        /^[A-Za-z0-9_./:\\-]+$/.test(arg) ? arg : JSON.stringify(arg)
      )
      .join(' ');
  }

  return shellQuote.quote(args);
}

async function fetchReleaseAsset(url: string): Promise<Buffer> {
  if (getRuntimeAuthConfig().airgapEnabled) {
    throw new MetaError(
      'Git AI release download blocked: Airgap Mode is enabled',
      { value: { url } }
    );
  }
  // Single signal bounds both the request and the body read: aborting it
  // also aborts the response stream, so arrayBuffer() inherits the timeout.
  const signal = AbortSignal.timeout(GIT_AI_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await globalThis.fetch(url, { signal });
  } catch (error) {
    throw new MetaError('Failed to fetch Git AI release asset', {
      cause: error,
      value: { url, timeoutMs: GIT_AI_FETCH_TIMEOUT_MS },
    });
  }
  if (!response.ok) {
    throw new MetaError('Failed to fetch Git AI release asset', {
      value: {
        url,
        status: response.status,
        statusText: response.statusText,
      },
    });
  }
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new MetaError('Failed to read Git AI release asset body', {
      cause: error,
      value: { url, timeoutMs: GIT_AI_FETCH_TIMEOUT_MS },
    });
  }
}

export function resolveDroolBinaryForGitAiHook(isDevelopment: boolean): string {
  const invokedBinary = process.argv[0];
  if (
    invokedBinary &&
    path.basename(invokedBinary).includes('drool') &&
    fs.existsSync(invokedBinary)
  ) {
    return invokedBinary;
  }

  return resolveDroolBinary(isDevelopment);
}

export function getDroolCheckpointHookCommand(gitAiBinary: string): string {
  const droolBinary = resolveDroolBinaryForGitAiHook(
    getEnv().env === IndustryEnv.Development
  );
  const command = quoteHookCommand([
    droolBinary,
    'git-ai-checkpoint-hook',
    '--git-ai-bin',
    gitAiBinary,
  ]);
  return process.platform === 'win32'
    ? `set ${DROOL_GIT_AI_CHECKPOINT_HOOK_MARKER}&& ${command}`
    : `${DROOL_GIT_AI_CHECKPOINT_HOOK_MARKER} ${command}`;
}

export function isDroolGitAiCheckpointHookCommand(command: string): boolean {
  return (
    command.includes(DROOL_GIT_AI_CHECKPOINT_HOOK_MARKER) ||
    isDroolGitAiCheckpointHookCommandImpl(command)
  );
}

async function fetchVerifiedInstallScript(): Promise<{
  success: boolean;
  scriptName?: string;
  script?: Buffer;
  error?: string;
}> {
  const scriptName =
    process.platform === 'win32' ? 'install.ps1' : 'install.sh';
  const scriptUrl = `${GIT_AI_RELEASE_BASE}/${scriptName}`;
  const checksumUrl = `${GIT_AI_RELEASE_BASE}/SHA256SUMS`;
  try {
    const [script, sumsFileBytes] = await Promise.all([
      fetchReleaseAsset(scriptUrl),
      fetchReleaseAsset(checksumUrl),
    ]);
    const sumsFile = sumsFileBytes.toString('utf8');
    const line = sumsFile
      .trim()
      .split('\n')
      .find((l) => l.trim().endsWith(scriptName));
    const expected = line?.trim().split(/\s+/)[0]?.toLowerCase();
    const actual = sha256(script).toLowerCase();
    if (!expected || expected !== actual) {
      return {
        success: false,
        error: `Checksum mismatch for ${scriptName} (expected ${expected ?? 'missing'}, got ${actual})`,
      };
    }
    return { success: true, scriptName, script };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runVerifiedInstallScript(
  scriptName: string,
  script: Buffer
): Promise<void> {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'git-ai-install-')
  );
  const scriptPath = path.join(tempDir, scriptName);

  try {
    await fs.promises.writeFile(scriptPath, script, { mode: 0o700 });
    if (process.platform === 'win32') {
      await execFileAsync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { timeout: 120_000 }
      );
    } else {
      await execFileAsync('bash', [scriptPath], { timeout: 120_000 });
    }
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

export async function installGitAi(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const verifiedScript = await fetchVerifiedInstallScript();
    if (
      !verifiedScript.success ||
      !verifiedScript.scriptName ||
      !verifiedScript.script
    ) {
      return { success: false, error: verifiedScript.error };
    }
    await runVerifiedInstallScript(
      verifiedScript.scriptName,
      verifiedScript.script
    );
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function installGitAiGithubCi(gitRoot?: string): Promise<{
  success: boolean;
  skipped?: boolean;
  output?: string;
  error?: string;
}> {
  const bin = await getGitAiBinaryPath();
  if (!bin) return { success: false, error: 'git-ai binary not found' };
  try {
    const root = gitRoot ?? findGitRoot();
    if (!root) {
      return { success: false, error: 'Not in a git repository' };
    }

    const workflowPath = path.join(root, '.github/workflows/git-ai.yaml');

    if (fs.existsSync(workflowPath)) {
      return {
        success: true,
        skipped: true,
        output: 'Workflow file already exists, skipping installation',
      };
    }

    const { stdout } = await execFileAsync(bin, ['ci', 'github', 'install'], {
      cwd: root,
      timeout: 30_000,
    });
    return { success: true, output: stdout.trim() };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function disableAutoUpdates(
  cwd?: string,
  binOverride?: string
): Promise<{
  success: boolean;
  error?: string;
}> {
  const bin = binOverride ?? (await getGitAiBinaryPath());
  if (!bin) return { success: false, error: 'git-ai binary not found' };
  try {
    await execFileAsync(
      bin,
      ['config', 'set', 'disable_auto_updates', 'true'],
      {
        cwd,
        timeout: 10_000,
      }
    );
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function disableVersionChecks(
  cwd?: string,
  binOverride?: string
): Promise<{
  success: boolean;
  error?: string;
}> {
  const bin = binOverride ?? (await getGitAiBinaryPath());
  if (!bin) return { success: false, error: 'git-ai binary not found' };
  try {
    await execFileAsync(
      bin,
      ['config', 'set', 'disable_version_checks', 'true'],
      {
        cwd,
        timeout: 10_000,
      }
    );
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function configureGitAiHooks(
  cwd?: string,
  binOverride?: string
): Promise<{
  success: boolean;
  error?: string;
}> {
  const bin = binOverride ?? (await getGitAiBinaryPath());
  if (!bin) return { success: false, error: 'git-ai binary not found' };
  try {
    const binary = resolveDroolBinaryForGitAiHook(
      getEnv().env === IndustryEnv.Development
    );
    const hookCommand = quoteHookCommand([binary, 'push-git-ai-notes']);
    await execFileAsync(
      bin,
      ['config', 'set', 'git_ai_hooks.post_notes_updated', hookCommand],
      { cwd, timeout: 10_000 }
    );
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runGitAiInstall(
  cwd?: string,
  binOverride?: string
): Promise<{
  success: boolean;
  output?: string;
  error?: string;
}> {
  const bin = binOverride ?? (await getGitAiBinaryPath());
  if (!bin) return { success: false, error: 'git-ai binary not found' };
  try {
    const { stdout } = await execFileAsync(bin, ['install'], {
      cwd: cwd ?? process.cwd(),
      timeout: 30_000,
    });
    return { success: true, output: stdout.trim() };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const DaemonStatusSchema = z.object({
  ok: z.boolean().optional(),
  message: z.string().optional(),
});

export async function getDaemonStatus(): Promise<{
  success: boolean;
  error?: string;
}> {
  const bin = await getGitAiBinaryPath();
  if (!bin) return { success: false, error: 'git-ai binary not found' };
  try {
    const { stdout } = await execFileAsync(bin, ['d', 'status'], {
      timeout: 10_000,
    });
    try {
      const json = JSON.parse(stdout.trim());
      const parsed = DaemonStatusSchema.safeParse(json);
      if (parsed.success) {
        if (parsed.data.ok) {
          return { success: true };
        }
        return {
          success: false,
          error: parsed.data.message ?? 'daemon reported status not ok',
        };
      }
      return { success: false, error: 'Invalid daemon status response format' };
    } catch {
      return {
        success: false,
        error: 'Failed to parse daemon status response',
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
