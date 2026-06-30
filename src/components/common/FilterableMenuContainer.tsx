import { Box, Text } from 'ink';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { TabHeader } from '@/components/common/TabHeader';
import { TextInput } from '@/components/common/TextInput';
import type { KeyEvent } from '@/contexts/types';

import type { ReactNode } from 'react';

interface FilterableMenuTab<T extends string> {
  id: T;
  label: string;
  color?: string;
}

interface FilterableMenuContainerProps<T extends string> {
  title: string;
  children: ReactNode;
  helpText: string;
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  /** Optional muted description rendered between the title and the search input. */
  description?: string;
  width?: number;
  titleBold?: boolean;
  tabs?: FilterableMenuTab<T>[];
  activeTab?: T;
  headerRight?: ReactNode;
  hideHeaderWhenSearching?: boolean;
  searchFocused?: boolean;
  shouldIgnoreSearchInput?: (input: string, key: KeyEvent['key']) => boolean;
}

export function FilterableMenuContainer<T extends string>({
  title,
  children,
  helpText,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  description,
  width,
  titleBold = false,
  tabs,
  activeTab,
  headerRight,
  hideHeaderWhenSearching = false,
  searchFocused = true,
  shouldIgnoreSearchInput,
}: FilterableMenuContainerProps<T>) {
  const isSearching = searchValue.trim().length > 0;
  const resolvedHeaderTabs =
    hideHeaderWhenSearching && isSearching ? undefined : tabs && activeTab ? (
      <TabHeader tabs={tabs} activeTab={activeTab} />
    ) : undefined;
  const resolvedHeaderRight = resolvedHeaderTabs ? undefined : headerRight;

  return (
    <MenuContainer
      title={title}
      titleBold={titleBold}
      width={width}
      headerRight={resolvedHeaderRight}
      headerTabs={resolvedHeaderTabs}
      helpText={helpText}
      showDefaultHelp={false}
    >
      {description && (
        <Box marginBottom={1}>
          <Text color={COLORS.text.muted}>{description}</Text>
        </Box>
      )}
      <Box marginBottom={1}>
        <TextInput
          key={searchFocused ? 'search-focused' : 'search-blurred'}
          value={searchValue}
          onChange={onSearchChange}
          placeholder={searchPlaceholder}
          focus={searchFocused}
          shouldIgnoreInput={shouldIgnoreSearchInput}
        />
      </Box>
      {children}
    </MenuContainer>
  );
}
