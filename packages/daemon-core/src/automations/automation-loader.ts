/**
 * Automation loader for daemon-core.
 *
 * This module provides the daemon-side automation discovery and loading
 * capabilities. It re-exports the core discovery primitives from drool-core
 * and adds daemon-specific functionality for managing automation state.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

import {
  AUTOMATION_HEARTBEAT_FILE,
  AUTOMATION_VISUAL_FILE,
  AUTOMATION_MEMORY_DIR,
  AUTOMATION_REPORTS_DIR,
  AutomationsHeartbeatSchema,
  type AutomationDescriptor,
  type AutomationDiscoveryResult,
  type AutomationsHeartbeat,
  type ValidAutomationDescriptor,
} from '@industry/common/automations';
import { getAutomationsPath } from '@industry/drool-core/automations';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { isErrnoException } from '@industry/utils/errors';

import { writeAutomationState } from './automation-state';

import type {
  CreateAutomationScaffoldOptions,
  MutateAutomationHeartbeatOptions,
  ReconcileAutomationHeartbeatConfig,
} from './types';

// =============================================================================
// File System Helpers
// =============================================================================

async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

/**
 * Create the directory scaffold for a new automation.
 *
 * Creates the following structure:
 * ```
 * .industry/automations/<id>/
 * ├── HEARTBEAT.md      # With provided config as frontmatter
 * ├── VISUAL.html       # Empty placeholder
 * ├── memory/           # Empty directory
 * └── reports/          # Empty directory
 * ```
 *
 * @throws Error if automation directory already exists
 * @throws Error if write would occur outside target automation directory
 */
export async function createAutomationScaffold(
  options: CreateAutomationScaffoldOptions
): Promise<string> {
  const {
    id,
    uuid,
    name,
    description,
    instructions,
    schedule,
    model,
    basePath,
    industryDirName = '.industry',
    visualDescription,
    memoryStrategy,
  } = options;

  // Validate ID (no path traversal)
  if (id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
    throw new MetaError('Invalid automation ID', { name: id });
  }
  if (
    industryDirName.includes('/') ||
    industryDirName.includes('\\') ||
    industryDirName === '.' ||
    industryDirName === '..'
  ) {
    throw new MetaError('Invalid Industry directory name', {
      name: industryDirName,
    });
  }

  const automationsPath = getAutomationsPath(basePath, industryDirName);
  const automationPath = path.join(automationsPath, id);

  // Security: Verify we're writing to the correct location
  const resolvedAutomationPath = path.resolve(automationPath);
  const resolvedAutomationsPath = path.resolve(automationsPath);
  if (!resolvedAutomationPath.startsWith(resolvedAutomationsPath + path.sep)) {
    throw new MetaError(
      'Security violation: Attempted write outside automation directory'
    );
  }

  // Check if automation already exists
  try {
    await fs.promises.stat(automationPath);
    throw new MetaError('Automation already exists', { name: id });
  } catch (error) {
    if (!(isErrnoException(error) && error.code === 'ENOENT')) {
      logWarn('Failed to check automation path', { cause: error });
      throw error;
    }
    // Directory doesn't exist, which is what we want
  }

  // Create automation directory
  await ensureDirectory(automationPath);

  // Create HEARTBEAT.md with frontmatter. Emit it with js-yaml (the same
  // library the read/update path uses) so values like cron schedules starting
  // with `*` or names containing quotes round-trip safely.
  const heartbeatFrontmatter: AutomationsHeartbeat = {
    name,
    ...(description ? { description } : {}),
    schedule,
    ...(model ? { model } : {}),
  };
  const frontmatter = [
    '---',
    yaml.dump(heartbeatFrontmatter, { lineWidth: -1 }).trimEnd(),
    '---',
    '',
    '# Heartbeat',
    '',
    instructions ?? 'Your automation prompt goes here.',
    '',
    // Optional guidance sections become part of the per-run prompt so the
    // agent honors them on every heartbeat run.
    ...(visualDescription
      ? ['## Visualization', '', visualDescription, '']
      : []),
    ...(memoryStrategy
      ? ['## Memory & Evolution', '', memoryStrategy, '']
      : []),
  ].join('\n');

  await fs.promises.writeFile(
    path.join(automationPath, AUTOMATION_HEARTBEAT_FILE),
    frontmatter
  );

  // Create empty VISUAL.html placeholder
  const visualPlaceholder = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>${name}</title>`,
    '</head>',
    '<body>',
    '  <p>No visual output yet. Run the automation to generate output.</p>',
    '</body>',
    '</html>',
  ].join('\n');

  await fs.promises.writeFile(
    path.join(automationPath, AUTOMATION_VISUAL_FILE),
    visualPlaceholder
  );

  // Create empty directories
  await ensureDirectory(path.join(automationPath, AUTOMATION_MEMORY_DIR));
  await ensureDirectory(path.join(automationPath, AUTOMATION_REPORTS_DIR));

  // Persist the stable backend UUID so the automation's local id matches its
  // Firestore record instead of a freshly minted one on first load. Remote
  // (computer) scaffolds always pass this; local scaffolds mint lazily.
  if (uuid) {
    writeAutomationState(automationPath, { id: uuid });
  }

  return automationPath;
}

/**
 * Read-modify-write primitive for an automation's HEARTBEAT.md. Centralizes the
 * frontmatter parsing/serialization shared by the per-field daemon edit RPCs
 * (prompt, schedule, model, privacy, rename) and the backend reconcile.
 *
 * - `mutateFrontmatter` parses + re-serializes the frontmatter; when omitted the
 *   existing frontmatter block is preserved verbatim.
 * - `body` replaces the markdown body; when omitted the existing body (and its
 *   exact whitespace) is preserved.
 * - `rejectSymlink` opts into a symlink guard for client-driven edits.
 *
 * Throws when the file is missing or has no frontmatter; callers translate that
 * into their own result/error shape.
 */
export async function mutateAutomationHeartbeat(
  automationPath: string,
  options: MutateAutomationHeartbeatOptions
): Promise<void> {
  const heartbeatPath = path.join(automationPath, AUTOMATION_HEARTBEAT_FILE);

  if (options.rejectSymlink) {
    const stats = await fs.promises.lstat(heartbeatPath);
    if (stats.isSymbolicLink()) {
      throw new MetaError('HEARTBEAT.md must not be a symlink');
    }
  }

  const content = await fs.promises.readFile(heartbeatPath, 'utf-8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) {
    throw new MetaError('No frontmatter found in HEARTBEAT.md');
  }

  let frontmatterBlock = match[1];
  if (options.mutateFrontmatter) {
    const frontmatter = AutomationsHeartbeatSchema.parse(yaml.load(match[1]));
    options.mutateFrontmatter(frontmatter);
    frontmatterBlock = yaml.dump(frontmatter, { lineWidth: -1 }).trimEnd();
  }

  const newContent =
    options.body !== undefined
      ? `---\n${frontmatterBlock}\n---\n\n${options.body.trim()}\n`
      : `---\n${frontmatterBlock}\n---${content.slice(match[0].length)}`;

  await fs.promises.writeFile(heartbeatPath, newContent, 'utf-8');
}

/**
 * Rewrite an existing automation's HEARTBEAT.md so its config matches the
 * backend record. Used to reconcile a computer automation whose cloud config
 * was edited in the UI while the file is the source of truth: backend-owned
 * frontmatter fields are overwritten (file-only fields like `workingDirectory`
 * and the persisted `id` survive via {@link mutateAutomationHeartbeat}) and the
 * body is replaced with the backend prompt.
 *
 * Unlike {@link createAutomationScaffold} this does not create the directory or
 * sibling files; the caller guarantees the automation already exists on disk.
 */
export async function reconcileAutomationHeartbeat(
  automationPath: string,
  config: ReconcileAutomationHeartbeatConfig
): Promise<void> {
  await mutateAutomationHeartbeat(automationPath, {
    body: config.prompt,
    mutateFrontmatter: (frontmatter) => {
      frontmatter.name = config.name;
      frontmatter.schedule = config.schedule;
      if (config.description) {
        frontmatter.description = config.description;
      } else {
        delete frontmatter.description;
      }
      if (config.model) {
        frontmatter.model = config.model;
      } else {
        delete frontmatter.model;
      }
      if (config.tags !== undefined) {
        frontmatter.tags = config.tags;
      }
      if (config.privacyLevel !== undefined) {
        frontmatter.privacyLevel = config.privacyLevel;
      }
      if (config.paused !== undefined) {
        frontmatter.paused = config.paused;
      }
    },
  });
}

/**
 * Resolve a path to its real filesystem location.
 *
 * Uses fs.realpathSync to resolve symlinks. If the path doesn't exist,
 * resolves the longest existing prefix and appends the remaining path.
 * This ensures consistent resolution even for paths that don't exist yet.
 *
 * @param targetPath - Path to resolve
 * @returns Real filesystem path with symlinks resolved
 */
function resolveRealPath(targetPath: string): string {
  // First normalize the path to handle . and ..
  const normalizedPath = path.resolve(targetPath);

  try {
    // Try to resolve the full path (works if it exists)
    return fs.realpathSync(normalizedPath);
  } catch (err) {
    logWarn('Path does not exist, resolving longest existing prefix', {
      cause: err,
    });
    // Path doesn't exist - find the longest existing prefix and resolve that
    // Then append the non-existent suffix
    const parts = normalizedPath.split(path.sep);
    let existingPath = '';
    let remainingParts: string[] = [];

    // Start from root and find the longest existing prefix
    for (let i = 0; i < parts.length; i++) {
      const testPath =
        parts.slice(0, i + 1).join(path.sep) || (path.sep === '/' ? '/' : '');
      try {
        fs.realpathSync(testPath);
        existingPath = testPath;
        remainingParts = parts.slice(i + 1);
      } catch (innerErr) {
        // This part doesn't exist, stop here
        logWarn('Path segment does not exist, stopping resolution', {
          cause: innerErr,
        });
        break;
      }
    }

    if (existingPath) {
      // Resolve the existing part and append the rest
      const resolvedExisting = fs.realpathSync(existingPath);
      return path.join(resolvedExisting, ...remainingParts);
    }

    // Nothing exists (shouldn't happen for absolute paths), fall back
    return normalizedPath;
  }
}

/**
 * Check if a path is within an automation directory.
 *
 * This is used to enforce isolation - writes during automation execution
 * should only occur within the automation's own directory.
 *
 * SECURITY: Uses fs.realpathSync to resolve symlinks and prevent symlink-based
 * escape attacks where a symlink inside the automation directory points to
 * files outside. The check compares the resolved real paths, not logical paths.
 *
 * @param targetPath - The path being written to
 * @param automationPath - The root path of the automation
 * @returns true if targetPath is within automationPath (after symlink resolution)
 */
export function isWithinAutomationDirectory(
  targetPath: string,
  automationPath: string
): boolean {
  // Resolve symlinks to get the real filesystem paths
  const resolvedTarget = resolveRealPath(targetPath);
  const resolvedAutomation = resolveRealPath(automationPath);

  // Check if target starts with automation path followed by separator
  return (
    resolvedTarget === resolvedAutomation ||
    resolvedTarget.startsWith(resolvedAutomation + path.sep)
  );
}

/**
 * Get automation by ID from a discovery result.
 */
export function getAutomationById(
  result: AutomationDiscoveryResult,
  id: string
): AutomationDescriptor | undefined {
  return result.automations.find((a) => a.id === id);
}

/**
 * Get only valid automations from a discovery result.
 */
export function getValidAutomations(
  result: AutomationDiscoveryResult
): ValidAutomationDescriptor[] {
  return result.automations.filter(
    (a): a is ValidAutomationDescriptor => a.isValid
  );
}
