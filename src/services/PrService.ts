import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { logException } from '@industry/logging';

import { getRuntimeAuthConfig } from '@/environment';
import { PrProvider, PrStatus } from '@/services/enums';
import type { PrState } from '@/services/types';
import { sanitizeHyperlinkUrl } from '@/utils/hyperlinks';

import type { ExecException } from 'node:child_process';

const execAsync = promisify(exec);

const COMMAND_TIMEOUT_MS = 3000;
const COMMAND_MAX_BUFFER = 1024 * 1024;

type PrStateCallback = (state: PrState) => void;

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function normalizeOutput(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Buffer.isBuffer(value)) return value.toString('utf8').trim();
  return '';
}

async function executeCommand(command: string): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
      windowsHide: true,
    });
    return {
      ok: true,
      stdout: normalizeOutput(stdout),
      stderr: normalizeOutput(stderr),
    };
  } catch (error) {
    const execError = error as ExecException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      ok: false,
      stdout: normalizeOutput(execError.stdout),
      stderr: normalizeOutput(execError.stderr),
    };
  }
}

function parseJson<T>(raw: string): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    logException(error, '[PrService] Failed to parse PR JSON');
    return null;
  }
}

async function detectGithubPr(): Promise<{
  prUrl: string;
  prNumber: string;
  baseBranch: string;
} | null> {
  const result = await executeCommand(
    'gh pr view --json url,number,baseRefName'
  );
  if (!result.ok || !result.stdout) {
    return null;
  }

  const data = parseJson<{
    url?: string;
    number?: number | string;
    baseRefName?: string;
  }>(result.stdout);
  if (!data) {
    return null;
  }

  const sanitizedUrl = sanitizeHyperlinkUrl(data?.url);

  if (!sanitizedUrl || data.number === undefined || data.number === null) {
    return null;
  }

  return {
    prUrl: sanitizedUrl,
    prNumber: String(data.number),
    baseBranch: data.baseRefName ?? 'main',
  };
}

async function detectGitlabPr(): Promise<{
  prUrl: string;
  prNumber: string;
  baseBranch: string;
} | null> {
  const result = await executeCommand(
    'glab mr view --json web_url,iid,target_branch'
  );
  if (!result.ok || !result.stdout) {
    return null;
  }

  const data = parseJson<{
    web_url?: string;
    iid?: number | string;
    target_branch?: string;
  }>(result.stdout);
  if (!data) {
    return null;
  }

  const sanitizedUrl = sanitizeHyperlinkUrl(data?.web_url);

  if (!sanitizedUrl || data.iid === undefined || data.iid === null) {
    return null;
  }

  return {
    prUrl: sanitizedUrl,
    prNumber: String(data.iid),
    baseBranch: data.target_branch ?? 'main',
  };
}

async function getLocalDiffStats(
  baseBranch: string
): Promise<{ additions: number; deletions: number }> {
  const mergeBase = await executeCommand(
    `git merge-base origin/${baseBranch} HEAD`
  );
  const base =
    mergeBase.ok && mergeBase.stdout
      ? mergeBase.stdout
      : `origin/${baseBranch}`;

  const result = await executeCommand(`git diff --shortstat ${base}`);
  if (!result.ok || !result.stdout) {
    return { additions: 0, deletions: 0 };
  }

  const insertions = result.stdout.match(/(\d+) insertion/);
  const deletionsMatch = result.stdout.match(/(\d+) deletion/);
  return {
    additions: insertions ? parseInt(insertions[1], 10) : 0,
    deletions: deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0,
  };
}

class PrService {
  private subscribers = new Set<PrStateCallback>();

  private state: PrState = { status: PrStatus.Idle };

  private pendingDetection: Promise<PrState> | null = null;

  getState(): PrState {
    return this.state;
  }

  subscribe(callback: PrStateCallback): () => void {
    this.subscribers.add(callback);
    callback(this.state);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async detect(): Promise<PrState> {
    // `gh pr view` hits api.github.com, which is forbidden under airgap.
    if (getRuntimeAuthConfig().airgapEnabled) {
      const nextState: PrState = { status: PrStatus.NotFound };
      this.setState(nextState);
      return nextState;
    }

    if (this.pendingDetection) {
      return this.pendingDetection;
    }

    const isInitial = this.state.status === PrStatus.Idle;
    if (isInitial) {
      this.setState({ status: PrStatus.Loading });
    }
    this.pendingDetection = this.runDetection().finally(() => {
      this.pendingDetection = null;
    });

    return this.pendingDetection;
  }

  async refresh(): Promise<PrState> {
    this.pendingDetection = null;
    return this.detect();
  }

  resetForTesting(): void {
    this.pendingDetection = null;
    this.state = { status: PrStatus.Idle };
    this.subscribers.clear();
  }

  private async runDetection(): Promise<PrState> {
    const githubMatch = await detectGithubPr();
    if (githubMatch) {
      const diffStats = await getLocalDiffStats(githubMatch.baseBranch);
      const nextState: PrState = {
        status: PrStatus.Found,
        prUrl: githubMatch.prUrl,
        prNumber: githubMatch.prNumber,
        provider: PrProvider.GitHub,
        additions: diffStats.additions,
        deletions: diffStats.deletions,
      };
      this.setState(nextState);
      return nextState;
    }

    const gitlabMatch = await detectGitlabPr();
    if (gitlabMatch) {
      const diffStats = await getLocalDiffStats(gitlabMatch.baseBranch);
      const nextState: PrState = {
        status: PrStatus.Found,
        prUrl: gitlabMatch.prUrl,
        prNumber: gitlabMatch.prNumber,
        provider: PrProvider.GitLab,
        additions: diffStats.additions,
        deletions: diffStats.deletions,
      };
      this.setState(nextState);
      return nextState;
    }

    const nextState: PrState = { status: PrStatus.NotFound };
    this.setState(nextState);
    return nextState;
  }

  private setState(state: PrState): void {
    this.state = state;
    this.emitStateChange();
  }

  private emitStateChange(): void {
    this.subscribers.forEach((callback) => {
      try {
        callback(this.state);
      } catch (error) {
        logException(error, '[PrService] Subscriber callback failed');
      }
    });
  }
}

let prServiceInstance: PrService | null = null;

export function getPrService(): PrService {
  if (!prServiceInstance) {
    prServiceInstance = new PrService();
    void prServiceInstance.detect();
  }
  return prServiceInstance;
}
