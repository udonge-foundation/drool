import fs from 'node:fs/promises';
import path from 'node:path';

import {
  GitAiCheckpoint,
  PushGitAiCheckpointsRequest,
} from '@industry/common/api/v0/git-ai';
import { fetch } from '@industry/drool-core/api/fetch';
import { logInfo, logWarn } from '@industry/logging';
import {
  extractRepoNameOnly,
  sanitizeGitRemoteUrl,
} from '@industry/utils/agentReadiness';

import packageJson from '../../package.json';
import {
  checkIsDefaultBranch,
  getCurrentBranch,
  getGitCommonDir,
  getGitDir,
  getHeadSha,
  getRemoteUrl,
} from '@/services/git-operations';
import {
  collectGitAiRepositoryMetadata,
  parseGitPatchMetadata,
} from '@/services/GitAiMetadata';

const DIFF_METADATA_VERSION = 'git-ai-diff-metadata-v1';
const DIFF_HASH_VERSION = 'git-ai-diff-hash-v1';
type PatchFileMetadata = ReturnType<typeof parseGitPatchMetadata>[number];

class GitAiService {
  private lastReadOffset = new Map<string, number>();

  private checkpointReadQueue: Promise<void> = Promise.resolve();

  async pushCheckpoint(sessionId: string): Promise<void> {
    let baseSha: string;
    try {
      baseSha = await getHeadSha();
    } catch {
      return;
    }

    const checkpoints = await this.withCheckpointReadLock(() =>
      this.getNewCheckpoints(baseSha)
    );
    if (checkpoints.length === 0) return;

    let branch = 'unknown';
    let repoUrl = '';
    let isDefaultBranch = false;

    try {
      branch = await getCurrentBranch();
    } catch {
      // fallback to 'unknown'
    }
    try {
      repoUrl = sanitizeGitRemoteUrl(await getRemoteUrl());
    } catch {
      // fallback to ''
    }
    try {
      isDefaultBranch = await checkIsDefaultBranch(branch);
    } catch {
      // fallback to false
    }

    const repoName =
      extractRepoNameOnly(repoUrl) || path.basename(process.cwd());

    const body: PushGitAiCheckpointsRequest = {
      baseSha,
      branch,
      isDefaultBranch,
      commitSha: null,
      repoUrl,
      repoName,
      droolVersion: packageJson.version,
      checkpoints,
      ...(await collectGitAiRepositoryMetadata({
        repoUrl,
        branch,
        commitSha: baseSha,
      })),
    };

    await fetch(`/api/sessions/${sessionId}/git-ai/checkpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    logInfo('[GitAiCheckpoints] Pushed checkpoints', {
      sessionId,
      commitSha: baseSha,
      count: checkpoints.length,
    });
  }

  private async withCheckpointReadLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.checkpointReadQueue;
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.checkpointReadQueue = previous.then(
      () => current,
      () => current
    );

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private getCheckpointJsonlPaths(
    gitCommonDir: string,
    gitDir: string | null,
    baseSha: string
  ): string[] {
    const commonCheckpointPath = path.join(
      gitCommonDir,
      'ai',
      'working_logs',
      baseSha,
      'checkpoints.jsonl'
    );

    if (!gitDir) {
      return [commonCheckpointPath];
    }

    const worktreesDir = path.join(gitCommonDir, 'worktrees');
    const relativeGitDir = path.relative(worktreesDir, gitDir);
    const [worktreeId] = relativeGitDir.split(path.sep);
    const isLinkedWorktree =
      worktreeId !== undefined &&
      worktreeId.length > 0 &&
      !relativeGitDir.startsWith('..') &&
      !path.isAbsolute(relativeGitDir);

    if (!isLinkedWorktree) {
      return [commonCheckpointPath];
    }

    return [
      path.join(
        gitCommonDir,
        'ai',
        'worktrees',
        worktreeId,
        'working_logs',
        baseSha,
        'checkpoints.jsonl'
      ),
      commonCheckpointPath,
    ];
  }

  private getCheckpointLogLocation(
    gitCommonDir: string,
    jsonlPath: string
  ): string {
    const parts = path.relative(gitCommonDir, jsonlPath).split(path.sep);
    if (parts[0] === 'ai' && parts[1] === 'worktrees') {
      return 'linked-worktree';
    }
    if (parts[0] === 'ai' && parts[1] === 'working_logs') {
      return 'common';
    }
    return 'unknown';
  }

  private getCheckpointReadFailureCause(
    error: unknown
  ): { name: string; code?: string } | undefined {
    if (!(error instanceof Error)) {
      return undefined;
    }
    const code =
      typeof (error as NodeJS.ErrnoException).code === 'string'
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    return { name: error.name, code };
  }

  private async getNewCheckpoints(baseSha: string): Promise<GitAiCheckpoint[]> {
    let gitCommonDir: string;
    try {
      gitCommonDir = await getGitCommonDir();
    } catch (error) {
      logWarn('[GitAiCheckpoints] Failed to resolve git common directory', {
        cause: this.getCheckpointReadFailureCause(error),
      });
      return [];
    }

    let gitDir: string | null = null;
    try {
      gitDir = await getGitDir();
    } catch (error) {
      logWarn(
        '[GitAiCheckpoints] Failed to resolve git directory; using common checkpoint path',
        {
          cause: this.getCheckpointReadFailureCause(error),
        }
      );
    }

    const jsonlPaths = this.getCheckpointJsonlPaths(
      gitCommonDir,
      gitDir,
      baseSha
    );

    let content: string | null = null;
    let jsonlPath: string | null = null;
    let readError: unknown;
    for (const candidatePath of jsonlPaths) {
      try {
        content = await fs.readFile(candidatePath, 'utf-8');
        jsonlPath = candidatePath;
        break;
      } catch (error) {
        readError = error;
      }
    }

    if (!jsonlPath || content === null) {
      logWarn('[GitAiCheckpoints] Failed to read checkpoint file', {
        paths: jsonlPaths.map((candidatePath) =>
          this.getCheckpointLogLocation(gitCommonDir, candidatePath)
        ),
        commitSha: baseSha,
        cause: this.getCheckpointReadFailureCause(readError),
      });
      return [];
    }

    const lines = content.split('\n').filter((line) => line.trim());
    const offsetKey = `${baseSha}:${jsonlPath}`;
    const offset = this.lastReadOffset.get(offsetKey) ?? 0;
    const newLines = lines.slice(offset);
    this.lastReadOffset.set(offsetKey, lines.length);

    if (newLines.length === 0) return [];

    return newLines
      .map((line) => {
        try {
          return this.sanitizeCheckpoint(JSON.parse(line));
        } catch (error) {
          logWarn('[GitAiCheckpoints] Failed to parse checkpoint line', {
            commitSha: baseSha,
            cause: this.getCheckpointReadFailureCause(error),
          });
          return null;
        }
      })
      .filter((c): c is GitAiCheckpoint => c !== null);
  }

  private isUnsafePersistedPath(value: string): boolean {
    return (
      path.isAbsolute(value) ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      /^\\\\/.test(value)
    );
  }

  private sanitizePersistedPath(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    if (this.isUnsafePersistedPath(value)) return '[scrubbed]';
    return value;
  }

  private checkpointEntryMetadataFromPatchFile(file: PatchFileMetadata) {
    const oldPath = this.sanitizePersistedPath(file.oldPath);
    const newPath = this.sanitizePersistedPath(file.newPath);

    return {
      ...(oldPath && { old_path: oldPath }),
      ...(newPath && { new_path: newPath }),
      change_status: file.changeStatus,
      ...(file.blobShaBefore !== undefined && {
        blob_sha_before: file.blobShaBefore,
      }),
      ...(file.blobShaAfter !== undefined && {
        blob_sha_after: file.blobShaAfter,
      }),
      hunks: file.hunks,
    };
  }

  private findPatchFileForEntry(
    entry: Record<string, unknown>,
    patchFiles: PatchFileMetadata[]
  ): PatchFileMetadata | undefined {
    const entryFile = this.sanitizePersistedPath(entry.file);
    if (!entryFile || entryFile === '[scrubbed]') return undefined;

    return patchFiles.find(
      (file) => file.newPath === entryFile || file.oldPath === entryFile
    );
  }

  private sanitizeCheckpointEntries(
    entries: unknown,
    patchFiles: PatchFileMetadata[]
  ): unknown {
    if (!Array.isArray(entries)) return entries;

    return entries.map((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return entry;
      }

      const sanitizedEntry = { ...(entry as Record<string, unknown>) };
      const sanitizedFile = this.sanitizePersistedPath(sanitizedEntry.file);
      if (sanitizedFile) {
        sanitizedEntry.file = sanitizedFile;
      }

      const sanitizedOldPath = this.sanitizePersistedPath(
        sanitizedEntry.old_path
      );
      if (sanitizedOldPath) {
        sanitizedEntry.old_path = sanitizedOldPath;
      }

      const sanitizedNewPath = this.sanitizePersistedPath(
        sanitizedEntry.new_path
      );
      if (sanitizedNewPath) {
        sanitizedEntry.new_path = sanitizedNewPath;
      }

      const patchFile = this.findPatchFileForEntry(sanitizedEntry, patchFiles);
      return {
        ...sanitizedEntry,
        ...(patchFile && this.checkpointEntryMetadataFromPatchFile(patchFile)),
      };
    });
  }

  private sanitizeCheckpoint(raw: Record<string, unknown>): GitAiCheckpoint {
    const { transcript: _transcript, ...rest } = raw;

    if (
      rest.agent_metadata &&
      typeof rest.agent_metadata === 'object' &&
      rest.agent_metadata !== null
    ) {
      const metadata = rest.agent_metadata as Record<string, unknown>;
      if (typeof metadata.transcript_path === 'string') {
        metadata.transcript_path = '[scrubbed]';
      }
      if (typeof metadata.settings_path === 'string') {
        metadata.settings_path = '[scrubbed]';
      }
    }

    const patchFiles =
      typeof rest.diff === 'string' ? parseGitPatchMetadata(rest.diff) : [];
    if (patchFiles.length > 0) {
      rest.diff_metadata_version = DIFF_METADATA_VERSION;
      rest.hash_version = DIFF_HASH_VERSION;
    }
    rest.entries = this.sanitizeCheckpointEntries(rest.entries, patchFiles);

    return rest as unknown as GitAiCheckpoint;
  }
}

let instance: GitAiService | null = null;

export function getGitAiService(): GitAiService {
  if (!instance) {
    instance = new GitAiService();
  }
  return instance;
}
