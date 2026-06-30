import { renderMermaidAscii } from 'beautiful-mermaid';
import { Box, Text } from 'ink';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import {
  displayWidth as getDisplayWidth,
  sliceByDisplayWidth,
} from '@/utils/displayWidth';
import { sanitizeHyperlinkUrl } from '@/utils/hyperlinks';
import {
  detectMermaidDiagramType,
  isTerminalSupportedMermaidType,
} from '@/utils/mermaid/detectDiagramType';
import {
  buildMermaidViewerUrl,
  sanitizeMermaidSource,
} from '@/utils/mermaid/encodeMermaidUrl';
import { DetectedMermaidType } from '@/utils/mermaid/enums';
import { shouldSkipTerminalMermaidRender } from '@/utils/mermaid/shouldSkipTerminalMermaidRender';
import {
  linkSegment,
  renderTerminalLine,
  textSegment,
} from '@/utils/terminalSegments';

interface MermaidCodeBlockProps {
  source: string;
  maxWidth?: number;
  showCodeLanguage?: boolean;
}

type FallbackReason = 'tooWide' | 'unsupported' | 'renderError';

interface MermaidRenderResult {
  kind: 'ascii' | 'fallback';
  ascii?: string;
  reason?: FallbackReason;
  type: DetectedMermaidType;
}

const ELLIPSIS = '...';

function truncateToDisplayWidth(text: string, maxWidth?: number): string {
  if (!maxWidth || maxWidth <= 0 || getDisplayWidth(text) <= maxWidth) {
    return text;
  }

  if (maxWidth <= ELLIPSIS.length) {
    return ELLIPSIS.slice(0, maxWidth);
  }

  const { slice } = sliceByDisplayWidth(text, maxWidth - ELLIPSIS.length);
  return `${slice}${ELLIPSIS}`;
}

function sliceEndByDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }

  let width = 0;
  let result = '';
  for (const char of Array.from(text).reverse()) {
    const charWidth = getDisplayWidth(char);
    if (width + charWidth > maxWidth) {
      break;
    }

    result = `${char}${result}`;
    width += charWidth;
  }

  return result;
}

function truncatePathToDisplayWidth(text: string, maxWidth?: number): string {
  if (!maxWidth || maxWidth <= 0 || getDisplayWidth(text) <= maxWidth) {
    return text;
  }

  if (maxWidth <= ELLIPSIS.length) {
    return ELLIPSIS.slice(0, maxWidth);
  }

  const separator = text.includes('\\') ? '\\' : '/';
  const basename = text.split(/[\\/]/).at(-1) || text;
  const prefixedBasename = `${ELLIPSIS}${separator}${basename}`;
  if (getDisplayWidth(prefixedBasename) <= maxWidth) {
    return prefixedBasename;
  }

  return `${ELLIPSIS}${sliceEndByDisplayWidth(
    basename,
    maxWidth - ELLIPSIS.length
  )}`;
}

function measureDiagramWidth(diagram: string): number {
  const lines = diagram.split('\n');
  if (lines.length === 0) return 0;
  return Math.max(...lines.map((line) => getDisplayWidth(line)));
}

function renderAsciiOrFallback(
  source: string,
  terminalWidth: number
): MermaidRenderResult {
  const type = detectMermaidDiagramType(source);

  if (!isTerminalSupportedMermaidType(type)) {
    return { kind: 'fallback', reason: 'unsupported', type };
  }

  if (shouldSkipTerminalMermaidRender(source)) {
    return { kind: 'fallback', reason: 'renderError', type };
  }

  const m = COLORS.mermaid;
  try {
    const rendered = renderMermaidAscii(source, {
      useAscii: true,
      paddingX: 1,
      paddingY: 1,
      boxBorderPadding: 0,
      colorMode: 'truecolor',
      theme: {
        fg: m.text,
        border: m.border,
        line: m.line,
        arrow: m.arrow,
        corner: m.corner,
        junction: m.junction,
      },
    });

    if (!rendered) {
      return { kind: 'fallback', reason: 'renderError', type };
    }

    if (measureDiagramWidth(rendered) > terminalWidth) {
      return { kind: 'fallback', reason: 'tooWide', type };
    }

    return { kind: 'ascii', ascii: rendered, type };
  } catch {
    return { kind: 'fallback', reason: 'renderError', type };
  }
}

function MermaidFileLink({
  source,
  maxWidth,
}: {
  source: string;
  maxWidth?: number;
}): React.ReactElement | null {
  const { t } = useTranslation('common');
  const url = useMemo(() => buildMermaidViewerUrl(source), [source]);

  if (!url) return null;

  const localPath = url.startsWith('file://') ? url.slice(7) : null;

  const modifier = process.platform === 'darwin' ? 'cmd' : 'ctrl';
  const sanitizedUrl = sanitizeHyperlinkUrl(url);
  const linkLabel = t('toolDisplay.mermaidFallback.linkLabel', { modifier });
  const link = sanitizedUrl
    ? linkSegment(sanitizedUrl, [textSegment(linkLabel)])
    : null;
  const linkDisplay = link
    ? renderTerminalLine([link], maxWidth ?? getDisplayWidth(linkLabel))
    : truncateToDisplayWidth(sanitizedUrl || url, maxWidth);
  const boundedLocalPath = localPath
    ? truncatePathToDisplayWidth(localPath, maxWidth)
    : null;

  return (
    <Box flexDirection="column">
      <Text color={COLORS.text.info}>{linkDisplay}</Text>
      {boundedLocalPath ? (
        <Text color={COLORS.text.muted} dimColor>
          {boundedLocalPath}
        </Text>
      ) : null}
    </Box>
  );
}

function MermaidFallback({
  source,
  reason,
  type,
  maxWidth,
}: {
  source: string;
  reason: FallbackReason;
  type: DetectedMermaidType;
  maxWidth?: number;
}): React.ReactElement {
  const { t } = useTranslation('common');

  const modifier = process.platform === 'darwin' ? 'cmd' : 'ctrl';
  const typeLabel = t('toolDisplay.mermaidFallback.typeLabel', { type });
  const helperText =
    reason === 'tooWide'
      ? t('toolDisplay.mermaidFallback.tooWide', { modifier })
      : reason === 'unsupported'
        ? t('toolDisplay.mermaidFallback.unsupported', { type, modifier })
        : t('toolDisplay.mermaidFallback.renderError', { modifier });

  return (
    <Box flexDirection="column" marginTop={0} marginBottom={0} width={maxWidth}>
      <Text color={COLORS.text.muted} italic>
        {typeLabel}
      </Text>
      <Text color={COLORS.text.muted}>{helperText}</Text>
      <MermaidFileLink source={source} maxWidth={maxWidth} />
    </Box>
  );
}

export function MermaidCodeBlock({
  source: rawSource,
  maxWidth,
  showCodeLanguage,
}: MermaidCodeBlockProps): React.ReactElement {
  const source = useMemo(() => sanitizeMermaidSource(rawSource), [rawSource]);
  const terminalWidth = maxWidth || 100;
  const result = useMemo(
    () => renderAsciiOrFallback(source, terminalWidth),
    [source, terminalWidth]
  );

  if (result.kind === 'ascii' && result.ascii) {
    return (
      <Box
        flexDirection="column"
        marginTop={0}
        marginBottom={0}
        width={maxWidth}
      >
        {showCodeLanguage ? (
          <Box>
            {/* eslint-disable-next-line industry/no-untranslated-strings */}
            <Text color={COLORS.text.muted} italic>
              mermaid
            </Text>
          </Box>
        ) : null}
        <Box flexDirection="column" width="100%">
          {result.ascii.split('\n').map((line, lineIdx) => (
            <Text key={`mermaid-line-${lineIdx}`}>{line || ' '}</Text>
          ))}
        </Box>
        <MermaidFileLink source={source} maxWidth={maxWidth} />
      </Box>
    );
  }

  return (
    <MermaidFallback
      source={source}
      reason={result.reason ?? 'renderError'}
      type={result.type}
      maxWidth={maxWidth}
    />
  );
}
