import { MarkdownConfig } from '@/utils/markdown/types';
import { defaultSyntaxConfig } from '@/utils/syntaxHighlighter/constants';

export const defaultMarkdownConfig: MarkdownConfig = {
  colors: {
    bold: 'yellow',
    italic: 'green',
    code: 'gray',
    link: 'cyan',
    blockquote: 'gray',
    heading: 'green',
    strikethrough: 'gray',
  },
  syntaxHighlighting: true,
  showCodeLanguage: true,
  allowTerminalLinks: true,
  allowMermaid: true,
  syntaxConfig: defaultSyntaxConfig,
};
