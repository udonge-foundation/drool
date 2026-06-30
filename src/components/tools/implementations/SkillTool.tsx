import { Box, Text } from 'ink';

import { logWarn } from '@industry/logging';

import { COLORS } from '@/components/chat/themedColors';
import {
  ToolComponent,
  ToolComponentProps,
} from '@/components/tools/registry/types';
import { ToolResultContent } from '@/hooks/types';
import { getI18n } from '@/i18n';
// eslint-disable-next-line industry/constants-file-organization
export const SkillTool: ToolComponent = {
  getHeaderLabel(input: Record<string, unknown>): string {
    const skillName = input.skill as string;
    if (!skillName) return '';
    return skillName;
  },

  renderResult({ input, result, isError }: ToolComponentProps) {
    const skillName = input.skill as string;
    const t = getI18n().t;

    if (isError) {
      return (
        <Text color={COLORS.error}>
          {t('common:skillTool.failedToLoad', { skillName })}
        </Text>
      );
    }

    // Extract tools from the result if available
    let toolsMessage = '';
    if (result && typeof result === 'string') {
      try {
        // Try to parse result as JSON first (if it's structured)
        let tools: string[] = [];
        try {
          const parsedResult = JSON.parse(result);
          if (parsedResult?.metadata?.tools) {
            tools = Array.isArray(parsedResult.metadata.tools)
              ? parsedResult.metadata.tools
              : typeof parsedResult.metadata.tools === 'string'
                ? parsedResult.metadata.tools
                    .split(',')
                    .map((s: string) => s.trim())
                : [];
          }
        } catch {
          // If not JSON, try to extract from the text content
          // Look for tools in the skill's frontmatter or metadata
          const toolsMatch = result.match(/tools:\s*([^\n]+)/i);
          if (toolsMatch) {
            const toolsStr = toolsMatch[1].replace(/\[|\]/g, '').trim();
            tools = toolsStr.split(',').map((s) => s.trim());
          }
        }

        if (tools.length > 0) {
          toolsMessage = t('common:skillTool.allowedTools', {
            count: tools.length,
          });
        }
      } catch {
        logWarn('Failed to parse tools from skill load result', {
          name: skillName,
        });
      }
    }

    return (
      <Box flexDirection="column">
        <Text color={COLORS.text.muted}>{t('common:skillTool.activated')}</Text>
        {toolsMessage && (
          <Text color={COLORS.text.muted} dimColor>
            {'  '}
            {toolsMessage}
          </Text>
        )}
      </Box>
    );
  },

  getSummaryLine(
    input: Record<string, unknown>,
    result: ToolResultContent,
    isError: boolean
  ): string {
    const skillName = input.skill as string;
    const t = getI18n().t;

    if (isError) {
      return t('common:skillTool.summaryFailed', { skillName });
    }

    if (!result) {
      return t('common:skillTool.summaryLoading', { skillName });
    }

    return t('common:skillTool.summaryActivated', { skillName });
  },
};
