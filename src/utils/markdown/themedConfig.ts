import { getThemeEngine } from '@/theme/ThemeEngine';
import { defaultMarkdownConfig } from '@/utils/markdown/constants';
import type { MarkdownConfig } from '@/utils/markdown/types';
import { getThemedSyntaxConfig } from '@/utils/syntaxHighlighter/highlight';

/**
 * Get markdown config with terminal theme applied to syntax highlighting.
 * Pulls per-theme markdown colors from ThemeEngine.
 */
export function getThemedMarkdownConfig(): MarkdownConfig {
  const themeMarkdown = getThemeEngine().getMarkdownColors();
  return {
    ...defaultMarkdownConfig,
    colors: { ...defaultMarkdownConfig.colors, ...themeMarkdown },
    syntaxConfig: getThemedSyntaxConfig(),
  };
}
