import { z } from 'zod';

import { type PushGitAiNotesRequest } from '@industry/common/api/v0/git-ai';
import {
  logException,
  Metric,
  Metrics,
  type MetricLabels,
} from '@industry/logging';
import { sanitizeGitRemoteUrl } from '@industry/utils/agentReadiness';

import { getAuthHeaders } from '@/api/config';
import { fetchBackend } from '@/api/fetchBackend';
import {
  collectGitAiCommitMetadata,
  collectGitAiRepositoryMetadata,
} from '@/services/GitAiMetadata';

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

type GitAiNoteFailureReason =
  | 'stdin_read_failed'
  | 'malformed_json'
  | 'invalid_schema'
  | 'transform_failed'
  | 'unauthenticated'
  | 'no_session_ids'
  | 'http_400_validation'
  | 'http_error'
  | 'request_exception';

interface GitAiNoteGenerationOutcome {
  success: boolean;
  durationMs: number;
  failureReason?: GitAiNoteFailureReason;
  isDefaultBranch?: boolean;
  statusCode?: number;
}

export function recordGitAiNoteGenerationOutcome({
  success,
  durationMs,
  failureReason,
  isDefaultBranch,
  statusCode,
}: GitAiNoteGenerationOutcome): void {
  const labels: MetricLabels = {
    status: success ? 'success' : 'failure',
    ...(failureReason ? { failureReason } : {}),
    ...(isDefaultBranch !== undefined
      ? { isDefaultBranch: String(isDefaultBranch) }
      : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
  };

  try {
    Metrics.addToCounter(Metric.GIT_AI_NOTE_GENERATION_COUNT, 1, labels);
    Metrics.addToCounter(
      success
        ? Metric.GIT_AI_NOTE_GENERATION_SUCCESS_COUNT
        : Metric.GIT_AI_NOTE_GENERATION_FAILURE_COUNT,
      1,
      labels
    );
    Metrics.recordHistogram(
      Metric.GIT_AI_NOTE_GENERATION_LATENCY,
      durationMs,
      labels
    );
  } catch (error) {
    // Telemetry must never affect git-ai hook behavior.
    logException(error, 'Failed to record git-ai note generation telemetry');
  }
}

// ---------------------------------------------------------------------------
// Validation error formatting
// ---------------------------------------------------------------------------

const ValidationErrorBodySchema = z.object({
  message: z.string().optional(),
  errors: z
    .array(
      z.object({
        path: z.array(z.string()).optional(),
        message: z.string().optional(),
      })
    )
    .min(1),
});

export function formatValidationError(responseBody: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return null;
  }

  const result = ValidationErrorBodySchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }

  const { errors, message } = result.data;

  const fieldNames = errors
    .map((e) => (e.path && e.path.length > 0 ? e.path.join('.') : null))
    .filter((name): name is string => name !== null);

  const baseMessage = message ?? 'Validation error';

  if (fieldNames.length > 0) {
    return `Error: ${baseMessage} Missing fields: ${fieldNames.join(', ')}`;
  }

  const messages = errors
    .map((e) => e.message)
    .filter((m): m is string => m !== undefined && m !== null);

  if (messages.length > 0) {
    return `Error: ${baseMessage} ${messages.join(', ')}`;
  }

  return `Error: ${baseMessage}`;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    process.stdin.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    process.stdin.on('error', (err: Error) => {
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// noteContent parsing
// ---------------------------------------------------------------------------

const AgentIdSchema = z.object({
  tool: z.string(),
  id: z.string(),
});

const PromptEntrySchema = z.object({
  agent_id: AgentIdSchema.nullable().optional(),
});

const NoteMetadataSchema = z.object({
  prompts: z.record(PromptEntrySchema).optional(),
});

export function extractDroolSessionIds(noteContent: string): string[] {
  const dividerMatch = noteContent.match(/^---\s*$/m);
  if (!dividerMatch || dividerMatch.index === undefined) {
    return [];
  }

  const jsonSection = noteContent
    .slice(dividerMatch.index + dividerMatch[0].length)
    .trim();
  if (!jsonSection) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSection);
  } catch {
    return [];
  }

  const result = NoteMetadataSchema.safeParse(parsed);
  if (!result.success || !result.data.prompts) {
    return [];
  }

  const sessionIds = new Set<string>();
  for (const prompt of Object.values(result.data.prompts)) {
    if (
      prompt.agent_id &&
      prompt.agent_id.tool === 'drool' &&
      prompt.agent_id.id
    ) {
      sessionIds.add(prompt.agent_id.id);
    }
  }

  return [...sessionIds];
}

// ---------------------------------------------------------------------------
// stdin parsing — git-ai sends a JSON array of snake_case entries
// ---------------------------------------------------------------------------

const GitAiHookEntrySchema = z.object({
  commit_sha: z.string(),
  repo_url: z.string(),
  repo_name: z.string(),
  branch: z.string(),
  is_default_branch: z.boolean(),
  note_content: z.string(),
});

const GitAiHookPayloadSchema = z.array(GitAiHookEntrySchema).min(1);

async function transformHookEntry(
  entry: z.infer<typeof GitAiHookEntrySchema>
): Promise<PushGitAiNotesRequest> {
  const repoUrl = sanitizeGitRemoteUrl(entry.repo_url);
  const [repositoryMetadata, commitMetadata] = await Promise.all([
    collectGitAiRepositoryMetadata({
      repoUrl,
      branch: entry.branch,
      commitSha: entry.commit_sha,
    }),
    collectGitAiCommitMetadata({
      commitSha: entry.commit_sha,
      noteContent: entry.note_content,
    }),
  ]);

  return {
    commitSha: entry.commit_sha,
    repoUrl,
    repoName: entry.repo_name,
    branch: entry.branch,
    isDefaultBranch: entry.is_default_branch,
    noteContent: entry.note_content,
    ...repositoryMetadata,
    ...commitMetadata,
  };
}

// ---------------------------------------------------------------------------
// Push logic
// ---------------------------------------------------------------------------

async function pushNote(
  envelope: PushGitAiNotesRequest,
  headers: Record<string, string>
): Promise<void> {
  const startedAt = Date.now();
  const sessionIds = extractDroolSessionIds(envelope.noteContent);
  if (sessionIds.length === 0) {
    recordGitAiNoteGenerationOutcome({
      success: false,
      failureReason: 'no_session_ids',
      isDefaultBranch: envelope.isDefaultBranch,
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  const body = JSON.stringify(envelope);

  for (const sessionId of sessionIds) {
    const pushStartedAt = Date.now();
    try {
      const endpoint = `/api/sessions/${sessionId}/git-ai/notes`;
      const response = await fetchBackend(endpoint, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown');

        if (response.status === 400) {
          recordGitAiNoteGenerationOutcome({
            success: false,
            failureReason: 'http_400_validation',
            isDefaultBranch: envelope.isDefaultBranch,
            statusCode: response.status,
            durationMs: Date.now() - pushStartedAt,
          });
          const formatted = formatValidationError(errorBody);
          writeStderr(
            formatted ?? `Error: POST to ${endpoint} failed (400): ${errorBody}`
          );
          process.exit(1);
        }

        recordGitAiNoteGenerationOutcome({
          success: false,
          failureReason: 'http_error',
          isDefaultBranch: envelope.isDefaultBranch,
          statusCode: response.status,
          durationMs: Date.now() - pushStartedAt,
        });
        writeStderr(
          `Warning: POST to ${endpoint} failed (${response.status}): ${errorBody}`
        );
      } else {
        recordGitAiNoteGenerationOutcome({
          success: true,
          isDefaultBranch: envelope.isDefaultBranch,
          statusCode: response.status,
          durationMs: Date.now() - pushStartedAt,
        });
      }
    } catch (error) {
      recordGitAiNoteGenerationOutcome({
        success: false,
        failureReason: 'request_exception',
        isDefaultBranch: envelope.isDefaultBranch,
        durationMs: Date.now() - pushStartedAt,
      });
      const message = error instanceof Error ? error.message : String(error);
      writeStderr(
        `Warning: failed to push notes for session ${sessionId}: ${message}`
      );
    }
  }
}

export async function run(): Promise<void> {
  const startedAt = Date.now();
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    recordGitAiNoteGenerationOutcome({
      success: false,
      failureReason: 'stdin_read_failed',
      durationMs: Date.now() - startedAt,
    });
    writeStderr('Warning: failed to read stdin');
    process.exitCode = 0;
    return;
  }

  if (!raw.trim()) {
    process.exitCode = 0;
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    recordGitAiNoteGenerationOutcome({
      success: false,
      failureReason: 'malformed_json',
      durationMs: Date.now() - startedAt,
    });
    writeStderr('Warning: malformed JSON input');
    process.exitCode = 0;
    return;
  }

  const parseResult = GitAiHookPayloadSchema.safeParse(parsed);
  if (!parseResult.success) {
    recordGitAiNoteGenerationOutcome({
      success: false,
      failureReason: 'invalid_schema',
      durationMs: Date.now() - startedAt,
    });
    writeStderr('Warning: invalid input');
    process.exitCode = 0;
    return;
  }

  let entries: PushGitAiNotesRequest[];
  try {
    entries = await Promise.all(parseResult.data.map(transformHookEntry));
  } catch (error) {
    recordGitAiNoteGenerationOutcome({
      success: false,
      failureReason: 'transform_failed',
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }

  const headers = await getAuthHeaders();
  if (!headers.Authorization) {
    for (const envelope of entries) {
      recordGitAiNoteGenerationOutcome({
        success: false,
        failureReason: 'unauthenticated',
        isDefaultBranch: envelope.isDefaultBranch,
        durationMs: Date.now() - startedAt,
      });
    }
    writeStderr('Warning: not authenticated, skipping push');
    process.exitCode = 0;
    return;
  }

  for (const envelope of entries) {
    await pushNote(envelope, headers);
  }

  process.exitCode = 0;
}
