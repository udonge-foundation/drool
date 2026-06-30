import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

import {
  AUTOMATION_HEARTBEAT_FILE,
  AUTOMATION_VISUAL_FILE,
  AUTOMATION_MEMORY_DIR,
  AUTOMATION_REPORTS_DIR,
  AUTOMATION_STATE_FILE,
  AutomationPrivacyLevel,
  AutomationScheduleCadence,
  AutomationValidationIssueType,
  type AutomationConfig,
  type AutomationDescriptor,
  type AutomationSchedule,
  type AutomationStructure,
  type AutomationValidationIssue,
  type InvalidAutomationDescriptor,
  type ValidAutomationDescriptor,
  isValidCronExpression,
} from '@industry/common/automations';
import { logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { toAutomationTemplateId } from '@industry/utils/automations';

// =============================================================================
// File System Helpers
// =============================================================================

export async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(dirPath);
    return stats.isDirectory();
  } catch (err) {
    logWarn('Automation directory existence check failed', { cause: err });
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isFile();
  } catch (err) {
    logWarn('Automation file existence check failed', { cause: err });
    return false;
  }
}

// =============================================================================
// Frontmatter Parsing
// =============================================================================

function parseFrontmatter(content: string): {
  metadata: Record<string, unknown>;
  body: string;
} {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  const match = frontmatterRegex.exec(content);

  if (!match) {
    return { metadata: {}, body: content };
  }

  const frontmatterContent = match[1];
  const body = content.substring(match[0].length);

  try {
    const parsed = yaml.load(frontmatterContent);
    if (typeof parsed === 'object' && parsed !== null) {
      return { metadata: parsed as Record<string, unknown>, body };
    }
  } catch (err) {
    // YAML parsing failed
    logWarn('YAML frontmatter parsing failed', { cause: err });
  }

  return { metadata: {}, body: content };
}

// =============================================================================
// Schedule Validation
// =============================================================================

const VALID_CADENCES = Object.values(AutomationScheduleCadence);

function parseSchedule(value: unknown): AutomationSchedule | null {
  if (typeof value === 'string') {
    if (VALID_CADENCES.includes(value as AutomationScheduleCadence)) {
      return { cadence: value as AutomationScheduleCadence };
    }
    if (isValidCronExpression(value)) {
      return { cadence: value };
    }
    return null;
  }

  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.cadence === 'string') {
      return parseSchedule(obj.cadence);
    }
  }

  return null;
}

// =============================================================================
// Automation Structure Detection
// =============================================================================

async function detectAutomationStructure(
  automationPath: string
): Promise<Partial<AutomationStructure>> {
  const [hasHeartbeat, hasVisual, hasMemoryDir, hasReportsDir] =
    await Promise.all([
      fileExists(path.join(automationPath, AUTOMATION_HEARTBEAT_FILE)),
      fileExists(path.join(automationPath, AUTOMATION_VISUAL_FILE)),
      directoryExists(path.join(automationPath, AUTOMATION_MEMORY_DIR)),
      directoryExists(path.join(automationPath, AUTOMATION_REPORTS_DIR)),
    ]);

  return {
    hasHeartbeat,
    hasVisual,
    hasMemoryDir,
    hasReportsDir,
  };
}

// =============================================================================
// Configuration Parsing
// =============================================================================

async function parseAutomationConfig(automationPath: string): Promise<{
  config: Partial<AutomationConfig> | null;
  issues: AutomationValidationIssue[];
}> {
  const heartbeatPath = path.join(automationPath, AUTOMATION_HEARTBEAT_FILE);
  const issues: AutomationValidationIssue[] = [];

  if (!(await fileExists(heartbeatPath))) {
    issues.push({
      type: AutomationValidationIssueType.MissingFile,
      message: `Required file ${AUTOMATION_HEARTBEAT_FILE} not found`,
      filePath: heartbeatPath,
    });
    return { config: null, issues };
  }

  let content: string;
  try {
    content = await fs.promises.readFile(heartbeatPath, 'utf-8');
  } catch (error) {
    logWarn('Failed to read automation heartbeat file', { cause: error });
    issues.push({
      type: AutomationValidationIssueType.ParseError,
      message: `Failed to read ${AUTOMATION_HEARTBEAT_FILE}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      filePath: heartbeatPath,
    });
    return { config: null, issues };
  }

  const { metadata } = parseFrontmatter(content);

  if (Object.keys(metadata).length === 0) {
    issues.push({
      type: AutomationValidationIssueType.InvalidFrontmatter,
      message: `${AUTOMATION_HEARTBEAT_FILE} missing or has invalid frontmatter`,
      filePath: heartbeatPath,
    });
    return { config: null, issues };
  }

  const config: Partial<AutomationConfig> = {};

  if (typeof metadata.id === 'string' && metadata.id.trim()) {
    config.id = metadata.id.trim();
  }

  if (typeof metadata.name === 'string' && metadata.name.trim()) {
    config.name = metadata.name.trim();
  }

  if (typeof metadata.description === 'string') {
    config.description = metadata.description;
  }

  if (typeof metadata.model === 'string' && metadata.model.trim()) {
    config.model = metadata.model.trim();
  }

  if (
    typeof metadata.workingDirectory === 'string' &&
    metadata.workingDirectory.trim()
  ) {
    config.workingDirectory = metadata.workingDirectory.trim();
  }

  if (typeof metadata.templateId === 'string') {
    const templateId = toAutomationTemplateId(metadata.templateId.trim());
    if (templateId) {
      config.templateId = templateId;
    }
  }

  if (Array.isArray(metadata.tags)) {
    const tags = metadata.tags
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim());
    if (tags.length > 0) {
      config.tags = tags;
    }
  } else if (typeof metadata.tags === 'string' && metadata.tags.trim()) {
    config.tags = [metadata.tags.trim()];
  }

  if (metadata.paused === true) {
    config.paused = true;
  }

  if (
    metadata.privacyLevel === AutomationPrivacyLevel.Organization ||
    metadata.privacyLevel === AutomationPrivacyLevel.Private
  ) {
    config.privacyLevel = metadata.privacyLevel;
  }

  if (
    metadata.createdBy != null &&
    typeof metadata.createdBy === 'object' &&
    'name' in metadata.createdBy &&
    typeof metadata.createdBy.name === 'string'
  ) {
    const cb = metadata.createdBy;
    const cbName = 'name' in cb ? String(cb.name) : '';
    const cbEmail =
      'email' in cb && typeof cb.email === 'string' ? cb.email : undefined;
    const cbAvatar =
      'avatarUrl' in cb && typeof cb.avatarUrl === 'string'
        ? cb.avatarUrl
        : undefined;
    config.createdBy = { name: cbName, email: cbEmail, avatarUrl: cbAvatar };
  }

  if (typeof metadata.forkedFrom === 'string' && metadata.forkedFrom.trim()) {
    config.forkedFrom = metadata.forkedFrom.trim();
  }

  const schedule = parseSchedule(metadata.schedule);
  if (schedule) {
    config.schedule = schedule;
  } else if (metadata.schedule !== undefined) {
    issues.push({
      type: AutomationValidationIssueType.InvalidSchedule,
      message: `Invalid schedule value: ${JSON.stringify(metadata.schedule)}. Expected 'daily', 'weekly', 'monthly', or a cron expression.`,
      filePath: heartbeatPath,
    });
  }

  if (!config.name) {
    issues.push({
      type: AutomationValidationIssueType.InvalidFrontmatter,
      message: 'Missing required field: name',
      filePath: heartbeatPath,
    });
  }

  if (
    !config.schedule &&
    !issues.some(
      (i) => i.type === AutomationValidationIssueType.InvalidSchedule
    )
  ) {
    issues.push({
      type: AutomationValidationIssueType.InvalidFrontmatter,
      message: 'Missing required field: schedule',
      filePath: heartbeatPath,
    });
  }

  return { config: Object.keys(config).length > 0 ? config : null, issues };
}

// =============================================================================
// Automation ID Resolution + HEARTBEAT → state.json Migration
// =============================================================================

/**
 * Path helper for the persistent state file (./memory/state.json).
 */
function getStateFilePath(automationPath: string): string {
  return path.join(
    automationPath,
    AUTOMATION_MEMORY_DIR,
    AUTOMATION_STATE_FILE
  );
}

/**
 * Read the automation `id` from state.json if present.
 *
 * Returns `null` when the file is missing, unparseable, or has no id. This
 * function purposefully uses a narrow read (just `id`) so it doesn't pull in
 * daemon-only dependencies (the full typed schema lives in daemon-core).
 */
async function readIdFromStateFile(
  automationPath: string
): Promise<string | null> {
  try {
    const stateFilePath = getStateFilePath(automationPath);
    const content = await fs.promises.readFile(stateFilePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.id === 'string' && parsed.id.trim()) {
      return parsed.id.trim();
    }
    return null;
  } catch (parseError) {
    logWarn('Failed to read automation id from state.json', {
      cause: parseError,
    });
    return null;
  }
}

/**
 * Type guard for Node-style errno codes, used instead of `as` casts.
 */
function hasErrnoCode(err: unknown): err is { code: string } {
  if (err === null || typeof err !== 'object' || !('code' in err)) {
    return false;
  }
  const code: unknown = err.code;
  return typeof code === 'string';
}

/**
 * Type guard narrowing an unknown JSON value to a plain object record.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reject writes whose target directory is a symlink. A malicious automation
 * directory could otherwise redirect `memory/` to another location and cause
 * the daemon to overwrite arbitrary files with the user's privileges.
 */
async function assertSafeWriteDir(dir: string): Promise<void> {
  try {
    const stat = await fs.promises.lstat(dir);
    if (stat.isSymbolicLink()) {
      throw new MetaError('Refusing to write through symlinked directory', {
        path: dir,
      });
    }
    if (!stat.isDirectory()) {
      throw new MetaError('Target is not a directory', { path: dir });
    }
  } catch (err) {
    if (hasErrnoCode(err) && err.code === 'ENOENT') {
      return;
    }
    throw err;
  }
}

/**
 * Resolve `fs.constants.O_NOFOLLOW` without an `as` cast. POSIX-only;
 * returns 0 on Windows (a no-op inside the bitmask).
 */
function getONoFollow(): number {
  const constants: Record<string, number> = fs.constants;
  const value = constants.O_NOFOLLOW;
  return typeof value === 'number' ? value : 0;
}

/**
 * Persist the automation `id` into `./memory/state.json`.
 *
 * Merges with any existing state so we don't clobber fields written by the
 * daemon poller or agent (e.g. lastRunAt, runCount). Uses symlink-safe
 * exclusive-create for the temp file to defend against path-redirection
 * attacks from untrusted automation directories.
 */
async function writeIdToStateFile(
  automationPath: string,
  id: string
): Promise<void> {
  const stateFilePath = getStateFilePath(automationPath);
  const memoryDir = path.dirname(stateFilePath);
  await fs.promises.mkdir(memoryDir, { recursive: true });
  await assertSafeWriteDir(memoryDir);

  let existing: Record<string, unknown> = {};
  try {
    const content = await fs.promises.readFile(stateFilePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (isPlainRecord(parsed)) {
      existing = { ...parsed };
    }
  } catch (readError) {
    // No existing file (ENOENT) or unparseable JSON — start fresh. Log
    // non-ENOENT failures so silent corruption is visible.
    if (hasErrnoCode(readError) && readError.code !== 'ENOENT') {
      logWarn('Failed to read state.json, starting fresh', {
        path: stateFilePath,
        cause: readError,
      });
    }
  }

  const merged = { ...existing, id };
  // Use a UUID-suffixed temp path so concurrent writers don't collide, and
  // open with O_EXCL|O_WRONLY|O_CREAT to refuse pre-existing symlinks.
  const tempPath = `${stateFilePath}.${crypto.randomUUID()}.tmp`;
  const O_NOFOLLOW = getONoFollow();
  /* eslint-disable no-bitwise */
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    O_NOFOLLOW;
  /* eslint-enable no-bitwise */
  const fd = await fs.promises.open(tempPath, flags, 0o644);
  try {
    await fd.writeFile(JSON.stringify(merged, null, 2), 'utf-8');
  } finally {
    await fd.close();
  }
  try {
    await fs.promises.rename(tempPath, stateFilePath);
  } catch (err) {
    // Best-effort cleanup of the temp file on rename failure.
    await fs.promises.unlink(tempPath).catch(() => {});
    throw err;
  }
}

/**
 * Remove the `id` key from HEARTBEAT.md frontmatter.
 *
 * Used during the HEARTBEAT → state.json migration. The rest of the
 * frontmatter (schedule, name, description, ...) is preserved. If the file
 * has no frontmatter or no `id` key, this is a no-op.
 */
async function stripIdFromHeartbeat(automationPath: string): Promise<void> {
  const heartbeatPath = path.join(automationPath, AUTOMATION_HEARTBEAT_FILE);
  const rawContent = await fs.promises.readFile(heartbeatPath, 'utf-8');
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
  const fmMatch = frontmatterRegex.exec(rawContent);
  if (!fmMatch) return;

  const existingYaml = yaml.load(fmMatch[1]);
  if (!existingYaml || typeof existingYaml !== 'object') return;

  const updatedYaml: Record<string, unknown> = { ...existingYaml };
  if (!('id' in updatedYaml)) return;
  delete updatedYaml.id;

  const newFrontmatter = yaml.dump(updatedYaml, { lineWidth: -1 }).trimEnd();
  const body = rawContent.substring(fmMatch[0].length);
  const newContent = `---\n${newFrontmatter}\n---${body}`;
  // Atomic rewrite: write to a temp file in the same directory and rename
  // into place so a crash can never leave HEARTBEAT.md truncated.
  const tempPath = `${heartbeatPath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tempPath, newContent, 'utf-8');
    await fs.promises.rename(tempPath, heartbeatPath);
  } catch (err) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw err;
  }
}

/**
 * Resolve (and persist) the stable automation `id` for a given directory.
 *
 * Resolution order, with side-effects noted:
 * 1. `./memory/state.json` has `id` → use it (no writes).
 * 2. HEARTBEAT.md frontmatter has `id` → migrate: copy to state.json, strip
 *    from HEARTBEAT so the file can be safely shared across orgs.
 * 3. Neither source has an id → mint a fresh UUID and write to state.json.
 *
 * The resolved id is assigned to `config.id`. All write failures are
 * non-fatal (the caller will retry on next discovery).
 */
async function ensureAutomationId(
  automationPath: string,
  config: Partial<AutomationConfig>
): Promise<void> {
  const heartbeatId =
    typeof config.id === 'string' && config.id.trim() ? config.id.trim() : null;

  // Prefer state.json as the canonical source.
  const stateId = await readIdFromStateFile(automationPath);
  if (stateId) {
    config.id = stateId;
    // If HEARTBEAT also carries an id (legacy), strip it so the file is
    // shareable across orgs without colliding Firestore doc IDs. We do
    // this even if the HEARTBEAT id differs from state.json -- state.json
    // wins, HEARTBEAT is authoritative only for code/schedule/description.
    if (heartbeatId) {
      try {
        await stripIdFromHeartbeat(automationPath);
        logInfo(
          '[loadAutomation] Stripped redundant id from HEARTBEAT (state.json wins)',
          { automationId: stateId }
        );
      } catch (err) {
        logWarn('Failed to strip id from HEARTBEAT', { cause: err });
      }
    }
    return;
  }

  // Migrate from HEARTBEAT if it already has an id (pre-PR-4a automations).
  if (heartbeatId) {
    try {
      await writeIdToStateFile(automationPath, heartbeatId);
      await stripIdFromHeartbeat(automationPath);
      logInfo(
        '[loadAutomation] Migrated automation id from HEARTBEAT to state.json',
        { automationId: heartbeatId }
      );
    } catch (err) {
      logWarn('Failed to migrate automation id from HEARTBEAT to state.json', {
        cause: err,
      });
    }
    config.id = heartbeatId;
    return;
  }

  // Fresh automation: mint a new UUID and persist to state.json only.
  const uuid = crypto.randomUUID();
  config.id = uuid;
  try {
    await writeIdToStateFile(automationPath, uuid);
  } catch (err) {
    // Non-fatal: UUID will be retried on next discovery
    logWarn('Failed to assign UUID to automation', { cause: err });
  }
}

// =============================================================================
// Single Automation Loading
// =============================================================================

export async function loadAutomation(
  automationPath: string
): Promise<AutomationDescriptor> {
  const id = path.basename(automationPath);
  const structure = await detectAutomationStructure(automationPath);
  const { config, issues } = await parseAutomationConfig(automationPath);

  if (config && structure.hasHeartbeat) {
    await ensureAutomationId(automationPath, config);
  }

  const hasRequiredFields =
    config !== null &&
    typeof config.name === 'string' &&
    config.schedule !== undefined;

  if (hasRequiredFields && issues.length === 0) {
    const validDescriptor: ValidAutomationDescriptor = {
      id,
      path: automationPath,
      config: config as AutomationConfig,
      isValid: true,
      structure: {
        hasHeartbeat: structure.hasHeartbeat ?? false,
        hasVisual: structure.hasVisual ?? false,
        hasMemoryDir: structure.hasMemoryDir ?? false,
        hasReportsDir: structure.hasReportsDir ?? false,
      },
    };
    return validDescriptor;
  }

  const invalidDescriptor: InvalidAutomationDescriptor = {
    id,
    path: automationPath,
    config,
    isValid: false,
    validationIssues: issues,
    structure,
  };
  return invalidDescriptor;
}
