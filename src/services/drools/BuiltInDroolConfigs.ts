import { ComplexityTier } from '@industry/drool-core/tools/enums';
import { DroolLocation } from '@industry/drool-sdk-ext/protocol/settings';

import { getExecRuntimeConfig } from '@/services/ExecRuntimeConfigService';

import type { CustomDrool, DroolToolConfig } from '@industry/common/settings';

// eslint-disable-next-line industry/types-file-organization
export interface BuiltInDroolConfig {
  name: string;
  description: string;
  systemPrompt: string;
  tools: DroolToolConfig | undefined;
  defaultComplexity: ComplexityTier;
}

const WORKER_SYSTEM_PROMPT = `You are a general-purpose worker agent. You can read/write files, run commands, search code, and make changes. Complete your assigned task precisely and report results.

Key guidelines:
- Complete the task and return what the caller asked for, in the format they specified.
- Report concrete actions taken and their outcomes
- Note any blockers or required follow-ups`;

const EXPLORER_SYSTEM_PROMPT = `You are a fast codebase exploration agent. You can only read and search - no file modifications, no command execution. Find information quickly and report your findings.

Key guidelines:
- Focus on finding the requested information efficiently
- Use Grep, Glob, Read, and LS tools for exploration
- Summarize findings concisely with file paths and line numbers
- Do not attempt to modify any files or run any commands`;

const ALL_BUILT_IN_DROOL_CONFIGS: BuiltInDroolConfig[] = [
  {
    name: 'worker',
    description:
      'General-purpose worker drool for delegating tasks. Use for non-trivial tasks that benefit from parallel execution, such as Q&A, research, analysis.',
    systemPrompt: WORKER_SYSTEM_PROMPT,
    tools: undefined,
    defaultComplexity: ComplexityTier.Medium,
  },
  {
    name: 'explorer',
    description:
      'Fast read-only codebase exploration agent. Use for searching files, finding patterns, understanding code structure. Cannot modify files or run commands.',
    systemPrompt: EXPLORER_SYSTEM_PROMPT,
    tools: 'read-only',
    defaultComplexity: ComplexityTier.Light,
  },
];

export function getBuiltInDroolConfigs(): BuiltInDroolConfig[] {
  if (!getExecRuntimeConfig().isSubAgentsV2Enabled()) {
    return [];
  }
  return ALL_BUILT_IN_DROOL_CONFIGS;
}

export function getBuiltInDroolConfig(
  name: string
): BuiltInDroolConfig | undefined {
  return getBuiltInDroolConfigs().find((d) => d.name === name);
}

export function builtInDroolConfigToCustomDrool(
  config: BuiltInDroolConfig
): CustomDrool {
  return {
    metadata: {
      name: config.name,
      description: config.description,
      model: 'inherit',
      tools: config.tools,
    },
    systemPrompt: config.systemPrompt,
    location: DroolLocation.Project,
    filePath: '(built-in)',
    lastModified: 0,
    validationResult: { valid: true, errors: [], warnings: [] },
  };
}

export function buildBuiltInDroolsDescriptionSection(): string {
  const configs = getBuiltInDroolConfigs();
  if (configs.length === 0) {
    return '';
  }

  const lines: string[] = ['', '### Built-in Subagent Types:', ''];

  for (const drool of configs) {
    lines.push(
      `* **${drool.name}** -- ${drool.description} (default complexity: ${drool.defaultComplexity})`
    );
  }

  lines.push('');

  return lines.join('\n');
}
