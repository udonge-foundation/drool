import type { MarkdownConfig } from '@/utils/markdown/types';

export const ASK_USER_MARKDOWN_CONFIG = {
  allowTerminalLinks: false,
  allowMermaid: false,
} satisfies Partial<MarkdownConfig>;
