import {
  ToolComponent,
  ToolComponentProps,
} from '@/components/tools/registry/types';

function getPlanTitle(input: Record<string, unknown>): string | undefined {
  if (typeof input.title === 'string' && input.title.trim().length > 0) {
    return input.title.trim();
  }

  if (typeof input.plan !== 'string') {
    return undefined;
  }

  const firstLine = input.plan
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return undefined;
  }

  return firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^(?:plan|specification|spec)\s*:\s*/i, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/^__(.+)__$/, '$1')
    .replace(/^`(.+)`$/, '$1')
    .trim();
}

// eslint-disable-next-line industry/constants-file-organization
export const ExitSpecModeTool: ToolComponent = {
  getHeaderLabel(input: Record<string, unknown>): string {
    const title = getPlanTitle(input);
    return title ? `"${title}"` : '';
  },

  renderPreview() {
    return null; // Special handling is done in UnifiedToolDisplay
  },

  renderResult({
    input: _input,
    result: _result,
    isError: _isError,
  }: ToolComponentProps) {
    return null; // Special handling is done via ExitSpecModeDisplay component
  },

  getSummaryLine(
    _input: Record<string, unknown>,
    _result: string,
    _isError: boolean
  ): string {
    return 'Specification proposal';
  },
};
