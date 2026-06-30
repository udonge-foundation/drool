import {
  DEFAULT_TASK_TOOL_DESCRIPTION,
  DEFAULT_TASK_TOOL_DESCRIPTION_V2,
} from '@industry/drool-core/tools/definitions/cli/constants';
import { logException } from '@industry/logging';

import { buildBuiltInDroolsDescriptionSection } from '@/services/drools/BuiltInDroolConfigs';
import {
  getCustomDroolPaths,
  getDroolLoaderSingleton,
} from '@/services/drools/CustomDroolRegistry';
import { getExecRuntimeConfig } from '@/services/ExecRuntimeConfigService';

import type { CustomDrool } from '@industry/common/settings';

/**
 * Builds the custom drool section of the task tool description
 */
function buildDroolSection(validDrools: CustomDrool[]): string {
  const { project, personal } = getCustomDroolPaths();

  const lines: string[] = [
    '',
    '## Custom Drools Available',
    '',
    'Custom drool directories:',
    `• Project: ${project}`,
    `• Personal: ${personal}`,
    '',
    'If a relevant custom drool exists, USE IT by calling the Task tool.',
    '',
  ];

  if (validDrools.length > 0) {
    lines.push('### Available Custom Drools:');
    lines.push('');

    for (const drool of validDrools) {
      const details: string[] = [`**${drool.metadata.name}**`];

      if (drool.metadata.description) {
        details.push(`— ${drool.metadata.description}`);
      }

      const modelLabel = drool.metadata.model ?? 'inherit';
      const locationLabel =
        drool.location === 'project' ? 'project' : 'personal';
      details.push(`(model: ${modelLabel}, location: ${locationLabel})`);

      lines.push(`• ${details.join(' ')}`);
    }

    lines.push('');
    lines.push(
      'GUIDANCE: For each user task, first check if any custom drool above is a good match.'
    );
    lines.push(
      'If one is relevant, launch it immediately rather than attempting the task yourself.'
    );
    lines.push('Only invoke subagents that are currently available.');
  }

  return lines.join('\n');
}
async function loadValidDrools(): Promise<CustomDrool[]> {
  try {
    const loader = getDroolLoaderSingleton();
    const drools = await loader.loadAllDrools();
    return drools.filter((drool) => drool.validationResult.valid);
  } catch (error) {
    logException(error, 'Failed to load custom drools');
    return [];
  }
}

/**
 * Loads once and returns both count and description to avoid duplicate I/O.
 * When sub-agents-v2 is enabled, built-in drools (worker, explorer) are always
 * available so count >= 2.
 */
export async function getDroolState(): Promise<{
  count: number;
  description: string | null;
}> {
  const isV2 = getExecRuntimeConfig().isSubAgentsV2Enabled();
  const validDrools = await loadValidDrools();
  const builtInSection = isV2 ? buildBuiltInDroolsDescriptionSection() : '';
  const builtInCount = isV2 ? (builtInSection.length > 0 ? 2 : 0) : 0;
  const customSection =
    validDrools.length > 0 ? buildDroolSection(validDrools) : '';

  const count = validDrools.length + builtInCount;
  if (count === 0) return { count: 0, description: null };

  const baseDescription = isV2
    ? DEFAULT_TASK_TOOL_DESCRIPTION_V2
    : DEFAULT_TASK_TOOL_DESCRIPTION;

  return {
    count,
    description: baseDescription + builtInSection + customSection,
  };
}
