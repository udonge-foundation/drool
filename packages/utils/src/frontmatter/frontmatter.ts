/**
 * Shared frontmatter parsing utilities for drools, skills, and other markdown files.
 *
 * Used by both PluginLoader (plugin cache) and IndustrySettingsFolder (local .industry/).
 */
import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

import {
  type CommandSource,
  type CustomCommand,
  CustomDrool,
  DroolMetadata,
  Skill,
  SkillMetadata,
} from '@industry/common/settings';
import {
  DroolLocation,
  SkillLocation,
} from '@industry/drool-sdk-ext/protocol/settings';
import { logWarn } from '@industry/logging';

import { parseDroolFrontmatter } from './parseDroolFrontmatter';
import { parseSkillFrontmatter } from './parseSkillFrontmatter';
import { parseYamlLikeFallback } from './parseYamlLikeFallback';
import { getErrorCode } from '../errors';
import { mapClaudeCodeTools } from '../skills';

// =============================================================================
// File System Helpers
// =============================================================================

function isMissingPathError(error: unknown): boolean {
  const errorCode = getErrorCode(error);
  return errorCode === 'ENOENT' || errorCode === 'ENOTDIR';
}

export async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(dirPath);
    return stats.isDirectory();
  } catch (err) {
    if (!isMissingPathError(err)) {
      logWarn('Failed to check directory existence', { cause: err });
    }
    return false;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isFile();
  } catch (err) {
    if (!isMissingPathError(err)) {
      logWarn('Failed to check file existence', { cause: err });
    }
    return false;
  }
}

/**
 * Safely convert unknown value to string.
 */
function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return undefined;
}

// =============================================================================
// Frontmatter Parsing
// =============================================================================

/**
 * Parse markdown frontmatter with YAML, falling back to line-by-line parser.
 * Handles both Unix (\n) and Windows (\r\n) line endings.
 */
export function parseFrontmatter(content: string): {
  metadata: Record<string, unknown>;
  body: string;
} {
  // Support both \n and \r\n line endings
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  const match = frontmatterRegex.exec(content);

  if (!match) {
    return { metadata: {}, body: content };
  }

  const frontmatterContent = match[1];
  const body = content.substring(match[0].length);

  // First try standard YAML parsing
  try {
    const parsed = yaml.load(frontmatterContent);
    if (typeof parsed === 'object' && parsed !== null) {
      return { metadata: parsed as Record<string, unknown>, body };
    }
  } catch (err) {
    logWarn('YAML parsing failed, trying fallback parser', { cause: err });
  }

  // Fallback to line-by-line parser for malformed YAML
  // (e.g., descriptions with unquoted colons or escaped newlines)
  try {
    const metadata = parseYamlLikeFallback(frontmatterContent);
    return { metadata, body };
  } catch (err) {
    logWarn('Failed to parse frontmatter', { cause: err });
    return { metadata: {}, body: content };
  }
}

// =============================================================================
// File Loading
// =============================================================================

/**
 * Load a drool from a markdown file.
 */
export async function loadDroolFile(
  filePath: string,
  location: DroolLocation
): Promise<CustomDrool | null> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const { metadata: rawMetadata, body } = parseFrontmatter(content);
    const { frontmatter } = parseDroolFrontmatter(content);
    const stats = await fs.promises.stat(filePath);

    const metadata: DroolMetadata = {
      name: frontmatter.name || path.basename(filePath, '.md'),
      description: frontmatter.description,
      model: frontmatter.model as DroolMetadata['model'],
      reasoningEffort:
        frontmatter.reasoningEffort as DroolMetadata['reasoningEffort'],
      tools: frontmatter.tools as DroolMetadata['tools'],
      mcpServers: frontmatter.mcpServers,
      // Extra fields from raw metadata (not in schema but used by IndustrySettingsFolder)
      createdAt: asString(rawMetadata.createdAt),
      updatedAt: asString(rawMetadata.updatedAt),
      version: asString(rawMetadata.version),
    };

    return {
      metadata,
      systemPrompt: body.trim(),
      location,
      filePath,
      lastModified: stats.mtimeMs,
      validationResult: { valid: true, errors: [], warnings: [] },
    };
  } catch (err) {
    logWarn('Failed to load drool file', { cause: err });
    return null;
  }
}

/**
 * Map allowed-tools values to Drool tool names.
 * Applies Claude Code tool name mapping (e.g. Bash -> Execute) to array values.
 * Strings are passed through as-is since they may be space-delimited (agentskills.io format).
 */
function mapAllowedTools(
  allowedTools: string | string[] | undefined
): string | string[] | undefined {
  if (!allowedTools) return undefined;
  if (Array.isArray(allowedTools)) return mapClaudeCodeTools(allowedTools);
  return allowedTools;
}

/**
 * Build a Skill object from raw SKILL.md content.
 */
export function loadSkillFromContent(
  content: string,
  location: SkillLocation,
  filePath: string,
  lastModified: number
): Skill {
  const { frontmatter, systemPrompt } = parseSkillFrontmatter(content);

  const metadata: SkillMetadata = {
    name: frontmatter.name,
    description: frontmatter.description,
    license: frontmatter.license,
    compatibility: frontmatter.compatibility,
    metadata: frontmatter.metadata,
    tools: mapAllowedTools(frontmatter['allowed-tools']) ?? frontmatter.tools,
    enabled: frontmatter.enabled,
    userInvocable: frontmatter['user-invocable'],
    disableModelInvocation: frontmatter['disable-model-invocation'],
  };

  return {
    metadata,
    systemPrompt,
    location,
    filePath,
    lastModified,
    validationResult: { valid: true, errors: [], warnings: [] },
  };
}

/**
 * Load a skill from a SKILL.md file.
 */
export async function loadSkillFile(
  filePath: string,
  location: SkillLocation
): Promise<Skill | null> {
  try {
    const exists = await fileExists(filePath);
    if (!exists) return null;

    const content = await fs.promises.readFile(filePath, 'utf-8');
    const { metadata: rawMetadata } = parseFrontmatter(content);
    const stats = await fs.promises.stat(filePath);

    const skill = loadSkillFromContent(
      content,
      location,
      filePath,
      stats.mtimeMs
    );
    skill.metadata.version = asString(rawMetadata.version);
    return skill;
  } catch (err) {
    logWarn('Failed to load skill file', { cause: err });
    return null;
  }
}

// =============================================================================
// Command File Loading
// =============================================================================

function normalizeCommandName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '');
  return base
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/--+/g, '-');
}

function getFirstNonEmptyLine(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#!')) return trimmed;
  }
  return null;
}

/**
 * Load a command from a markdown or shebang file.
 */
export async function loadCommandFile(
  filePath: string,
  source: CommandSource
): Promise<CustomCommand | null> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const firstLine = content.split(/\r?\n/, 1)[0] || '';
    const fileName = path.basename(filePath);

    const isShebang = firstLine.startsWith('#!');
    const isMarkdown = fileName.toLowerCase().endsWith('.md');

    if (!isMarkdown && !isShebang) return null;

    const { metadata, body: systemPrompt } = parseFrontmatter(content);
    const name = normalizeCommandName(fileName);
    const description =
      asString(metadata.description) ||
      getFirstNonEmptyLine(systemPrompt) ||
      name;
    const argumentHint = asString(metadata['argument-hint']);

    return {
      name,
      description,
      argumentHint,
      source,
      filePath,
      isExecutable: isShebang,
    };
  } catch (error) {
    logWarn('Failed to load command file', { path: filePath, error });
    return null;
  }
}
