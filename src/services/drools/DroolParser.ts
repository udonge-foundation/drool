import * as yaml from 'js-yaml';

import { ModelID } from '@industry/drool-sdk-ext/protocol/llm';
import { logInfo } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { mapClaudeCodeToolsString } from '@industry/utils/skills';

import { ParsedDrool } from '@/services/drools/types';

import type { DroolMetadata, DroolToolConfig } from '@industry/common/settings';

const FRONTMATTER_REGEX = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

/**
 * Enhanced parser for drool markdown files with YAML frontmatter
 */
export class DroolParser {
  private static readonly KNOWN_METADATA_KEYS = new Set([
    'name',
    'description',
    'model',
    'reasoningEffort',
    'tools',
    'mcpServers',
    'color',
    'version',
    'createdAt',
    'updatedAt',
  ]);

  /**
   * Parse a drool markdown file with YAML frontmatter.
   * Requires availableModels to validate model names against feature flags.
   *
   * @param content - The markdown content to parse
   * @param availableModels - Models available based on feature flags (required)
   */
  static parse(content: string, availableModels: ModelID[]): ParsedDrool {
    const { frontmatter, body } = this.extractSections(content);
    const rawMetadata = this.parseFrontmatter(frontmatter);
    const systemPrompt = body.trim();

    if (!systemPrompt) {
      throw new MetaError('System prompt cannot be empty');
    }

    // Extract and validate metadata
    const metadata = this.extractMetadata(rawMetadata, availableModels);

    return {
      metadata,
      systemPrompt,
      rawMetadata,
    };
  }

  /**
   * Stringify a drool to markdown with YAML frontmatter
   */
  static stringify(systemPrompt: string, metadata: DroolMetadata): string {
    // Prepare metadata for YAML serialization
    const yamlMetadata: Record<string, unknown> = {};

    // Only include defined fields
    if (metadata.name) yamlMetadata.name = metadata.name;
    if (metadata.description) yamlMetadata.description = metadata.description;
    if (metadata.model) yamlMetadata.model = metadata.model;
    if (metadata.reasoningEffort) {
      yamlMetadata.reasoningEffort = metadata.reasoningEffort;
    }

    // Convert tools to comma-separated string format for consistency with Claude Code format
    if (metadata.tools) {
      if (Array.isArray(metadata.tools)) {
        // Convert array to comma-separated string
        yamlMetadata.tools = metadata.tools.join(', ');
      } else if (typeof metadata.tools === 'string') {
        // Keep string as-is (could be a category or already comma-separated)
        yamlMetadata.tools = metadata.tools;
      }
    }

    if (metadata.mcpServers !== undefined) {
      yamlMetadata.mcpServers = metadata.mcpServers;
    }

    if (metadata.version) yamlMetadata.version = metadata.version;

    // Generate YAML frontmatter
    const yamlContent = yaml.dump(yamlMetadata, {
      lineWidth: -1, // Don't wrap lines
      quotingType: '"', // Use double quotes
      forceQuotes: false, // Only quote when necessary
    });

    // Combine frontmatter and content
    return `---\n${yamlContent}---\n\n${systemPrompt}`;
  }

  /**
   * Map Claude Code model names to ModelID values
   * Preserves custom models (those starting with 'custom:')
   */
  private static mapClaudeCodeModel(
    model: string,
    availableModels: ModelID[]
  ): string {
    const allModels = ['inherit', ...availableModels];
    if (allModels.includes(model)) {
      return model;
    }

    // Preserve custom models - don't try to map them
    if (model.startsWith('custom:')) {
      return model;
    }

    const modelLower = model.toLowerCase();
    const claudeModels = ['sonnet', 'opus', 'haiku'];

    // Try Claude-specific models first
    for (const option of availableModels) {
      const optionLower = option.toLowerCase();
      const matchedModel = claudeModels.find(
        (claude) => modelLower.includes(claude) && optionLower.includes(claude)
      );

      if (matchedModel) {
        logInfo('Mapped claude model', { before: model, after: option });
        return option;
      }
    }

    // Try general substring matching
    for (const option of availableModels) {
      const optionLower = option.toLowerCase();
      if (
        optionLower.includes(modelLower) ||
        modelLower.includes(optionLower)
      ) {
        logInfo('Mapped model', { before: model, after: option });
        return option;
      }
    }

    logInfo('No model match found, using inherit', { value: model });
    return 'inherit';
  }

  /**
   * Extract DroolMetadata from raw parsed YAML
   */
  private static extractMetadata(
    raw: Record<string, unknown>,
    availableModels: ModelID[]
  ): DroolMetadata {
    const metadata: DroolMetadata = { name: '' };

    // Extract name (required)
    if (typeof raw.name === 'string') {
      metadata.name = raw.name;
    } else {
      throw new MetaError('Invalid drool content: missing name in metadata');
    }

    // Extract optional fields
    if (typeof raw.description === 'string') {
      metadata.description = raw.description;
    }

    // Handle model field
    if (raw.model === undefined) {
      metadata.model = 'inherit';
    } else if (typeof raw.model === 'string') {
      // Map Claude Code model names (sonnet, opus, haiku) to available ModelID values
      const mappedModel = this.mapClaudeCodeModel(raw.model, availableModels);
      metadata.model = mappedModel as DroolMetadata['model'];
    } else {
      throw new MetaError('Invalid model type in metadata');
    }

    // Handle reasoning effort field
    if (raw.reasoningEffort !== undefined) {
      if (typeof raw.reasoningEffort === 'string') {
        metadata.reasoningEffort =
          raw.reasoningEffort as DroolMetadata['reasoningEffort'];
      } else {
        throw new MetaError('Invalid reasoningEffort type in metadata');
      }
    }

    // Handle tools field
    if (raw.tools !== undefined) {
      if (typeof raw.tools === 'string') {
        if (raw.tools.includes(',')) {
          metadata.tools = mapClaudeCodeToolsString(raw.tools);
        } else if (raw.tools === 'all') {
          metadata.tools = undefined;
        } else {
          metadata.tools = raw.tools as DroolToolConfig;
        }
      } else if (Array.isArray(raw.tools)) {
        const validTools = raw.tools.every((t) => typeof t === 'string');
        if (!validTools) {
          throw new MetaError('Tools array must contain only strings');
        }
        metadata.tools = raw.tools as string[];
      } else {
        throw new MetaError('Invalid tools type in metadata', {
          value: raw.tools,
        });
      }
    }

    if (raw.mcpServers !== undefined) {
      if (typeof raw.mcpServers === 'string') {
        metadata.mcpServers = raw.mcpServers
          .split(',')
          .map((server) => server.trim())
          .filter((server) => server.length > 0);
      } else if (
        Array.isArray(raw.mcpServers) &&
        raw.mcpServers.every((server) => typeof server === 'string')
      ) {
        metadata.mcpServers = raw.mcpServers;
      } else {
        throw new MetaError('MCP servers must be an array of strings');
      }
    }

    // Extract timestamps
    if (typeof raw.createdAt === 'string') {
      metadata.createdAt = raw.createdAt;
    }
    if (typeof raw.updatedAt === 'string') {
      metadata.updatedAt = raw.updatedAt;
    }

    // Extract version
    if (typeof raw.version === 'string') {
      metadata.version = raw.version;
    }

    return metadata;
  }

  /**
   * Validate that a string contains valid frontmatter structure
   */
  static hasValidFrontmatter(content: string): boolean {
    return FRONTMATTER_REGEX.test(content);
  }

  private static extractSections(content: string): {
    frontmatter: string;
    body: string;
  } {
    const match = content.match(FRONTMATTER_REGEX);
    if (match) {
      return {
        frontmatter: match[1],
        body: content.slice(match[0].length),
      };
    }

    // Handle legacy format without --- markers
    const lines = content.split('\n');
    const yamlLines: string[] = [];
    let bodyStartIndex = 0;
    const yamlKeyPattern =
      /^(name|description|model|reasoningEffort|tools|mcpServers|version|color|createdAt|updatedAt):\s*/i;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (i === 0 && !yamlKeyPattern.test(line)) {
        break;
      }

      if (line.trim() === '') {
        if (yamlLines.length > 0) {
          bodyStartIndex = i + 1;
          break;
        }
      } else if (yamlKeyPattern.test(line)) {
        yamlLines.push(line);
      } else if (
        yamlLines.length > 0 &&
        (line.startsWith('  ') || line.startsWith('\t'))
      ) {
        yamlLines.push(line);
      } else if (yamlLines.length > 0) {
        bodyStartIndex = i;
        break;
      }
    }

    if (yamlLines.length > 0) {
      logInfo('Detected legacy format without --- markers', {
        count: yamlLines.length,
        index: bodyStartIndex,
      });
      return {
        frontmatter: yamlLines.join('\n'),
        body: lines.slice(bodyStartIndex).join('\n').trim(),
      };
    }

    return {
      frontmatter: '',
      body: content,
    };
  }

  private static parseFrontmatter(
    frontmatter: string
  ): Record<string, unknown> {
    if (!frontmatter.trim()) {
      return {};
    }

    // Try strict YAML parsing first
    try {
      const parsed = yaml.load(frontmatter);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (error) {
      logInfo('Falling back to simplified parser', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Fall back to simplified parser for complex multi-line descriptions
    const simplified = this.parseSimplifiedFrontmatter(frontmatter);

    if (
      typeof simplified.name === 'string' &&
      simplified.name.trim().length > 0
    ) {
      return simplified;
    }

    throw new MetaError(
      'Invalid YAML frontmatter - missing required name field'
    );
  }

  private static parseSimplifiedFrontmatter(
    frontmatter: string
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};
    const lines = frontmatter.split(/\r?\n/);
    const KNOWN_KEYS = [
      'name',
      'description',
      'model',
      'reasoningEffort',
      'tools',
      'mcpServers',
      'color',
      'version',
      'createdAt',
      'updatedAt',
    ];

    let currentKey: string | null = null;
    let currentLines: string[] = [];

    const saveCurrentField = () => {
      if (currentKey && currentLines.length > 0) {
        const meaningfulLines = currentLines.filter(
          (line) => line.trim().length > 0
        );
        if (
          (currentKey === 'tools' || currentKey === 'mcpServers') &&
          meaningfulLines.length > 0 &&
          meaningfulLines.every((line) => line.trim().startsWith('- '))
        ) {
          metadata[currentKey] = meaningfulLines.map((line) => {
            let item = line.trim().slice(2).trim();
            if (
              (item.startsWith('"') && item.endsWith('"')) ||
              (item.startsWith("'") && item.endsWith("'"))
            ) {
              item = item.slice(1, -1);
            }
            return item;
          });
          return;
        }

        let value = currentLines.join('\n').trim();

        // Remove quotes if present
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1).trim();
        }

        // Convert comma-separated list fields to arrays
        if (
          (currentKey === 'tools' || currentKey === 'mcpServers') &&
          value.includes(',')
        ) {
          metadata[currentKey] = value
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t.length > 0);
        } else {
          metadata[currentKey] = value;
        }
      }
    };

    for (const line of lines) {
      let isNewKey = false;
      let newKey: string | null = null;
      let newValue = '';

      for (const key of KNOWN_KEYS) {
        const pattern = new RegExp(`^${key}:\\s*(.*)`, 'i');
        const match = line.match(pattern);
        if (match) {
          isNewKey = true;
          newKey = key;
          newValue = match[1] || '';
          break;
        }
      }

      if (isNewKey && newKey) {
        saveCurrentField();
        currentKey = newKey;
        currentLines = newValue ? [newValue] : [];
      } else if (currentKey) {
        currentLines.push(line);
      }
    }

    saveCurrentField();
    return metadata;
  }
}
