import { Box, Text } from 'ink';

import { COLORS } from '@/components/chat/themedColors';
import { MarkdownText } from '@/components/MarkdownText';
import type { ThinkingContent } from '@/hooks/types';
import { getI18n } from '@/i18n';

interface ThinkingDisplayProps {
  thinking: ThinkingContent;
  contentWidth: number;
}

export function ThinkingDisplay({
  thinking,
  contentWidth,
}: ThinkingDisplayProps) {
  // Handle multiple thinking blocks (interleaved thinking support)
  if (thinking.thinkingBlocks && thinking.thinkingBlocks.length > 0) {
    // Filter out empty thinking blocks (placeholders during streaming)
    const nonEmptyBlocks = thinking.thinkingBlocks.filter(
      (block) =>
        block.type === 'redacted_thinking' ||
        (block.thinking && block.thinking.trim().length > 0)
    );
    if (nonEmptyBlocks.length === 0) {
      return null; // Don't render anything if all blocks are empty
    }
    const total = nonEmptyBlocks.length;
    return (
      <Box flexDirection="column">
        {nonEmptyBlocks.map((block, idx) => {
          // Detect OpenAI reasoning summaries by JSON signature (starts with '{')
          // Anthropic signatures are base64-like strings
          const isReasoningSummary =
            block.type !== 'redacted_thinking' &&
            block.signature?.startsWith('{');
          const t = getI18n().t;
          const label =
            block.type === 'redacted_thinking'
              ? t('common:thinking.redactedThinkingLabel')
              : isReasoningSummary
                ? total > 1
                  ? t('common:thinking.reasoningSummaryLabelIndexed', {
                      index: idx + 1,
                      total,
                    })
                  : t('common:thinking.reasoningSummaryLabel')
                : total > 1
                  ? t('common:thinking.thinkingLabelIndexed', {
                      index: idx + 1,
                      total,
                    })
                  : t('common:thinking.thinkingLabel');

          return (
            <Box key={block.index} flexDirection="column" marginBottom={1}>
              <Box
                marginBottom={0}
                justifyContent="space-between"
                width={contentWidth}
              >
                <Text color={COLORS.text.muted} italic dimColor>
                  {label}
                </Text>
              </Box>
              <Box marginLeft={2}>
                {block.type === 'redacted_thinking' ? (
                  <Text color={COLORS.text.muted} dimColor>
                    {getI18n().t('common:thinking.contentEncrypted')}
                  </Text>
                ) : (
                  <MarkdownText
                    color={COLORS.text.muted}
                    maxWidth={contentWidth - 2}
                  >
                    {(block.thinking || '').replaceAll('**', '').trim()}
                  </MarkdownText>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
    );
  }

  // Fallback to legacy single-block display
  // Don't render if no thinking data
  if (
    !thinking.thinking &&
    !thinking.hasEncryptedReasoning &&
    !thinking.thoughtSignature &&
    !thinking.reasoningSummary &&
    !thinking.chatCompletionReasoning
  ) {
    return null;
  }

  // Determine label and content based on content type
  const label = thinking.reasoningSummary
    ? getI18n().t('common:thinking.reasoningSummaryLabel')
    : getI18n().t('common:thinking.thinkingLabel');
  const content =
    thinking.reasoningSummary ||
    thinking.thinking ||
    thinking.chatCompletionReasoning;

  return (
    <Box flexDirection="column">
      {content && (
        <>
          <Box
            marginBottom={0}
            justifyContent="space-between"
            width={contentWidth}
          >
            <Text color={COLORS.text.muted} italic dimColor>
              {label}
            </Text>
          </Box>
          <Box marginLeft={2}>
            <MarkdownText color={COLORS.text.muted} maxWidth={contentWidth - 2}>
              {content.trim()}
            </MarkdownText>
          </Box>
        </>
      )}
    </Box>
  );
}
