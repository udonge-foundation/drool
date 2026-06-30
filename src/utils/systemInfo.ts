import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ExecuteCliRuntimeShell } from '@industry/drool-core/tools/definitions/cli/enums';
import {
  SYSTEM_REMINDER_END,
  SYSTEM_REMINDER_START,
} from '@industry/drool-sdk-ext/protocol/drool';
import { SessionOrigin } from '@industry/drool-sdk-ext/protocol/session';
import { promisePool } from '@industry/utils/promise';

import { DEFAULT_LOCALE } from '@/i18n/constants';
import { getI18n } from '@/i18n/index';
import {
  isMissionOrchestratorSession,
  isMissionWorkerSession,
} from '@/services/mission/sessionTags';
import { getAgentContextDirNames } from '@/utils/industryPaths';
import {
  getGuidelinesInfo,
  getDesignGuidelinesInfo,
} from '@/utils/getGuidelinesInfo';
import { getRuntimeShell } from '@/utils/runtimeShell';
import { truncateCommandOutput } from '@/utils/truncate';
import type {
  CommandBlock,
  ResumeSystemInfo,
  RuntimeShell,
  SystemInfo,
} from '@/utils/types';

import type { SessionTag } from '@industry/drool-sdk-ext/protocol/session';
import type { ExecOptions } from 'child_process';

/**
 * Render a one-line shell hint for the system reminder. Returns empty
 * string for runtimes where bash/zsh is the model's default prior
 * (POSIX, unknown) — no need to add noise to the prompt.
 */
function renderShellHint(shell: RuntimeShell): string {
  switch (shell.kind) {
    case ExecuteCliRuntimeShell.PowerShell5:
      return 'Shell: Windows PowerShell 5.1 (legacy — does NOT support && or ||; use ; and $LASTEXITCODE)';
    case ExecuteCliRuntimeShell.PowerShell7:
      return 'Shell: PowerShell 7+ (modern — && and || work; cmdlet syntax otherwise)';
    case ExecuteCliRuntimeShell.WslBash: {
      const distroSuffix = shell.distro
        ? ` (${shell.distro.replace(/[\r\n]/g, ' ')})`
        : '';
      return `Shell: bash inside ${shell.variant}${distroSuffix} — real Linux on a Windows host; /mnt/c bridges to Windows files but is slow; CRLF-line-ending hazards for shared scripts`;
    }
    case ExecuteCliRuntimeShell.Posix:
    case ExecuteCliRuntimeShell.Unknown:
    default:
      return '';
  }
}

const TIMEOUT_SHORT_MS = 1000;
const TIMEOUT_LONG_MS = 2000;

/**
 * Resolve the user's language preference for the system-reminder block.
 *
 * Reads the live i18n instance's active language so we pick up:
 *   - explicit /language slash command setting (persisted to settings.general.locale)
 *   - LC_ALL / LC_MESSAGES / LANG env-var detection at startup
 *   - default English fallback
 *
 * Defensive against being called before i18n is initialized (the system-info
 * prefetch races against initI18n() in main.tsx).
 */
function getUserLanguage(): string {
  // getI18n() throws if initI18n() hasn't run yet (the system-info prefetch
  // races against initI18n() in main.tsx, and resume-from-session paths may
  // call this before TUI bootstrap). Fall back to DEFAULT_LOCALE in that case
  // — the live language already encodes config-override > env-var > default
  // precedence once initialized.
  try {
    const lang = getI18n().language;
    if (typeof lang === 'string' && lang.length > 0) return lang;
  } catch {
    // i18n not initialized — fall through to default
  }
  return DEFAULT_LOCALE;
}

function isPersonalGuidelineBlock(block: CommandBlock): boolean {
  return getAgentContextDirNames().some((dirName) =>
    block.cmd.includes(`~/${dirName}/`)
  );
}

/**
 * Get today's date in YYYY-MM-DD format using local timezone.
 * Unlike toISOString() which returns UTC, this uses local date components.
 */
function getLocalDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
}

interface StartupSystemInfoPrefetch {
  cwd: string;
  promise: Promise<SystemInfo>;
}

let startupSystemInfoPrefetch: StartupSystemInfoPrefetch | null = null;

/**
 * Execute a shell command and return a result object.
 * Never throws - callers check `result.ok` to determine success.
 * On failure, stdout/stderr are still available (extracted from the error object).
 */
function execAsync(
  cmd: string,
  options: ExecOptions = {}
): Promise<ExecResult> {
  const normalize = (v: unknown): string =>
    typeof v === 'string' ? v : Buffer.isBuffer(v) ? v.toString('utf8') : '';

  return new Promise((resolve) => {
    exec(
      cmd,
      { encoding: 'utf8', timeout: TIMEOUT_SHORT_MS, ...options },
      (err, stdout, stderr) => {
        if (err) {
          const execErr = err as Error & {
            code?: number;
            killed?: boolean;
          };
          resolve({
            ok: false,
            stdout: normalize(stdout).trim(),
            stderr: normalize(stderr).trim(),
            code: execErr.code ?? null,
            killed: execErr.killed ?? false,
          });
        } else {
          resolve({
            ok: true,
            stdout: normalize(stdout).trim(),
            stderr: normalize(stderr).trim(),
            code: 0,
            killed: false,
          });
        }
      }
    );
  });
}

function getOSName(): string {
  return `${os.platform()} ${os.release()}`;
}

async function getDirectoryInfo(
  currentFolder: string
): Promise<CommandBlock[]> {
  const blocks: CommandBlock[] = [{ cmd: 'pwd', out: currentFolder }];
  const cmd = 'ls';
  // On Windows, use fs.readdir directly (no `ls` binary available).
  if (process.platform === 'win32') {
    try {
      const files = await fs.promises.readdir(currentFolder);
      blocks.push({ cmd, out: truncateCommandOutput(files.join('\n')) });
    } catch {
      blocks.push({ cmd, out: 'Unable to list directory contents' });
    }
    return blocks;
  }
  const result = await execAsync(cmd, {
    cwd: currentFolder,
    timeout: TIMEOUT_LONG_MS,
  });
  if (result.ok) {
    blocks.push({ cmd, out: truncateCommandOutput(result.stdout) });
  } else {
    try {
      const files = await fs.promises.readdir(currentFolder);
      blocks.push({ cmd, out: truncateCommandOutput(files.join('\n')) });
    } catch {
      blocks.push({ cmd, out: 'Unable to list directory contents' });
    }
  }
  return blocks;
}

/**
 * Walk up from `start` looking for a `.git` entry. Returns both the
 * worktree-specific `gitDir` and the repository's `commonDir` (they
 * differ for linked worktrees, where `packed-refs` lives in the
 * repository's main `.git` rather than the worktree's gitdir). Returns
 * null when not inside a repo.
 */
async function findGitDirs(
  start: string
): Promise<{ gitDir: string; commonDir: string } | null> {
  let current = path.resolve(start);
  let gitDir: string | null = null;
  while (true) {
    const candidate = path.join(current, '.git');
    try {
      const stat = await fs.promises.stat(candidate);
      if (stat.isDirectory()) {
        gitDir = candidate;
        break;
      }
      if (stat.isFile()) {
        const contents = await fs.promises.readFile(candidate, 'utf8');
        const match = contents.match(/^gitdir:\s*(.+)\s*$/m);
        if (match) {
          const target = match[1]!.trim();
          gitDir = path.isAbsolute(target)
            ? target
            : path.resolve(current, target);
          break;
        }
      }
    } catch {
      // not here
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }

  let commonDir = gitDir;
  try {
    const cd = (
      await fs.promises.readFile(path.join(gitDir, 'commondir'), 'utf8')
    ).trim();
    if (cd) {
      commonDir = path.isAbsolute(cd) ? cd : path.resolve(gitDir, cd);
    }
  } catch {
    // not a linked worktree
  }
  return { gitDir, commonDir };
}

/**
 * Windows-only fast path: read branch + default-branch directly from the
 * `.git` directory, no subprocess. Skips dirty status and recent log
 * (each git spawn is 1-2 s of AV scan on Windows). Total cost ~5 ms.
 */
async function getGitInfoFromFs(cwd: string): Promise<CommandBlock[]> {
  const branchLabel = 'git status -b --porcelain | head -n1';
  const remotesCmd = 'git symbolic-ref refs/remotes/origin/HEAD';

  const dirs = await findGitDirs(cwd);
  if (!dirs) {
    return [{ cmd: branchLabel, out: 'not a git repository' }];
  }
  const { gitDir, commonDir } = dirs;

  const [headRaw, remoteHeadRaw, packedRaw] = await Promise.all([
    fs.promises.readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => null),
    fs.promises
      .readFile(
        path.join(commonDir, 'refs', 'remotes', 'origin', 'HEAD'),
        'utf8'
      )
      .catch(() => null),
    fs.promises
      .readFile(path.join(commonDir, 'packed-refs'), 'utf8')
      .catch(() => null),
  ]);

  const blocks: CommandBlock[] = [];

  let branchName = 'HEAD';
  if (headRaw) {
    const refMatch = headRaw.trim().match(/^ref:\s*refs\/heads\/(.+)$/);
    if (refMatch) branchName = refMatch[1]!.trim();
  }
  blocks.push({ cmd: branchLabel, out: branchName });

  if (remoteHeadRaw) {
    const refMatch = remoteHeadRaw
      .trim()
      .match(/^ref:\s*(refs\/remotes\/origin\/.+)$/);
    if (refMatch) {
      blocks.push({ cmd: remotesCmd, out: refMatch[1]! });
      return blocks;
    }
  }

  if (packedRaw) {
    const refMatch = packedRaw.match(/refs\/remotes\/origin\/(\w[\w./-]*)/);
    if (refMatch) {
      blocks.push({
        cmd: remotesCmd,
        out: `refs/remotes/origin/${refMatch[1]!}`,
      });
    }
  }

  return blocks;
}

async function getGitInfo(cwd: string): Promise<CommandBlock[]> {
  if (process.platform === 'win32') {
    return getGitInfoFromFs(cwd);
  }

  const branchLabel = 'git status -b --porcelain | head -n1';
  const statusBranchCmd = 'git status -bs --porcelain';
  const logCmd = 'git log --oneline -5';
  const remotesCmd = 'git symbolic-ref refs/remotes/origin/HEAD';

  const [statusBranchResult, logResult, remotesResult] = await Promise.all([
    execAsync(statusBranchCmd, { cwd, timeout: TIMEOUT_LONG_MS }),
    execAsync(logCmd, { cwd, timeout: TIMEOUT_LONG_MS }),
    execAsync(remotesCmd, { cwd, timeout: TIMEOUT_LONG_MS }),
  ]);

  if (!statusBranchResult.ok) {
    const errorOutput =
      statusBranchResult.stderr || statusBranchResult.stdout || '';
    if (errorOutput) return [{ cmd: branchLabel, out: errorOutput }];
    if (statusBranchResult.killed)
      return [{ cmd: branchLabel, out: 'git command timed out' }];
    return [{ cmd: 'git --version', out: 'git not found' }];
  }

  // Extract branch from "## branch...origin/branch" first line. Allow dots
  // in branch names (`feat.v2`) and detached-HEAD output (`## HEAD (no
  // branch)`).
  const statusOutput = statusBranchResult.stdout;
  const branchMatch = statusOutput.match(/^##\s+(.+?)(?:\.\.\.|$)/m);
  const rawBranch = branchMatch ? branchMatch[1]!.trim() : 'HEAD';
  const branchName = rawBranch.startsWith('HEAD ') ? 'HEAD' : rawBranch;
  const restOfStatus = statusOutput.replace(/^##.*\r?\n?/, '');

  const blocks: CommandBlock[] = [{ cmd: branchLabel, out: branchName }];

  const statusCmd = 'git status --porcelain';
  blocks.push({ cmd: statusCmd, out: truncateCommandOutput(restOfStatus) });

  if (logResult.ok) {
    blocks.push({ cmd: logCmd, out: logResult.stdout });
  } else {
    blocks.push({ cmd: logCmd, out: 'No commits' });
  }

  if (remotesResult.ok) {
    const remoteBranch = remotesResult.stdout;
    const match = remoteBranch.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match) {
      blocks.push({ cmd: remotesCmd, out: remoteBranch });
      return blocks;
    }
  }

  const mainCmd = 'git show-ref --verify --quiet refs/heads/main';
  const mainResult = await execAsync(mainCmd, {
    cwd,
    timeout: TIMEOUT_LONG_MS,
  });
  if (mainResult.ok) {
    const defaultIsMain = 'Default branch is main';
    blocks.push({
      cmd: `${mainCmd} && echo "${defaultIsMain}"`,
      out: defaultIsMain,
    });
    return blocks;
  }

  const masterCmd = 'git show-ref --verify --quiet refs/heads/master';
  const masterResult = await execAsync(masterCmd, {
    cwd,
    timeout: TIMEOUT_LONG_MS,
  });
  if (masterResult.ok) {
    const defaultIsMaster = 'Default branch is master';
    blocks.push({
      cmd: `${masterCmd} && echo "${defaultIsMaster}"`,
      out: defaultIsMaster,
    });
  }

  return blocks;
}

function renderBlocks(blocks: CommandBlock[] | undefined): string {
  if (!blocks || blocks.length === 0) return '';
  return `${blocks.map((block) => `% ${block.cmd}\n${block.out}`).join('\n\n')}\n`;
}

/**
 * Checks if SystemInfo has the expected new format structure.
 * Returns false for legacy formats or corrupted data.
 */
export function isValidSystemInfo(systemInfo: unknown): boolean {
  if (!systemInfo || typeof systemInfo !== 'object') {
    return false;
  }

  const info = systemInfo as Record<string, unknown>;

  // Check that it has the new array-based structure
  // Valid if at least one of the new fields exists as an array
  const hasNewStructure =
    Array.isArray(info.directoryInfo) ||
    Array.isArray(info.gitInfo) ||
    Array.isArray(info.guidelinesInfo) ||
    Array.isArray(info.designGuidelinesInfo);

  return hasNewStructure;
}

/**
 * Render the surface-specific hint describing how the user enters a mission.
 * Returns an empty string inside mission sessions and for surfaces with no
 * interactive mission entry point (headless CLI, delegations, unknown origin).
 */
function renderMissionHint(
  isInsideMission: boolean,
  sessionOrigin?: SessionOrigin
): string {
  if (isInsideMission) return '';
  switch (sessionOrigin) {
    case SessionOrigin.CliTui:
      return '\n- To enter a mission, the user needs to run the `/missions` slash command.';
    case SessionOrigin.Desktop:
    case SessionOrigin.Web:
      return '\n- To enter a mission, open Mission Control, or select Mission mode from the mode dropdown in the chat input.';
    default:
      return '';
  }
}

export function formatSystemReminder(
  systemInfo: SystemInfo,
  modelName?: string,
  sessionTags?: SessionTag[],
  sessionOrigin?: SessionOrigin
): string {
  const guidelines = systemInfo.guidelinesInfo ?? [];
  const designGuidelines = systemInfo.designGuidelinesInfo ?? [];
  const hasGuidelines = guidelines.length > 0 || designGuidelines.length > 0;

  // Split guidelines into project and personal
  const projectGuidelines: CommandBlock[] = [];
  const personalGuidelines: CommandBlock[] = [];

  for (const block of guidelines) {
    if (isPersonalGuidelineBlock(block)) {
      personalGuidelines.push(block);
    } else {
      projectGuidelines.push(block);
    }
  }

  // Split design guidelines into project and personal
  const projectDesignGuidelines: CommandBlock[] = [];
  const personalDesignGuidelines: CommandBlock[] = [];

  for (const block of designGuidelines) {
    if (isPersonalGuidelineBlock(block)) {
      personalDesignGuidelines.push(block);
    } else {
      projectDesignGuidelines.push(block);
    }
  }

  // Build guidelines sections
  const guidelinesHeader = hasGuidelines
    ? '# Codebase and user instructions are shown below. Instructions from files closest to your current directory take precedence over those further up the hierarchy.'
    : '';
  const projectSection =
    projectGuidelines.length > 0 || projectDesignGuidelines.length > 0
      ? `## Project Instructions:\n${renderBlocks(projectGuidelines)}${renderBlocks(projectDesignGuidelines)}`
      : '';
  const personalSection =
    personalGuidelines.length > 0 || personalDesignGuidelines.length > 0
      ? `## Personal Global Instructions:\n${renderBlocks(personalGuidelines)}${renderBlocks(personalDesignGuidelines)}`
      : '';

  const today = getLocalDateString();
  const shellHint = renderShellHint(getRuntimeShell());
  const userLanguage = getUserLanguage();

  // Suppress the `/missions` hint inside mission sessions: orchestrators
  // and workers are already past that boundary, and the contradictory hint
  // confuses orchestrators into telling the user to run `/missions` (or
  // skipping `propose_mission`) instead of using their real mission tools.
  const isInsideMission =
    isMissionOrchestratorSession(sessionTags) ||
    isMissionWorkerSession(sessionTags);
  const missionHint = renderMissionHint(isInsideMission, sessionOrigin);

  return `${SYSTEM_REMINDER_START}

User system info (${systemInfo.osName})
${shellHint}
${modelName ? `Model: ${modelName}` : ''}
Today's date: ${today}
User language: ${userLanguage}

# The commands below were executed at the start of all sessions to gather context about the environment.
# You do not need to repeat them, unless you think the environment has changed.
# Remember: They are not necessarily related to the current conversation, but may be useful for context.

${renderBlocks(systemInfo.directoryInfo)}
${renderBlocks(systemInfo.gitInfo)}
${guidelinesHeader}
${projectSection}
${personalSection}

IMPORTANT:
- Double check the tools installed in the environment before using them.
- Never call a file editing tool for the same file in parallel.
- Always prefer the Grep, Glob and LS tools over shell commands like find, grep, or ls for codebase exploration.
- Always prefer using the absolute paths when using tools, to avoid any ambiguity.${missionHint}

${SYSTEM_REMINDER_END}`;
}

/**
 * Gather reduced system info for session resume.
 * Only fetches date, directory, and git info - skips tool versions, guidelines, etc.
 */
export async function getResumeSystemInfo(): Promise<ResumeSystemInfo> {
  const currentFolder = process.cwd();

  const tasks = [
    () => getDirectoryInfo(currentFolder),
    () => getGitInfo(currentFolder),
  ];

  const {
    results: [directoryInfo, gitInfo],
  } = await promisePool<CommandBlock[]>(tasks, 2, {
    throwErrors: false,
  });

  return {
    osName: getOSName(),
    directoryInfo: directoryInfo || [],
    gitInfo: gitInfo || [],
  };
}

/**
 * Format a reduced system reminder for session resume.
 * Contains only essential updated context: date, directory, and git status.
 */
export function formatResumeSystemReminder(
  systemInfo: ResumeSystemInfo,
  modelName?: string
): string {
  const today = getLocalDateString();
  const shellHint = renderShellHint(getRuntimeShell());

  return `${SYSTEM_REMINDER_START}
User system info (${systemInfo.osName})
${shellHint}
${modelName ? `Model: ${modelName}` : ''}
Today's date: ${today}

${renderBlocks(systemInfo.directoryInfo)}
${renderBlocks(systemInfo.gitInfo)}
${SYSTEM_REMINDER_END}`;
}

function clearSystemInfoPrefetch(
  prefetched?: StartupSystemInfoPrefetch | null
): void {
  if (!prefetched || startupSystemInfoPrefetch === prefetched) {
    startupSystemInfoPrefetch = null;
  }
}

function getSystemInfoPrefetch(
  currentFolder: string
): StartupSystemInfoPrefetch | null {
  const prefetched = startupSystemInfoPrefetch;
  if (!prefetched) {
    return null;
  }

  if (prefetched.cwd !== currentFolder) {
    clearSystemInfoPrefetch(prefetched);
    return null;
  }

  return prefetched;
}

async function collectSystemInfo(currentFolder: string): Promise<SystemInfo> {
  const tasks = [
    () => getDirectoryInfo(currentFolder),
    () => getGitInfo(currentFolder),
    () => getGuidelinesInfo(currentFolder),
    () => getDesignGuidelinesInfo(currentFolder),
  ];

  const {
    results: [directoryInfo, gitInfo, guidelinesInfo, designGuidelinesInfo],
  } = await promisePool<CommandBlock[]>(tasks, tasks.length, {
    throwErrors: false,
  });

  return {
    osName: getOSName(),
    directoryInfo: directoryInfo || [],
    gitInfo: gitInfo || [],
    guidelinesInfo: guidelinesInfo || [],
    designGuidelinesInfo: designGuidelinesInfo || [],
  };
}

function createSystemInfoPrefetch(
  currentFolder: string,
  promise: Promise<SystemInfo>
): StartupSystemInfoPrefetch {
  const prefetched: StartupSystemInfoPrefetch = {
    cwd: currentFolder,
    promise: promise.catch(() => {
      clearSystemInfoPrefetch(prefetched);
      return collectSystemInfo(currentFolder);
    }),
  };

  return prefetched;
}

export function prefetchSystemInfo(): Promise<SystemInfo> {
  const currentFolder = process.cwd();
  const prefetched = getSystemInfoPrefetch(currentFolder);
  if (prefetched) {
    return prefetched.promise;
  }

  // Yield to let React paint before spawning child processes.
  const deferred = new Promise<void>((r) => {
    setImmediate(r);
  }).then(() => collectSystemInfo(currentFolder));

  const nextPrefetch = createSystemInfoPrefetch(currentFolder, deferred);
  startupSystemInfoPrefetch = nextPrefetch;

  return nextPrefetch.promise;
}

export function restartSystemInfoPrefetch(): Promise<SystemInfo> {
  clearSystemInfoPrefetch();
  return prefetchSystemInfo();
}

/**
 * Get system info. By default returns the prefetched value when
 * available (same cwd), otherwise collects fresh.
 *
 * Pass `{ forceRefresh: true }` to bypass the cache. Use this only
 * when you need a fresh snapshot AFTER work that may have changed
 * git state / cwd contents (e.g. compaction, provider switch).
 *
 * Historically this function ALWAYS bypassed the cache, which meant
 * callers could re-run the full collection (~520ms on AV-scanned
 * Windows) in latency-sensitive paths.
 */
export async function getSystemInfo(
  options: { forceRefresh?: boolean } = {}
): Promise<SystemInfo> {
  const cwd = process.cwd();
  if (!options.forceRefresh) {
    const prefetched = getSystemInfoPrefetch(cwd);
    if (prefetched) return prefetched.promise;
  }
  return collectSystemInfo(cwd);
}

export function _resetSystemInfoPrefetchForTesting(): void {
  startupSystemInfoPrefetch = null;
}

export function _seedSystemInfoPrefetchForTesting(
  promise: Promise<SystemInfo>,
  cwd: string = process.cwd()
): void {
  startupSystemInfoPrefetch = createSystemInfoPrefetch(cwd, promise);
}
