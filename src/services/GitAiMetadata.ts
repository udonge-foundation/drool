import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { sanitizeGitRemoteUrl } from '@industry/utils/agentReadiness';

const execFileAsync = promisify(execFile);
const DIFF_METADATA_VERSION = 'git-ai-diff-metadata-v1';
const DIFF_HASH_VERSION = 'git-ai-diff-hash-v1';

type ChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type_changed'
  | 'unknown';

type DiffHunkMetadata = {
  hunk_index: number;
  hunk_header: string;
  old_start_line: number;
  old_line_count: number;
  new_start_line: number;
  new_line_count: number;
  added_lines_hash: string;
  removed_lines_hash: string;
  normalized_hunk_hash: string;
  loc_added: number;
  loc_deleted: number;
  is_generated_file: boolean;
  is_lockfile: boolean;
  is_vendor_file: boolean;
  is_formatting_only: boolean;
  hash_version: string;
};

type PatchFileMetadata = {
  oldPath?: string;
  newPath?: string;
  changeStatus: ChangeStatus;
  blobShaBefore?: string | null;
  blobShaAfter?: string | null;
  hunks: DiffHunkMetadata[];
};

type RepositoryMetadata = {
  repoOwner?: string;
  repoFullName?: string;
  repoRemoteUrl?: string;
  repoDefaultBranch?: string;
  branchName?: string;
  baseBranch?: string;
  headBranch?: string;
  isDefaultBranchCommit?: boolean;
};

type CommitMetadata = {
  diffMetadataVersion?: string;
  diffHashVersion?: string;
  treeSha?: string;
  parentShas?: string[];
  isMergeCommit?: boolean;
  commitAuthoredAt?: string;
  commitCommittedAt?: string;
  commitAuthorName?: string;
  commitAuthorEmail?: string;
  commitCommitterName?: string;
  commitCommitterEmail?: string;
  isRevertCommit?: boolean;
  revertedCommitSha?: string;
  churnedLoc?: number;
  commitAdditions?: number;
  commitDeletions?: number;
  commitChangedFiles?: number;
  commitAdditionsSloc?: number | null;
  commitDeletionsSloc?: number | null;
  aiAdditions?: number;
  humanAdditions?: number;
  acceptedAiLines?: number;
  overriddenAiLines?: number;
  generatedAiLines?: number;
  filePathsChanged?: string[];
  languagesChanged?: string[];
  commitDiffFiles?: PatchFileMetadata[];
};

type NoteMetadata = {
  prompts?: Record<string, unknown>;
};

async function runGit(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function runGitWithExitCode(
  args: string[]
): Promise<{ stdout: string; code: number | null }> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: stdout.trim(), code: 0 };
  } catch (error) {
    const gitError = error as { code?: unknown; stdout?: unknown };
    if (
      typeof gitError.code === 'number' &&
      typeof gitError.stdout === 'string'
    ) {
      return { stdout: gitError.stdout.trim(), code: gitError.code };
    }
    return { stdout: '', code: null };
  }
}

export function parseRepoFullName(repoUrl: string): {
  repoOwner?: string;
  repoFullName?: string;
} {
  const match = repoUrl.match(
    /(?:github\.com[:/]|gitlab\.com[:/])([^\s:?#]+?)(?:\.git)?\/?$/
  );
  if (!match) return {};
  const pathParts = match[1].split('/').filter(Boolean);
  if (pathParts.length < 2) return {};

  return {
    repoOwner: pathParts.slice(0, -1).join('/'),
    repoFullName: pathParts.join('/'),
  };
}

export function languageFromPath(filePath: string): string | null {
  const ext = path
    .extname(filePath)
    .toLowerCase()
    .replace(/^\./, '')
    .replace(/}$/, '');
  if (!ext) return null;

  const aliases: Record<string, string> = {
    cjs: 'javascript',
    css: 'css',
    go: 'go',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    mjs: 'javascript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    sh: 'shell',
    sql: 'sql',
    ts: 'typescript',
    tsx: 'typescript',
    yaml: 'yaml',
    yml: 'yaml',
  };

  return aliases[ext] ?? ext;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashLines(lines: string[]): string {
  return sha256(lines.join('\n'));
}

function getPathFlags(filePath: string | undefined): {
  is_generated_file: boolean;
  is_lockfile: boolean;
  is_vendor_file: boolean;
} {
  const normalizedPath = (filePath ?? '').replace(/\\/g, '/').toLowerCase();
  const segments = normalizedPath.split('/').filter(Boolean);
  const basename = path.basename(normalizedPath);
  const lockfiles = new Set([
    'bun.lock',
    'bun.lockb',
    'cargo.lock',
    'composer.lock',
    'gemfile.lock',
    'go.sum',
    'package-lock.json',
    'pnpm-lock.yaml',
    'poetry.lock',
    'yarn.lock',
  ]);

  return {
    is_generated_file:
      segments.includes('generated') ||
      segments.includes('__generated__') ||
      basename.includes('.generated.') ||
      basename.includes('.gen.') ||
      basename.endsWith('.pb.go') ||
      basename.endsWith('.g.dart'),
    is_lockfile: lockfiles.has(basename),
    is_vendor_file:
      segments.includes('node_modules') ||
      segments.includes('vendor') ||
      segments.includes('third_party') ||
      segments.includes('external'),
  };
}

function isFormattingOnlyHunk(
  addedLines: string[],
  removedLines: string[]
): boolean {
  if (addedLines.length === 0 || removedLines.length === 0) return false;
  const normalize = (lines: string[]) =>
    lines.map((line) => line.replace(/\s+/g, '')).join('\n');
  return normalize(addedLines) === normalize(removedLines);
}

function parsePathFromPatchLine(line: string): string | undefined {
  const value = line.slice(4).trim();
  if (value === '/dev/null') return undefined;
  return value.replace(/^[ab]\//, '');
}

function parseDiffHeader(line: string): { oldPath?: string; newPath?: string } {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!match) return {};
  return { oldPath: match[1], newPath: match[2] };
}

function parseHunkHeader(header: string):
  | {
      old_start_line: number;
      old_line_count: number;
      new_start_line: number;
      new_line_count: number;
    }
  | undefined {
  const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return undefined;
  return {
    old_start_line: Number(match[1]),
    old_line_count: Number(match[2] ?? 1),
    new_start_line: Number(match[3]),
    new_line_count: Number(match[4] ?? 1),
  };
}

function getChangeStatus(params: {
  oldPath?: string;
  newPath?: string;
  explicitStatus?: ChangeStatus;
}): ChangeStatus {
  if (params.explicitStatus) return params.explicitStatus;
  if (!params.oldPath && params.newPath) return 'added';
  if (params.oldPath && !params.newPath) return 'deleted';
  if (params.oldPath && params.newPath && params.oldPath !== params.newPath) {
    return 'renamed';
  }
  return 'modified';
}

function normalizeHunkForHash(lines: string[]): string {
  // v1 preserves diff line content exactly after the +/-/space prefix and
  // excludes hunk line numbers so analytics can reproduce hashes from commits.
  return lines
    .filter((line) => line !== '\\ No newline at end of file')
    .map((line) => {
      const prefix = line[0];
      if (prefix === '+' || prefix === '-' || prefix === ' ') {
        return `${prefix}:${line.slice(1)}`;
      }
      return `?:${line}`;
    })
    .join('\n');
}

function buildHunkMetadata(
  hunkHeader: string,
  hunkLines: string[],
  hunkIndex: number,
  pathFlags: ReturnType<typeof getPathFlags>
): DiffHunkMetadata | undefined {
  const parsedHeader = parseHunkHeader(hunkHeader);
  if (!parsedHeader) return undefined;

  const addedLines = hunkLines
    .filter((line) => line.startsWith('+'))
    .map((line) => line.slice(1));
  const removedLines = hunkLines
    .filter((line) => line.startsWith('-'))
    .map((line) => line.slice(1));

  return {
    hunk_index: hunkIndex,
    hunk_header: hunkHeader,
    ...parsedHeader,
    added_lines_hash: hashLines(addedLines),
    removed_lines_hash: hashLines(removedLines),
    normalized_hunk_hash: sha256(normalizeHunkForHash(hunkLines)),
    loc_added: addedLines.length,
    loc_deleted: removedLines.length,
    ...pathFlags,
    is_formatting_only:
      pathFlags.is_lockfile && isFormattingOnlyHunk(addedLines, removedLines),
    hash_version: DIFF_HASH_VERSION,
  };
}

function finishHunk(
  file: PatchFileMetadata | undefined,
  hunkHeader: string | undefined,
  hunkLines: string[]
): void {
  if (!file || !hunkHeader) return;
  const hunk = buildHunkMetadata(
    hunkHeader,
    hunkLines,
    file.hunks.length,
    getPathFlags(file.newPath ?? file.oldPath)
  );
  if (hunk) {
    file.hunks.push(hunk);
  }
}

export function parseRevertMetadata(commitMessage: string): {
  isRevertCommit: boolean;
  revertedCommitSha?: string;
} {
  const subject = commitMessage.split('\n')[0] ?? '';
  const revertedCommitSha = commitMessage
    .match(/This reverts commit ([0-9a-fA-F]{7,40})\./)?.[1]
    ?.toLowerCase();

  return {
    isRevertCommit: subject.startsWith('Revert ') || Boolean(revertedCommitSha),
    ...(revertedCommitSha && { revertedCommitSha }),
  };
}

export function parseGitPatchMetadata(patch: string): PatchFileMetadata[] {
  const files: PatchFileMetadata[] = [];
  let currentFile: PatchFileMetadata | undefined;
  let currentHunkHeader: string | undefined;
  let currentHunkLines: string[] = [];

  const finishFile = () => {
    finishHunk(currentFile, currentHunkHeader, currentHunkLines);
    currentHunkHeader = undefined;
    currentHunkLines = [];
    if (currentFile) {
      currentFile.changeStatus = getChangeStatus({
        ...currentFile,
        explicitStatus:
          currentFile.changeStatus === 'unknown'
            ? undefined
            : currentFile.changeStatus,
      });
      files.push(currentFile);
    }
  };

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finishFile();
      const { oldPath, newPath } = parseDiffHeader(line);
      currentFile = {
        ...(oldPath && { oldPath }),
        ...(newPath && { newPath }),
        changeStatus: 'unknown',
        hunks: [],
      };
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith('index ')) {
      const match = line.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/i);
      if (match) {
        currentFile.blobShaBefore = /^0+$/.test(match[1]) ? null : match[1];
        currentFile.blobShaAfter = /^0+$/.test(match[2]) ? null : match[2];
      }
      continue;
    }

    if (line.startsWith('new file mode')) {
      currentFile.changeStatus = 'added';
      currentFile.blobShaBefore = null;
      continue;
    }

    if (line.startsWith('deleted file mode')) {
      currentFile.changeStatus = 'deleted';
      currentFile.blobShaAfter = null;
      continue;
    }

    if (line.startsWith('similarity index')) {
      currentFile.changeStatus = 'renamed';
      continue;
    }

    if (line.startsWith('copy from ')) {
      currentFile.changeStatus = 'copied';
      currentFile.oldPath = line.slice('copy from '.length);
      continue;
    }

    if (line.startsWith('copy to ')) {
      currentFile.changeStatus = 'copied';
      currentFile.newPath = line.slice('copy to '.length);
      continue;
    }

    if (line.startsWith('rename from ')) {
      currentFile.changeStatus = 'renamed';
      currentFile.oldPath = line.slice('rename from '.length);
      continue;
    }

    if (line.startsWith('rename to ')) {
      currentFile.changeStatus = 'renamed';
      currentFile.newPath = line.slice('rename to '.length);
      continue;
    }

    if (line.startsWith('--- ')) {
      const oldPath = parsePathFromPatchLine(line);
      if (oldPath) {
        currentFile.oldPath = oldPath;
      } else {
        delete currentFile.oldPath;
      }
      continue;
    }

    if (line.startsWith('+++ ')) {
      const newPath = parsePathFromPatchLine(line);
      if (newPath) {
        currentFile.newPath = newPath;
      } else {
        delete currentFile.newPath;
      }
      continue;
    }

    if (line.startsWith('@@ ')) {
      finishHunk(currentFile, currentHunkHeader, currentHunkLines);
      currentHunkHeader = line;
      currentHunkLines = [];
      continue;
    }

    if (currentHunkHeader) {
      currentHunkLines.push(line);
    }
  }

  finishFile();

  return files.filter(
    (file) => file.hunks.length > 0 || file.changeStatus !== 'unknown'
  );
}

function parseNoteMetadata(noteContent: string): NoteMetadata | null {
  const dividerMatch = noteContent.match(/^---\s*$/m);
  if (!dividerMatch || dividerMatch.index === undefined) return null;

  const jsonSection = noteContent
    .slice(dividerMatch.index + dividerMatch[0].length)
    .trim();
  if (!jsonSection) return null;

  try {
    return JSON.parse(jsonSection) as NoteMetadata;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

export function summarizeGitAiNote(noteContent: string): CommitMetadata {
  const metadata = parseNoteMetadata(noteContent);
  const prompts = isRecord(metadata?.prompts)
    ? Object.values(metadata.prompts)
    : [];
  if (prompts.length === 0) return {};

  let aiAdditions = 0;
  let humanAdditions = 0;
  let acceptedAiLines = 0;
  let overriddenAiLines = 0;

  for (const prompt of prompts) {
    if (!isRecord(prompt)) continue;

    const additions = numberOrZero(prompt.total_additions);
    const accepted = numberOrZero(prompt.accepted_lines);
    const overridden =
      finiteNumberOrUndefined(prompt.overridden_lines) ??
      finiteNumberOrUndefined(prompt.overriden_lines) ??
      0;
    const agentId = prompt.agent_id;
    const isAiPrompt =
      isRecord(agentId) &&
      typeof agentId.tool === 'string' &&
      agentId.tool.length > 0;

    if (isAiPrompt) {
      aiAdditions += additions;
      acceptedAiLines += accepted;
      overriddenAiLines += overridden;
    } else {
      humanAdditions += additions;
    }
  }

  return {
    aiAdditions,
    humanAdditions,
    acceptedAiLines,
    overriddenAiLines,
    generatedAiLines: acceptedAiLines + overriddenAiLines,
  };
}

async function getDefaultBranch(): Promise<string | undefined> {
  const symbolicRef = await runGit([
    'symbolic-ref',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  return symbolicRef?.replace(/^origin\//, '') || undefined;
}

async function getCurrentBranch(): Promise<string | undefined> {
  return (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])) || undefined;
}

async function isDefaultBranchCommit(
  commitSha: string,
  defaultBranch?: string
): Promise<boolean | undefined> {
  if (!defaultBranch) return undefined;
  const result = await runGitWithExitCode([
    'merge-base',
    '--is-ancestor',
    commitSha,
    `origin/${defaultBranch}`,
  ]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  return undefined;
}

export async function collectGitAiRepositoryMetadata(params: {
  repoUrl?: string;
  branch?: string;
  commitSha?: string;
  title?: string;
}): Promise<RepositoryMetadata> {
  const repoRemoteUrl = sanitizeGitRemoteUrl(
    params.repoUrl || (await runGit(['remote', 'get-url', 'origin'])) || ''
  );
  const repoInfo = parseRepoFullName(repoRemoteUrl);
  const repoDefaultBranch = await getDefaultBranch();
  const branchName = params.branch || (await getCurrentBranch());
  const defaultBranchCommit = params.commitSha
    ? await isDefaultBranchCommit(params.commitSha, repoDefaultBranch)
    : undefined;

  return {
    ...repoInfo,
    ...(repoRemoteUrl && { repoRemoteUrl }),
    ...(repoDefaultBranch && { repoDefaultBranch }),
    ...(branchName && { branchName, headBranch: branchName }),
    ...(repoDefaultBranch && { baseBranch: repoDefaultBranch }),
    ...(defaultBranchCommit !== undefined && {
      isDefaultBranchCommit: defaultBranchCommit,
    }),
  };
}

export async function collectGitAiCommitMetadata(params: {
  commitSha: string;
  noteContent?: string;
}): Promise<CommitMetadata> {
  const format = [
    '%H',
    '%T',
    '%P',
    '%aI',
    '%cI',
    '%an',
    '%ae',
    '%cn',
    '%ce',
  ].join('%x00');

  const commitInfo = await runGit([
    'show',
    '-s',
    `--format=${format}`,
    params.commitSha,
  ]);
  const [
    ,
    treeSha,
    parentShaText,
    commitAuthoredAt,
    commitCommittedAt,
    commitAuthorName,
    commitAuthorEmail,
    commitCommitterName,
    commitCommitterEmail,
  ] = commitInfo?.split('\x00') ?? [];
  const parentShas = parentShaText ? parentShaText.split(' ') : [];
  const commitMessage = await runGit([
    'show',
    '-s',
    '--format=%B',
    params.commitSha,
  ]);
  const revertMetadata =
    commitMessage === null ? undefined : parseRevertMetadata(commitMessage);

  const numstat = await runGit([
    'show',
    '--numstat',
    '--format=',
    params.commitSha,
  ]);
  const filePathsChanged: string[] = [];
  let commitAdditions = 0;
  let commitDeletions = 0;

  for (const line of numstat === null ? [] : numstat.split('\n')) {
    const [additions, deletions, filePath] = line.split('\t');
    if (!filePath) continue;
    filePathsChanged.push(filePath);
    if (additions !== '-') commitAdditions += Number(additions) || 0;
    if (deletions !== '-') commitDeletions += Number(deletions) || 0;
  }

  const languagesChanged = [
    ...new Set(
      filePathsChanged
        .map(languageFromPath)
        .filter((language): language is string => language !== null)
    ),
  ];
  const patch = await runGit([
    'show',
    '--patch',
    '--format=',
    '--find-renames',
    '--find-copies',
    '--no-ext-diff',
    '--no-color',
    params.commitSha,
  ]);
  const commitDiffFiles = patch ? parseGitPatchMetadata(patch) : [];

  return {
    diffMetadataVersion: DIFF_METADATA_VERSION,
    diffHashVersion: DIFF_HASH_VERSION,
    ...(treeSha && { treeSha }),
    ...(commitInfo !== null && {
      parentShas,
      isMergeCommit: parentShas.length > 1,
    }),
    ...(commitAuthoredAt && { commitAuthoredAt }),
    ...(commitCommittedAt && { commitCommittedAt }),
    ...(commitAuthorName && { commitAuthorName }),
    ...(commitAuthorEmail && { commitAuthorEmail }),
    ...(commitCommitterName && { commitCommitterName }),
    ...(commitCommitterEmail && { commitCommitterEmail }),
    ...(revertMetadata && { isRevertCommit: revertMetadata.isRevertCommit }),
    ...(revertMetadata?.revertedCommitSha && {
      revertedCommitSha: revertMetadata.revertedCommitSha,
    }),
    ...(numstat !== null && {
      commitAdditions,
      commitDeletions,
      commitChangedFiles: filePathsChanged.length,
      commitAdditionsSloc: null,
      commitDeletionsSloc: null,
      churnedLoc: commitAdditions + commitDeletions,
      filePathsChanged,
      languagesChanged,
    }),
    ...(commitDiffFiles.length > 0 && { commitDiffFiles }),
    ...(params.noteContent ? summarizeGitAiNote(params.noteContent) : {}),
  };
}
