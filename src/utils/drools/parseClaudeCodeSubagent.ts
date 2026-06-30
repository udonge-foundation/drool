import { getAvailableModelsForExec } from '@/models/availability';
import { DroolParser } from '@/services/drools/DroolParser';

import type { DroolMetadata } from '@industry/common/settings';

/**
 * Parse a Claude Code subagent file
 */
export async function parseClaudeCodeSubagent(content: string): Promise<{
  metadata: DroolMetadata;
  systemPrompt: string;
}> {
  const availableModels = await getAvailableModelsForExec();
  const parsed = DroolParser.parse(content, availableModels);

  return {
    metadata: parsed.metadata,
    systemPrompt: parsed.systemPrompt,
  };
}
