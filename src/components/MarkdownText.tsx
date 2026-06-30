import { Box } from 'ink';
import { useMemo } from 'react';

import { renderMarkdown } from '@/components/renderMarkdown';
import { getThemeEngine } from '@/theme/ThemeEngine';
import { parseMarkdown } from '@/utils/markdown/parser';
import { getThemedMarkdownConfig } from '@/utils/markdown/themedConfig';
import type { MarkdownConfig } from '@/utils/markdown/types';
import {
  createStaticRenderFingerprint,
  getOrComputeStaticRenderCache,
} from '@/utils/staticRenderCache';
import { useStaticRenderCacheScope } from '@/utils/staticRenderCacheContext';

interface MarkdownTextProps {
  children?: string;
  color?: string;
  config?: Partial<MarkdownConfig>;
  maxWidth?: number;
}

export function MarkdownText({
  children,
  color,
  config,
  maxWidth,
}: MarkdownTextProps) {
  const staticCacheScope = useStaticRenderCacheScope();
  const content = children || '';
  const activeThemeName = getThemeEngine().getActiveThemeName();
  const fullConfig = useMemo(
    () => ({
      ...getThemedMarkdownConfig(),
      ...config,
      ...(maxWidth !== undefined && { maxWidth }),
    }),
    [activeThemeName, config, maxWidth]
  );

  const contentFingerprint = useMemo(
    () => createStaticRenderFingerprint(content),
    [content]
  );
  const configFingerprint = useMemo(
    () => createStaticRenderFingerprint({ color, fullConfig }),
    [color, fullConfig]
  );
  const staticScopeKey = staticCacheScope?.scopeKey;

  const tokens = useMemo(() => {
    if (!staticScopeKey) {
      return parseMarkdown(content);
    }
    return getOrComputeStaticRenderCache(
      `${staticScopeKey}|markdown:tokens|${contentFingerprint}`,
      content.length,
      () => parseMarkdown(content)
    );
  }, [content, contentFingerprint, staticScopeKey]);
  const renderedElements = useMemo(() => {
    if (!staticScopeKey) {
      return renderMarkdown(tokens, fullConfig, color);
    }
    return getOrComputeStaticRenderCache(
      `${staticScopeKey}|markdown:render|${contentFingerprint}|${configFingerprint}`,
      content.length,
      () => renderMarkdown(tokens, fullConfig, color)
    );
  }, [
    color,
    configFingerprint,
    content.length,
    contentFingerprint,
    fullConfig,
    staticScopeKey,
    tokens,
  ]);

  return <Box flexDirection="column">{renderedElements}</Box>;
}
