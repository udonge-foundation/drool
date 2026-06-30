import { Text } from 'ink';

import { COLORS } from '@/components/chat/themedColors';

interface StyledHelpTextProps {
  text: string;
}

/**
 * Renders help text with styled keyboard shortcuts.
 * Parses "Key label · Key label" format, coloring keys and labels differently.
 */
export function StyledHelpText({ text }: StyledHelpTextProps) {
  const segments = text.split(' · ');
  return (
    <Text>
      {segments.map((segment, i) => {
        const spaceIdx = segment.indexOf(' ');
        const key = spaceIdx > 0 ? segment.slice(0, spaceIdx) : segment;
        const label = spaceIdx > 0 ? segment.slice(spaceIdx) : '';
        return (
          <Text key={i}>
            {i > 0 && <Text>{'   '}</Text>}
            <Text bold color={COLORS.text.helpKey}>
              {key}
            </Text>
            {label && <Text color={COLORS.text.helpLabel}>{label}</Text>}
          </Text>
        );
      })}
    </Text>
  );
}
