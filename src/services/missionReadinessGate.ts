import { exec } from 'child_process';
import fs from 'node:fs/promises';
import { promisify } from 'util';

import {
  MissionReadinessGateState,
  ReadinessLevel,
} from '@industry/common/agentReadiness/enums';
import { fetchPreviousReadinessReportResult } from '@industry/drool-core/api/readiness';
import {
  calculateRepoLevel,
  evaluateMissionReadinessGate,
  inspectMissionRepo,
} from '@industry/utils/agentReadiness';

import type { MissionReadinessGateResult } from '@industry/utils/agentReadiness';

const execAsync = promisify(exec);
const GIT_TIMEOUT_MS = 5000;
/**
 * Upper bound on the readiness-report lookup so Mission entry can never stall
 * on a slow or unresponsive backend. A timeout degrades to Ok, identical to a
 * transient fetch failure.
 */
const REPORT_FETCH_TIMEOUT_MS = 5000;

const REPORT_FETCH_TIMED_OUT = Symbol('report-fetch-timed-out');

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | typeof REPORT_FETCH_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof REPORT_FETCH_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(REPORT_FETCH_TIMED_OUT), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runGitCommand(
  args: string[],
  cwd: string
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`git ${args.join(' ')}`, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Evaluates whether a Mission should be gated behind a readiness warning for
 * the given working directory. Detects git state locally and fetches the
 * latest agent readiness report when a remote is configured.
 */
export async function evaluateMissionReadinessForCwd(
  cwd: string = process.cwd()
): Promise<MissionReadinessGateResult> {
  const inspection = await inspectMissionRepo(cwd, {
    runGitCommand,
    readDirectory: (dir) => fs.readdir(dir),
  });
  const { repoUrl } = inspection;

  let level: ReadinessLevel | undefined;
  if (repoUrl) {
    const result = await withTimeout(
      fetchPreviousReadinessReportResult(repoUrl),
      REPORT_FETCH_TIMEOUT_MS
    );
    if (result === REPORT_FETCH_TIMED_OUT || !result.ok) {
      // A timeout or transient fetch failure (network/auth/5xx) is not the
      // same as "no report exists". Degrade to Ok so a detection problem
      // never shows a false "no readiness report" warning or stalls Mission
      // entry, matching the web gate.
      return { state: MissionReadinessGateState.Ok, level: undefined, repoUrl };
    }
    if (result.report) {
      level = calculateRepoLevel(result.report).achievedLevel;
    }
  }

  const state = evaluateMissionReadinessGate(inspection, level);

  return { state, level, repoUrl };
}
