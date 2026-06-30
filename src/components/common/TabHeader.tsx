import { Box, Text } from 'ink';

import { COLORS } from '@/components/chat/themedColors';

interface Tab<T extends string> {
  id: T;
  label: string;
  color?: string;
}

interface TabHeaderProps<T extends string> {
  tabs: Tab<T>[];
  activeTab: T;
}

export function TabHeader<T extends string>({
  tabs,
  activeTab,
}: TabHeaderProps<T>) {
  return (
    <Box>
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTab;
        const activeColor = tab.color ?? COLORS.primary;
        return (
          <Box key={tab.id}>
            {index > 0 && <Text>{'  '}</Text>}
            <Text color={isActive ? activeColor : COLORS.text.muted}>
              {isActive ? '◉' : '○'} {tab.label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
