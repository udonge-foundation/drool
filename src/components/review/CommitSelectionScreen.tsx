import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logError } from '@industry/logging';

import { COLORS } from '@/components/chat/themedColors';
import { TextInput } from '@/components/common/TextInput';
import type { CommitInfo } from '@/components/review/types';
import { Spinner } from '@/components/Spinner';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { getRecentCommits } from '@/services/git-operations';

interface Props {
  width: number;
  onSelect: (commit: CommitInfo) => void;
}

export function CommitSelectionScreen({ width, onSelect }: Props) {
  const { t } = useTranslation();
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load commits on mount
  useEffect(() => {
    let isMounted = true;

    const loadCommits = async () => {
      setIsLoading(true);
      setError(null);
      try {
        // Load initial batch of commits
        const initialCommits = await getRecentCommits(100); // Load more initially
        if (isMounted) {
          setCommits(initialCommits);
          // If we got 100 commits, there might be more
          setHasMore(initialCommits.length === 100);
        }
      } catch (err) {
        logError('Failed to load commits', { error: err });
        if (isMounted) {
          setError(t('common:review.failedToLoadCommits'));
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    void loadCommits();

    return () => {
      isMounted = false;
    };
  }, []);

  // Filter commits based on search
  const filteredCommits = useMemo(() => {
    if (!searchQuery.trim()) {
      return commits;
    }

    const lowerQuery = searchQuery.toLowerCase();
    return commits.filter(
      (commit) =>
        commit.message.toLowerCase().includes(lowerQuery) ||
        commit.shortHash.toLowerCase().includes(lowerQuery)
    );
  }, [commits, searchQuery]);

  // Handle keyboard input for navigation
  useKeypressHandler((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) =>
        Math.min(filteredCommits.length - 1, prev + 1)
      );
      return;
    }

    if (key.return && filteredCommits.length > 0) {
      const selectedCommit = filteredCommits[selectedIndex];
      if (selectedCommit) {
        onSelect(selectedCommit);
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
        <Text bold>{t('common:review.commitTitle')}</Text>
        <Box marginTop={1}>
          <Text color={COLORS.primary}>
            <Spinner /> {t('common:review.loadingCommits')}
          </Text>
        </Box>
      </Box>
    );
  }

  // Render error state
  if (error) {
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
          {t('common:review.errorLoadingCommits')}
        </Text>
        <Text color={COLORS.text.muted}>{error}</Text>
        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('common:review.escToGoBack')}
          </Text>
        </Box>
      </Box>
    );
  }

  // Calculate visible commits (show 10 at a time)
  const maxVisible = 10;
  const startIndex = Math.max(
    0,
    Math.min(selectedIndex - 5, filteredCommits.length - maxVisible)
  );
  const visibleCommits = filteredCommits.slice(
    startIndex,
    startIndex + maxVisible
  );

  // Truncate long commit messages
  const truncateMessage = (message: string, maxLength: number = 70) => {
    if (message.length <= maxLength) return message;
    return `${message.substring(0, maxLength - 1)}…`;
  };

  return (
    <Box
      width={width}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      borderStyle="round"
      borderColor={COLORS.border}
    >
      <Text bold>{t('common:review.commitTitle')}</Text>

      {/* Search input */}
      <Box marginTop={1}>
        <Text color={COLORS.text.muted}>
          {t('common:review.commitSearchHint')}
        </Text>
      </Box>
      <Box>
        <TextInput
          focus
          value={searchQuery}
          onChange={(newQuery) => {
            setSearchQuery(newQuery);
            setSelectedIndex(0);
          }}
          placeholder={t('common:review.commitSearchPlaceholder')}
        />
      </Box>

      {/* Commit list */}
      <Box marginTop={1} flexDirection="column">
        {filteredCommits.length === 0 ? (
          <Text color={COLORS.text.muted}>
            {searchQuery
              ? t('common:review.noCommitsMatch')
              : t('common:review.noCommitsFound')}
          </Text>
        ) : (
          <>
            {/* Show scroll indicator if needed */}
            {startIndex > 0 && (
              <Text color={COLORS.text.muted}>
                {t('common:review.moreAbove', { count: startIndex })}
              </Text>
            )}

            {/* Commit list */}
            {visibleCommits.map((commit, index) => {
              const absoluteIndex = startIndex + index;
              const isSelected = absoluteIndex === selectedIndex;
              const prefix = isSelected ? '›' : ' ';

              return (
                <Box key={commit.hash}>
                  <Text color={isSelected ? COLORS.primary : undefined}>
                    {prefix} {truncateMessage(commit.message)}
                  </Text>
                </Box>
              );
            })}

            {/* Show scroll indicator if needed */}
            {startIndex + maxVisible < filteredCommits.length && (
              <Text color={COLORS.text.muted}>
                {t('common:review.moreBelow', {
                  count: filteredCommits.length - startIndex - maxVisible,
                })}
              </Text>
            )}
          </>
        )}
      </Box>

      {/* Help text */}
      <Box marginTop={1}>
        <Text color={COLORS.text.muted}>
          {filteredCommits.length > 0
            ? t('common:review.commitNavigationHelp')
            : t('common:review.escToGoBack')}
        </Text>
      </Box>
    </Box>
  );
}
