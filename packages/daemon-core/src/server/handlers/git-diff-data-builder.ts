import type {
  DaemonGetGitDiffData,
  DaemonGetGitDiffFile,
} from '@industry/common/daemon';

type GitCommandRunner = (
  args: string[],
  cwd: string,
  maxOutputSize?: number
) => Promise<string | null>;

type GitCommandWithStderrRunner = (
  args: string[],
  cwd: string,
  maxOutputSize?: number
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

type GitDiffFileStatus =
  | 'added'
  | 'binary'
  | 'copied'
  | 'deleted'
  | 'modified'
  | 'renamed';

interface GitDiffFileStat {
  additions: number;
  deletions: number;
  status: GitDiffFileStatus;
  oldPath?: string;
}

type GitDiffStatMap = Map<string, GitDiffFileStat>;

interface CollectUntrackedDiffsResult {
  diff: string;
  stats: GitDiffStatMap;
}

interface GitDiffDataBuilderParams {
  baseBranch: string;
  cwd: string;
  maxDiffSize: number;
  runGitCommand: GitCommandRunner;
  runGitCommandWithStderr: GitCommandWithStderrRunner;
  statsOnly: boolean;
}

type GitDiffData = Pick<
  DaemonGetGitDiffData,
  | 'committedDiff'
  | 'committedFiles'
  | 'committedTotalAdditions'
  | 'committedTotalDeletions'
  | 'commits'
  | 'diff'
  | 'files'
  | 'totalAdditions'
  | 'totalDeletions'
  | 'unstagedDiff'
  | 'unstagedFiles'
  | 'unstagedTotalAdditions'
  | 'unstagedTotalDeletions'
>;

function countAddedLinesInDiff(diff: string): number {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
}

function parseLogOutput(logOutput: string): DaemonGetGitDiffData['commits'] {
  const commits: DaemonGetGitDiffData['commits'] = [];
  const lines = logOutput.split('\n').filter((line) => line.trim());
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]+)\s+(.*)$/);
    if (match) {
      commits.push({ hash: match[1], message: match[2] });
    }
  }
  return commits;
}

function parseUntrackedNumstat(numstatOutput: string): GitDiffFileStat {
  const line = numstatOutput.split('\n').find((entry) => entry.trim());
  if (!line) {
    return { additions: 0, deletions: 0, status: 'added' };
  }

  const parts = line.split('\t');
  if (parts.length < 2 || (parts[0] === '-' && parts[1] === '-')) {
    return { additions: 0, deletions: 0, status: 'added' };
  }

  return {
    additions: parseInt(parts[0], 10) || 0,
    deletions: 0,
    status: 'added',
  };
}

async function getUntrackedFileStat({
  cwd,
  filePath,
  runGitCommandWithStderr,
}: {
  cwd: string;
  filePath: string;
  runGitCommandWithStderr: GitCommandWithStderrRunner;
}): Promise<GitDiffFileStat> {
  const { stdout } = await runGitCommandWithStderr(
    ['diff', '--no-index', '--numstat', '--', '/dev/null', filePath],
    cwd
  );

  return parseUntrackedNumstat(stdout);
}

async function collectUntrackedDiffs({
  cwd,
  maxDiffSize,
  runGitCommandWithStderr,
  untrackedFiles,
}: {
  cwd: string;
  maxDiffSize: number;
  runGitCommandWithStderr: GitCommandWithStderrRunner;
  untrackedFiles: string[];
}): Promise<CollectUntrackedDiffsResult> {
  const stats: GitDiffStatMap = new Map();
  let diff = '';
  let diffSize = 0;

  for (const filePath of untrackedFiles) {
    const stat = await getUntrackedFileStat({
      cwd,
      filePath,
      runGitCommandWithStderr,
    });
    stats.set(filePath, stat);

    if (diffSize >= maxDiffSize) {
      continue;
    }

    const separator = diff ? '\n' : '';
    const remaining = maxDiffSize - diffSize - separator.length;
    if (remaining <= 0) {
      continue;
    }

    const { stdout } = await runGitCommandWithStderr(
      ['diff', '--no-index', '--', '/dev/null', filePath],
      cwd,
      remaining
    );
    const singleDiff = stdout.trim();
    const additions = singleDiff ? countAddedLinesInDiff(singleDiff) : 0;
    if (stat.additions === 0 && additions > 0) {
      stat.additions = additions;
    }

    if (!singleDiff) {
      continue;
    }

    const nextChunk =
      singleDiff.length > remaining
        ? singleDiff.slice(0, remaining)
        : singleDiff;
    diff += separator + nextChunk;
    diffSize += separator.length + nextChunk.length;
  }

  return { diff, stats };
}

async function collectUntrackedStats({
  cwd,
  runGitCommandWithStderr,
  untrackedFiles,
}: {
  cwd: string;
  runGitCommandWithStderr: GitCommandWithStderrRunner;
  untrackedFiles: string[];
}): Promise<GitDiffStatMap> {
  const stats: GitDiffStatMap = new Map();

  for (const filePath of untrackedFiles) {
    stats.set(
      filePath,
      await getUntrackedFileStat({
        cwd,
        filePath,
        runGitCommandWithStderr,
      })
    );
  }

  return stats;
}

async function getFileStats({
  cwd,
  diffRef,
  runGitCommand,
}: {
  cwd: string;
  diffRef: string;
  runGitCommand: GitCommandRunner;
}): Promise<GitDiffStatMap> {
  const stats: GitDiffStatMap = new Map();

  const numstatOutput = await runGitCommand(
    ['diff', diffRef, '--no-renames', '--numstat'],
    cwd
  );

  if (numstatOutput) {
    const lines = numstatOutput.split('\n').filter((line) => line.trim());
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
        const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
        const filePath = parts.slice(2).join('\t');
        const isBinary = parts[0] === '-' && parts[1] === '-';
        stats.set(filePath, {
          additions,
          deletions,
          status: isBinary ? 'binary' : 'modified',
        });
      }
    }
  }

  const nameStatusOutput = await runGitCommand(
    ['diff', diffRef, '--no-renames', '--name-status'],
    cwd
  );

  if (nameStatusOutput) {
    const lines = nameStatusOutput.split('\n').filter((line) => line.trim());
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 2) {
        const statusCode = parts[0];
        let filePath = parts[1];
        let oldPath: string | undefined;
        let status: GitDiffFileStatus = 'modified';

        if (statusCode === 'A') {
          status = 'added';
        } else if (statusCode === 'D') {
          status = 'deleted';
        } else if (statusCode.startsWith('R')) {
          status = 'renamed';
          if (parts.length >= 3) {
            oldPath = parts[1];
            filePath = parts[2];
          }
        } else if (statusCode.startsWith('C')) {
          status = 'copied';
          if (parts.length >= 3) {
            oldPath = parts[1];
            filePath = parts[2];
          }
        }

        const existing = stats.get(filePath);
        if (existing) {
          existing.status = status;
          if (oldPath) {
            existing.oldPath = oldPath;
          }
        } else {
          stats.set(filePath, {
            additions: 0,
            deletions: 0,
            status,
            ...(oldPath ? { oldPath } : {}),
          });
        }
      }
    }
  }

  return stats;
}

function combineDiffsWithLimit({
  primaryDiff,
  appendedDiff,
  maxDiffSize,
}: {
  primaryDiff: string;
  appendedDiff: string;
  maxDiffSize: number;
}): string {
  if (!primaryDiff) {
    return appendedDiff.length > maxDiffSize
      ? appendedDiff.slice(0, maxDiffSize)
      : appendedDiff;
  }

  if (!appendedDiff || primaryDiff.length >= maxDiffSize) {
    return primaryDiff;
  }

  const separator = '\n';
  const remaining = maxDiffSize - primaryDiff.length - separator.length;
  if (remaining <= 0) {
    return primaryDiff;
  }

  return `${primaryDiff}${separator}${appendedDiff.slice(0, remaining)}`;
}

function addFilesFromStats(
  stats: GitDiffStatMap,
  files: DaemonGetGitDiffFile[]
): { totalAdditions: number; totalDeletions: number } {
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const [filePath, stat] of stats.entries()) {
    files.push({
      path: filePath,
      additions: stat.additions,
      deletions: stat.deletions,
      status: stat.status,
    });
    totalAdditions += stat.additions;
    totalDeletions += stat.deletions;
  }

  return { totalAdditions, totalDeletions };
}

function appendUntrackedFiles({
  files,
  stats,
  untrackedFiles,
}: {
  files: DaemonGetGitDiffFile[];
  stats: GitDiffStatMap;
  untrackedFiles: string[];
}): number {
  let totalAdditions = 0;

  for (const filePath of untrackedFiles) {
    const stat = stats.get(filePath) ?? {
      additions: 0,
      deletions: 0,
      status: 'added' as const,
    };
    files.push({
      path: filePath,
      additions: stat.additions,
      deletions: stat.deletions,
      status: stat.status,
    });
    totalAdditions += stat.additions;
  }

  return totalAdditions;
}

export async function buildGitDiffData({
  baseBranch,
  cwd,
  maxDiffSize,
  runGitCommand,
  runGitCommandWithStderr,
  statsOnly,
}: GitDiffDataBuilderParams): Promise<GitDiffData> {
  const committedDiffRef = `${baseBranch}...HEAD`;
  const branchMergeBase =
    (await runGitCommand(['merge-base', baseBranch, 'HEAD'], cwd)) ||
    baseBranch;

  const committedDiff = statsOnly
    ? ''
    : (await runGitCommand(['diff', committedDiffRef], cwd, maxDiffSize)) || '';
  const committedFiles: DaemonGetGitDiffFile[] = [];
  const committedTotals = addFilesFromStats(
    await getFileStats({
      cwd,
      diffRef: committedDiffRef,
      runGitCommand,
    }),
    committedFiles
  );

  const trackedBranchDiff = statsOnly
    ? ''
    : (await runGitCommand(['diff', branchMergeBase], cwd, maxDiffSize)) || '';
  const files: DaemonGetGitDiffFile[] = [];
  const branchTotals = addFilesFromStats(
    await getFileStats({
      cwd,
      diffRef: branchMergeBase,
      runGitCommand,
    }),
    files
  );
  let totalAdditions = branchTotals.totalAdditions;
  const totalDeletions = branchTotals.totalDeletions;

  const logOutput = statsOnly
    ? ''
    : (await runGitCommand(['log', '--oneline', `${baseBranch}..HEAD`], cwd)) ||
      '';
  const commits = parseLogOutput(logOutput);

  const trackedUnstagedDiff = statsOnly
    ? ''
    : (await runGitCommand(['diff', 'HEAD'], cwd, maxDiffSize)) || '';
  const untrackedOutput =
    (await runGitCommand(
      ['ls-files', '--others', '--exclude-standard'],
      cwd
    )) || '';
  const untrackedFiles = untrackedOutput
    .split('\n')
    .filter((file) => file.trim());

  const untrackedDiffResult = statsOnly
    ? {
        diff: '',
        stats: await collectUntrackedStats({
          cwd,
          runGitCommandWithStderr,
          untrackedFiles,
        }),
      }
    : await collectUntrackedDiffs({
        cwd,
        maxDiffSize: Math.max(
          Math.max(0, maxDiffSize - trackedBranchDiff.length),
          Math.max(0, maxDiffSize - trackedUnstagedDiff.length)
        ),
        runGitCommandWithStderr,
        untrackedFiles,
      });

  totalAdditions += appendUntrackedFiles({
    files,
    stats: untrackedDiffResult.stats,
    untrackedFiles,
  });

  const unstagedFiles: DaemonGetGitDiffFile[] = [];
  let unstagedTotalAdditions = 0;
  let unstagedTotalDeletions = 0;

  if (statsOnly || trackedUnstagedDiff) {
    const unstagedStats = await getFileStats({
      cwd,
      diffRef: 'HEAD',
      runGitCommand,
    });
    const unstagedTotals = addFilesFromStats(unstagedStats, unstagedFiles);
    unstagedTotalAdditions += unstagedTotals.totalAdditions;
    unstagedTotalDeletions += unstagedTotals.totalDeletions;
  }

  unstagedTotalAdditions += appendUntrackedFiles({
    files: unstagedFiles,
    stats: untrackedDiffResult.stats,
    untrackedFiles,
  });

  return {
    committedDiff,
    committedFiles,
    committedTotalAdditions: committedTotals.totalAdditions,
    committedTotalDeletions: committedTotals.totalDeletions,
    commits,
    diff: combineDiffsWithLimit({
      primaryDiff: trackedBranchDiff,
      appendedDiff: untrackedDiffResult.diff,
      maxDiffSize,
    }),
    files,
    totalAdditions,
    totalDeletions,
    unstagedDiff: combineDiffsWithLimit({
      primaryDiff: trackedUnstagedDiff,
      appendedDiff: untrackedDiffResult.diff,
      maxDiffSize,
    }),
    unstagedFiles,
    unstagedTotalAdditions,
    unstagedTotalDeletions,
  };
}
