import { Box, Text } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logError } from '@industry/logging';

import { COLORS } from '@/components/chat/themedColors';
import { TextInput } from '@/components/common/TextInput';
import { Spinner } from '@/components/Spinner';
import { useEscapeHandler } from '@/hooks/useEscapeHandler';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import {
  fetchBranchData,
  filterBranches,
} from '@/services/review/branch-fetcher';
import type { BranchFetchResult } from '@/services/review/types';

interface Props {
  width: number;
  currentBranch: string | null;
  onSelect: (branch: string) => void;
  onBack?: () => void;
}

export function BaseBranchScreen({
  width,
  currentBranch,
  onSelect,
  onBack,
}: Props) {
  const { t } = useTranslation();
  const [branchData, setBranchData] = useState<BranchFetchResult | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  // Track mount time to debounce initial Enter key from command submission
  const mountTimeRef = useRef(Date.now());

  // Load branch data on mount
  useEffect(() => {
    let isMounted = true;

    const loadBranches = async () => {
      setIsLoading(true);
      try {
        const data = await fetchBranchData();
        if (isMounted) {
          setBranchData(data);
        }
      } catch (error) {
        logError('Failed to load branches', { error });
        if (isMounted) {
          setBranchData({
            branches: [],
            currentBranch: null,
            suggestedBaseBranch: null,
            error: t('common:review.failedToLoadBranches'),
          });
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    void loadBranches();

    return () => {
      isMounted = false;
    };
  }, []);

  // Filter branches based on search and exclude current branch
  const filteredBranches = useMemo(() => {
    if (!branchData) return [];
    const filtered = filterBranches(branchData.branches, searchQuery);
    // Exclude the current branch from the list
    return filtered.filter((branch) => !branch.isCurrent);
  }, [branchData, searchQuery]);

  useEscapeHandler(onBack ?? (() => {}), { isActive: !!onBack });

  // Handle keyboard input for navigation
  useKeypressHandler((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) =>
        Math.min(filteredBranches.length - 1, prev + 1)
      );
      return;
    }

    if (key.return && filteredBranches.length > 0) {
      // Ignore Enter key within 100ms of mount to prevent the Enter that opened
      // this screen (from command submission) from also selecting a branch
      if (Date.now() - mountTimeRef.current < 100) {
        return;
      }
      const selectedBranch = filteredBranches[selectedIndex];
      if (selectedBranch) {
        onSelect(selectedBranch.name);
      }
    }
  });

  // Render loading state
  if (isLoading) {
    return (
      <Box
        width={width}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
        borderStyle="round"
        borderColor={COLORS.border}
      >
        <Text bold>{t('common:review.baseBranchTitle')}</Text>
        <Box marginTop={1}>
          <Text color={COLORS.primary}>
            <Spinner /> {t('common:review.fetchingBranches')}
          </Text>
        </Box>
      </Box>
    );
  }

  // Render error state
  if (branchData?.error) {
    return (
      <Box
        width={width}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
        borderStyle="round"
        borderColor={COLORS.border}
      >
        <Text bold color={COLORS.error}>
          {t('common:review.errorLoadingBranches')}
        </Text>
        <Text color={COLORS.text.muted}>{branchData.error}</Text>
        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('common:review.escToGoBack')}
          </Text>
        </Box>
      </Box>
    );
  }

  // Calculate visible branches (show 10 at a time)
  const maxVisible = 10;
  const startIndex = Math.max(
    0,
    Math.min(selectedIndex - 5, filteredBranches.length - maxVisible)
  );
  const visibleBranches = filteredBranches.slice(
    startIndex,
    startIndex + maxVisible
  );

  return (
    <Box
      width={width}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      borderStyle="round"
      borderColor={COLORS.border}
    >
      <Text bold>{t('common:review.baseBranchTitle')}</Text>

      {/* Current branch info */}
      {currentBranch && (
        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('common:review.reviewingFrom')}{' '}
            <Text color={COLORS.success}>{currentBranch}</Text>
          </Text>
        </Box>
      )}

      {/* Search input */}
      <Box marginTop={1}>
        <Text color={COLORS.text.muted}>{t('common:review.searchLabel')}</Text>
        <TextInput
          focus
          value={searchQuery}
          onChange={(newQuery) => {
            setSearchQuery(newQuery);
            setSelectedIndex(0);
          }}
          placeholder={t('common:review.searchPlaceholder')}
        />
      </Box>

      {/* Branch list */}
      <Box marginTop={1} flexDirection="column">
        {filteredBranches.length === 0 ? (
          <Text color={COLORS.text.muted}>
            {searchQuery
              ? t('common:review.noBranchesMatch')
              : t('common:review.noBranchesFound')}
          </Text>
        ) : (
          <>
            {/* Show scroll indicator if needed */}
            {startIndex > 0 && (
              <Text color={COLORS.text.muted}>
                {t('common:review.moreAbove', { count: startIndex })}
              </Text>
            )}

            {/* Branch list */}
            {visibleBranches.map((branch, index) => {
              const absoluteIndex = startIndex + index;
              const isSelected = absoluteIndex === selectedIndex;
              const prefix = isSelected ? '>' : ' ';

              return (
                <Box key={branch.name}>
                  <Text color={isSelected ? COLORS.primary : undefined}>
                    {prefix} {currentBranch || t('common:review.current')} →{' '}
                    {branch.name}
                  </Text>
                </Box>
              );
            })}

            {/* Show scroll indicator if needed */}
            {startIndex + maxVisible < filteredBranches.length && (
              <Text color={COLORS.text.muted}>
                {t('common:review.moreBelow', {
                  count: filteredBranches.length - startIndex - maxVisible,
                })}
              </Text>
            )}
          </>
        )}
      </Box>

      {/* Help text */}
      <Box marginTop={1}>
        <Text color={COLORS.text.muted}>
          {filteredBranches.length > 0
            ? t('common:review.branchNavigationHelp')
            : t('common:review.escToGoBack')}
        </Text>
      </Box>
    </Box>
  );
}
