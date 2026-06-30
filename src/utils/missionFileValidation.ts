import * as fs from 'fs';
import * as path from 'path';

import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { logException, logWarn } from '@industry/logging';
import { getFlag } from '@industry/runtime/feature-flags';

import {
  FeaturesFileSchema,
  MissionStateFileSchema,
  RuntimeCustomModelsFileSchema,
  WorkerHandoffFileSchema,
} from '@/services/mission/schemas';
import { MissionArtifactKind } from '@/utils/enums';
import { getMissionsDir } from '@/utils/getMissionsDir';
import type { MissionFileValidationResult } from '@/utils/types';

import type { ZodIssue, ZodSchema } from 'zod';

const SCHEMA_BY_KIND: Record<MissionArtifactKind, ZodSchema<unknown>> = {
  [MissionArtifactKind.Features]: FeaturesFileSchema,
  [MissionArtifactKind.State]: MissionStateFileSchema,
  [MissionArtifactKind.RuntimeCustomModels]: RuntimeCustomModelsFileSchema,
  [MissionArtifactKind.WorkerHandoff]: WorkerHandoffFileSchema,
};

// NOTE: the strings below must be STRICTLY valid JSON — no `//` or `/* */`
// comments, no trailing commas, no ellipses. The validator rejects anything
// `JSON.parse` can't parse, so an LLM that copy/pastes these snippets must
// be able to run them through `JSON.parse` unchanged. Explanatory notes
// live in `EXPECTED_NOTES_BY_KIND` and are appended outside the JSON block.
const EXPECTED_SHAPE_BY_KIND: Record<MissionArtifactKind, string> = {
  [MissionArtifactKind.Features]:
    '{\n  "features": [\n    {\n      "id": "feat-1",\n      "description": "short description",\n      "status": "pending"\n    }\n  ]\n}',
  [MissionArtifactKind.State]:
    '{\n  "missionId": "ses_xxxxxxxx",\n  "state": "running",\n  "workingDirectory": "/abs/path/to/repo",\n  "createdAt": "2024-01-01T00:00:00.000Z",\n  "updatedAt": "2024-01-01T00:00:00.000Z"\n}',
  [MissionArtifactKind.RuntimeCustomModels]: '{\n  "customModels": []\n}',
  [MissionArtifactKind.WorkerHandoff]:
    '{\n  "timestamp": "2024-01-01T00:00:00.000Z",\n  "workerSessionId": "ses_xxxxxxxx",\n  "featureId": "feat-1",\n  "handoff": {\n    "whatWasImplemented": "short summary",\n    "whatWasLeftUndone": "short summary",\n    "verification": { "commandsRun": [] },\n    "tests": { "added": [], "coverage": "none" },\n    "discoveredIssues": []\n  }\n}',
};

/**
 * Human-readable notes appended OUTSIDE the JSON shape string. Kept separate
 * so the LLM can copy the JSON block cleanly into `JSON.parse` without the
 * notes turning into a syntax error. Enumerate allowed values and mention
 * optional fields here rather than inside the JSON.
 */
const EXPECTED_NOTES_BY_KIND: Record<MissionArtifactKind, string> = {
  [MissionArtifactKind.Features]:
    'Notes: `status` must be one of "pending", "in_progress", "completed", "cancelled". ' +
    'Optional feature fields include `skillName`, `preconditions`, `expectedBehavior`, `fulfills`, and `milestone`.',
  [MissionArtifactKind.State]:
    'Notes: `state` must be one of "planning", "awaiting_input", "initializing", "running", "paused", "orchestrator_turn", "completed". ' +
    '`state.json` is system-managed — edits to it are normally rejected outright.',
  [MissionArtifactKind.RuntimeCustomModels]:
    'Notes: `customModels` is an array of ManagedCustomModel entries.',
  [MissionArtifactKind.WorkerHandoff]:
    'Notes: `handoff.tests.coverage` is a free-form string (e.g. "none", "partial", "full"). ' +
    '`discoveredIssues` is an array of DiscoveredIssue entries.',
};

const HUMAN_NAME_BY_KIND: Record<MissionArtifactKind, string> = {
  [MissionArtifactKind.Features]:
    'features.json (on-disk mission features artifact)',
  [MissionArtifactKind.State]: 'state.json (on-disk mission state artifact)',
  [MissionArtifactKind.RuntimeCustomModels]:
    'runtime-custom-models.json (on-disk runtime custom-model registry)',
  [MissionArtifactKind.WorkerHandoff]: 'worker handoff JSON artifact',
};

/**
 * Resolve `filePath` through the filesystem using realpath when possible so
 * symlinks into the missions directory can't be used to bypass validation.
 * Falls back to `path.resolve` when the target (or its parent) doesn't exist
 * yet — new file creates must still be validated.
 */
function resolvePathSafely(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    try {
      return path.join(fs.realpathSync(dir), base);
    } catch {
      return path.resolve(filePath);
    }
  }
}

function resolveMissionsDir(): string {
  const missionsDir = getMissionsDir();
  try {
    return fs.realpathSync(missionsDir);
  } catch {
    return path.resolve(missionsDir);
  }
}

/**
 * Classify `filePath` against the known on-disk mission artifact layout.
 * Returns `null` if the path is not a mission artifact we validate — in
 * that case callers should pass the write through unchanged.
 */
export function getMissionArtifactKind(
  filePath: string
): MissionArtifactKind | null {
  try {
    const resolvedMissions = resolveMissionsDir();
    const resolvedFilePath = resolvePathSafely(filePath);

    const inMissionsDir =
      resolvedFilePath === resolvedMissions ||
      resolvedFilePath.startsWith(resolvedMissions + path.sep);
    if (!inMissionsDir) return null;

    const basename = path.basename(resolvedFilePath);
    const parentDirName = path.basename(path.dirname(resolvedFilePath));

    if (basename === 'features.json') return MissionArtifactKind.Features;
    if (basename === 'state.json') return MissionArtifactKind.State;
    if (basename === 'runtime-custom-models.json') {
      return MissionArtifactKind.RuntimeCustomModels;
    }
    if (parentDirName === 'handoffs' && basename.endsWith('.json')) {
      return MissionArtifactKind.WorkerHandoff;
    }

    return null;
  } catch (error) {
    logException(error, 'Error classifying mission artifact', { filePath });
    return null;
  }
}

/**
 * Whether the mission-artifact write guard is currently enabled for this
 * process. Gated by `IndustryFeatureFlags.ValidateMissionArtifactWrites` so
 * we can roll it out gradually and collect telemetry on how often the LLM
 * would have corrupted on-disk artifacts before it becomes a hard default.
 */
export function isMissionArtifactWriteGuardEnabled(): boolean {
  try {
    return getFlag(IndustryFeatureFlags.ValidateMissionArtifactWrites);
  } catch (error) {
    logException(
      error,
      '[MissionFileValidation] Failed to read feature flag; defaulting to disabled'
    );
    return false;
  }
}

function summarizeIssues(issues: ZodIssue[]): string {
  const shown = issues.slice(0, 8);
  const lines = shown.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `- ${where}: ${issue.message}`;
  });
  const overflow = issues.length - shown.length;
  if (overflow > 0) {
    lines.push(`- (+${overflow} more issue${overflow === 1 ? '' : 's'})`);
  }
  return lines.join('\n');
}

/**
 * Coerce any `milestone` field whose value is a `number` (or `boolean`) into
 * its string form so the schema's `z.string()` constraint accepts it. LLMs
 * occasionally write `"milestone": 1` instead of `"milestone": "1"` — that's
 * a purely cosmetic difference that shouldn't block the write. Mutates the
 * input in place for simplicity; callers pass a freshly-parsed JSON value so
 * mutation is safe.
 */
function coerceMilestoneToStringInPlace(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) coerceMilestoneToStringInPlace(item);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === 'milestone') {
      const m = record[key];
      if (typeof m === 'number' || typeof m === 'boolean') {
        record[key] = String(m);
        continue;
      }
    }
    coerceMilestoneToStringInPlace(record[key]);
  }
}

/**
 * For `features.json` we accept the legacy bare-array shape (`[ ...features ]`)
 * for backward compatibility with older CLI writers — `MissionFileService`
 * normalises bare arrays into `{ features: [...] }` at read time. The
 * canonical schema only accepts the wrapper shape, so wrap before validating
 * so that an LLM that happens to write a bare array doesn't get rejected on
 * a purely cosmetic difference.
 *
 * For `features.json` and worker-handoff artifacts we additionally coerce
 * any numeric `milestone` field to its string form (see
 * `coerceMilestoneToStringInPlace`).
 */
function normalizeParsedForKind(
  kind: MissionArtifactKind,
  parsed: unknown
): unknown {
  let working: unknown = parsed;
  if (kind === MissionArtifactKind.Features && Array.isArray(parsed)) {
    working = { features: parsed };
  }
  if (
    kind === MissionArtifactKind.Features ||
    kind === MissionArtifactKind.WorkerHandoff
  ) {
    coerceMilestoneToStringInPlace(working);
  }
  return working;
}

/**
 * Validate that `content` conforms to the on-disk schema for the mission
 * artifact at `filePath`. Returns `{ ok: true }` when the file isn't a
 * mission artifact, or when the content parses and passes the schema.
 *
 * When the content doesn't conform, returns `{ ok: false, llmError }` with
 * an actionable, LLM-facing message listing the specific violations and
 * the expected shape. Callers MUST NOT persist the content in that case.
 */
export function validateMissionFileContent(
  filePath: string,
  content: string
): MissionFileValidationResult {
  const kind = getMissionArtifactKind(filePath);
  if (kind === null) return { ok: true };

  // Gate the entire validator behind the feature flag so we can roll this
  // out gradually. When the flag is off, we silently pass the write through
  // (preserves pre-#974 behaviour) and do NOT logWarn — the log fires only
  // when we actually return an error back to the LLM.
  if (!isMissionArtifactWriteGuardEnabled()) return { ok: true };

  const artifactLabel = HUMAN_NAME_BY_KIND[kind];
  const expectedShape = EXPECTED_SHAPE_BY_KIND[kind];
  const expectedNotes = EXPECTED_NOTES_BY_KIND[kind];
  // `getMissionsDir()` resolves to `~/.industry/missions/` in prod but can
  // return `~/.industry-dev/missions/` in dev builds. Render the actual path
  // so the LLM sees a message that matches its environment.
  const missionsDirHint = (() => {
    try {
      return getMissionsDir();
    } catch {
      return '<missions directory>';
    }
  })();

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logWarn(
      '[MissionFileValidation] Blocked mission artifact write: invalid JSON',
      {
        filePath,
        // `missionArtifactFileKind` is the artifact type (features/state/...),
        // `missionArtifactFailureKind` is why it failed (parse/schema/io).
        // Split so log queries can group on either dimension unambiguously.
        missionArtifactFileKind: kind,
        missionArtifactFailureKind: 'parse',
        // `cause` and `issuesJson` are both in the metadata redaction list,
        // so error detail never reaches telemetry unredacted.
        cause: error,
      }
    );
    return {
      ok: false,
      llmError:
        `Refusing to write ${artifactLabel} at "${filePath}": the new content is not valid JSON (${errMsg}). ` +
        `Mission artifacts under ${missionsDirHint} must be valid, parseable JSON. ` +
        `Re-read the existing file to see the current shape, apply your edit in memory, and retry with valid JSON.\n\n` +
        `Expected shape:\n${expectedShape}\n\n${expectedNotes}`,
    };
  }

  const normalized = normalizeParsedForKind(kind, parsed);
  const schema = SCHEMA_BY_KIND[kind];
  const result = schema.safeParse(normalized);
  if (result.success) return { ok: true };

  logWarn(
    '[MissionFileValidation] Blocked mission artifact write: schema violation',
    {
      filePath,
      missionArtifactFileKind: kind,
      missionArtifactFailureKind: 'schema',
      // Fully redacted by `redactMetadata` (replaced with `[redacted]`) per
      // #974 — Zod issue messages may echo back user-authored fragments from
      // the rejected content and secret scrubbing alone is not enough.
      issuesJson: JSON.stringify(result.error.issues.slice(0, 8)),
    }
  );

  return {
    ok: false,
    llmError:
      `Refusing to write ${artifactLabel} at "${filePath}": the new content does not match the expected on-disk schema. ` +
      `This file is consumed by the CLI's mission scheduler and must conform exactly, otherwise the mission will pause with a ParseError.\n\n` +
      `Schema violations:\n${summarizeIssues(result.error.issues)}\n\n` +
      `Expected shape:\n${expectedShape}\n\n${expectedNotes}\n\n` +
      `Re-read the existing file, apply your edit in memory, and retry with content that matches this schema. ` +
      `If you are trying to change system-managed fields (e.g. "status" / "workerSessionIds" in features.json, or anything in state.json), those are normally managed by MissionFileService and may be blocked entirely — use the mission-control flow instead of editing the file directly.`,
  };
}
