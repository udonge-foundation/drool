import { Box, Text } from 'ink';

import { COLORS } from '@/components/chat/themedColors';
import { DefaultTool } from '@/components/tools/implementations/DefaultTool';
import {
  ToolComponent,
  ToolComponentProps,
} from '@/components/tools/registry/types';
import type { ToolResultContent } from '@/hooks/types';
import { getTextContent } from '@/utils/tool-result-helpers';

interface ToolSearchResultSummary {
  firstLine: string;
  detailLines: string[];
  summaryLine: string;
}

class ToolSearchToolRenderer {
  renderSummary({ result, isError }: ToolComponentProps) {
    const resultString = getTextContent(result) || '';
    const summary = isError
      ? this.getSummaryFromText(resultString)
      : this.getSummaryFromToolSearchResult(resultString);

    if (!summary) {
      return DefaultTool.renderDetailedView?.({ result, isError, input: {} });
    }

    return (
      <Box flexDirection="column">
        <Text color={isError ? COLORS.error : COLORS.text.muted}>
          ↳ {summary.firstLine}
        </Text>
        {summary.detailLines.map((line, index) => (
          <Text key={`${index}:${line}`} color={COLORS.text.muted}>
            {'  '}
            {line}
          </Text>
        ))}
      </Box>
    );
  }

  getSummaryLine(
    input: Record<string, unknown>,
    result: ToolResultContent,
    isError: boolean
  ): string {
    if (isError) {
      return DefaultTool.getSummaryLine(input, result, isError);
    }

    const resultString = getTextContent(result) || '';
    return (
      this.getSummaryFromToolSearchResult(resultString)?.summaryLine ||
      DefaultTool.getSummaryLine(input, result, isError)
    );
  }

  private getSummaryFromToolSearchResult(
    result: string
  ): ToolSearchResultSummary | null {
    const loadedLineMatch = result.match(/^Loaded \d+ tool\(s\):.*$/m);
    const toolNames = Array.from(result.matchAll(/^Tool:\s*(.+)$/gm)).map(
      (match) => match[1]?.trim()
    );
    const notFoundMatch = result.match(/^Not found:.*$/m);
    const lines: string[] = [];

    if (loadedLineMatch) {
      lines.push(loadedLineMatch[0]);
      lines.push(...toolNames.filter(Boolean).map((name) => `Tool: ${name}`));
    }

    if (notFoundMatch) {
      lines.push(notFoundMatch[0]);
    }

    return this.getSummaryFromLines(lines);
  }

  private getSummaryFromText(result: string): ToolSearchResultSummary | null {
    return result ? this.getSummaryFromLines(result.split('\n')) : null;
  }

  private getSummaryFromLines(lines: string[]): ToolSearchResultSummary | null {
    if (lines.length === 0) {
      return null;
    }

    return {
      firstLine: lines[0] ?? '',
      detailLines: lines.slice(1),
      summaryLine: lines.join(' '),
    };
  }
}

const renderer = new ToolSearchToolRenderer();

// eslint-disable-next-line industry/constants-file-organization
export const ToolSearchTool: ToolComponent = {
  ...DefaultTool,
  renderResult: (props) => renderer.renderSummary(props),
  renderDetailedView: (props) => renderer.renderSummary(props),
  getSummaryLine: (input, result, isError) =>
    renderer.getSummaryLine(input, result, isError),
};
