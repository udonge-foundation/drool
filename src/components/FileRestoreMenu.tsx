import path from 'path';

import { Box, Text } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import type {
  FileCreation,
  FileRestoreSelection,
  FileSnapshot,
} from '@/services/snapshots/types';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FileRestoreMenuProps {
  /** Files available for restoration (edited files with previous content) */
  availableFiles: FileSnapshot[];
  /** Files that were evicted and cannot be restored */
  evictedFiles: Array<{ filePath: string; reason: string }>;
  /** Files that were created and can be deleted on rewind */
  createdFiles: FileCreation[];
  /** Called when user confirms restoration/deletion */
  onConfirm: (selection: FileRestoreSelection) => void;
  /** Called when user cancels */
  onCancel: () => void;
  /** Called to skip restoration but continue with rewind */
  onSkip: () => void;
  /** Working directory for relative path display */
  cwd?: string;
}

interface FileItem {
  type: 'available' | 'evicted' | 'created';
  filePath: string;
  displayPath: string;
  snapshot?: FileSnapshot;
  creation?: FileCreation;
  reason?: string;
  selected: boolean;
}

const VISIBLE_COUNT = 12;

export function FileRestoreMenu({
  availableFiles,
  evictedFiles,
  createdFiles,
  onConfirm,
  onCancel,
  onSkip,
  cwd = process.cwd(),
}: FileRestoreMenuProps) {
  const { t } = useTranslation();
  const [windowStart, setWindowStart] = useState(0);
  // Track selected files for restoration (edited files)
  const [selectedRestoreFiles, setSelectedRestoreFiles] = useState<Set<string>>(
    new Set(availableFiles.map((f) => f.filePath))
  );
  // Track selected files for deletion (created files)
  const [selectedDeleteFiles, setSelectedDeleteFiles] = useState<Set<string>>(
    new Set(createdFiles.map((f) => f.filePath))
  );

  // Build file items list
  const fileItems = useMemo((): FileItem[] => {
    const items: FileItem[] = [];

    // Add available files first (to restore)
    for (const file of availableFiles) {
      const relativePath = path.relative(cwd, file.filePath);
      items.push({
        type: 'available',
        filePath: file.filePath,
        displayPath: relativePath.startsWith('..')
          ? file.filePath
          : relativePath,
        snapshot: file,
        selected: selectedRestoreFiles.has(file.filePath),
      });
    }

    // Add created files (to delete)
    for (const file of createdFiles) {
      const relativePath = path.relative(cwd, file.filePath);
      items.push({
        type: 'created',
        filePath: file.filePath,
        displayPath: relativePath.startsWith('..')
          ? file.filePath
          : relativePath,
        creation: file,
        selected: selectedDeleteFiles.has(file.filePath),
      });
    }

    // Add evicted files (cannot restore)
    for (const file of evictedFiles) {
      const relativePath = path.relative(cwd, file.filePath);
      items.push({
        type: 'evicted',
        filePath: file.filePath,
        displayPath: relativePath.startsWith('..')
          ? file.filePath
          : relativePath,
        reason: file.reason,
        selected: false,
      });
    }

    return items;
  }, [
    availableFiles,
    evictedFiles,
    createdFiles,
    cwd,
    selectedRestoreFiles,
    selectedDeleteFiles,
  ]);

  // Use ref to track selected index for callbacks
  const selectedIndexRef = useRef(0);

  // Helper to toggle file at current selection
  const toggleCurrentFile = useCallback(() => {
    const item = fileItems[selectedIndexRef.current];
    if (item?.type === 'available') {
      setSelectedRestoreFiles((prev) => {
        const next = new Set(prev);
        if (next.has(item.filePath)) {
          next.delete(item.filePath);
        } else {
          next.add(item.filePath);
        }
        return next;
      });
    } else if (item?.type === 'created') {
      setSelectedDeleteFiles((prev) => {
        const next = new Set(prev);
        if (next.has(item.filePath)) {
          next.delete(item.filePath);
        } else {
          next.add(item.filePath);
        }
        return next;
      });
    }
  }, [fileItems]);

  // Helper to confirm restore/delete
  const confirmRestore = useCallback(() => {
    const toRestore = availableFiles.filter((f) =>
      selectedRestoreFiles.has(f.filePath)
    );
    const toDelete = createdFiles.filter((f) =>
      selectedDeleteFiles.has(f.filePath)
    );
    if (toRestore.length > 0 || toDelete.length > 0) {
      onConfirm({ filesToRestore: toRestore, filesToDelete: toDelete });
    }
  }, [
    availableFiles,
    createdFiles,
    selectedRestoreFiles,
    selectedDeleteFiles,
    onConfirm,
  ]);

  // Select all helper
  const selectAll = useCallback(() => {
    setSelectedRestoreFiles(new Set(availableFiles.map((f) => f.filePath)));
    setSelectedDeleteFiles(new Set(createdFiles.map((f) => f.filePath)));
  }, [availableFiles, createdFiles]);

  // Select none helper
  const selectNone = useCallback(() => {
    setSelectedRestoreFiles(new Set());
    setSelectedDeleteFiles(new Set());
  }, []);

  const { selectedIndex } = useMenuNavigation({
    items: fileItems,
    initialIndex: 0,
    wrapAround: true,
    onSelect: toggleCurrentFile, // Enter key toggles selection
    onCancel,
    additionalKeys: {
      // Space also toggles selection
      ' ': toggleCurrentFile,
      // Select all (both cases)
      a: selectAll,
      A: selectAll,
      // Select none (both cases)
      n: selectNone,
      N: selectNone,
      // Confirm restore (both cases)
      r: confirmRestore,
      R: confirmRestore,
      // Skip restoration (both cases)
      s: onSkip,
      S: onSkip,
    },
  });

  // Keep ref in sync with selected index
  selectedIndexRef.current = selectedIndex;

  // Handle window scrolling
  useEffect(() => {
    if (selectedIndex < windowStart) {
      setWindowStart(selectedIndex);
    } else if (selectedIndex >= windowStart + VISIBLE_COUNT) {
      setWindowStart(selectedIndex - VISIBLE_COUNT + 1);
    }
  }, [selectedIndex, windowStart]);

  const visibleSlice = useMemo(() => {
    const end = Math.min(windowStart + VISIBLE_COUNT, fileItems.length);
    return fileItems.slice(windowStart, end);
  }, [fileItems, windowStart]);

  const selectedRestoreCount = selectedRestoreFiles.size;
  const selectedDeleteCount = selectedDeleteFiles.size;
  const totalAvailable = availableFiles.length;
  const totalCreated = createdFiles.length;
  const totalEvicted = evictedFiles.length;

  // No files to show
  if (fileItems.length === 0) {
    return (
      <MenuContainer title={t('common:fileRestoreMenu.title')}>
        <Text color={COLORS.warning}>
          {t('common:fileRestoreMenu.noFileChanges')}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>{t('common:fileRestoreMenu.pressEscContinue')}</Text>
        </Box>
      </MenuContainer>
    );
  }

  const startDisplay = fileItems.length === 0 ? 0 : windowStart + 1;
  const endDisplay = Math.min(windowStart + VISIBLE_COUNT, fileItems.length);

  return (
    <MenuContainer
      title={t('common:fileRestoreMenu.restoreTitle')}
      helpText={t('common:fileRestoreMenu.helpText', {
        start: startDisplay,
        end: endDisplay,
        total: fileItems.length,
      })}
      showDefaultHelp={false}
    >
      <Box marginBottom={1} flexDirection="column">
        {totalAvailable > 0 && (
          <Text>
            <Text color={COLORS.primary}>{selectedRestoreCount}</Text>{' '}
            {t('common:fileRestoreMenu.editedFilesStatus', {
              total: totalAvailable,
            })}{' '}
            <Text color={COLORS.success}>
              {t('common:fileRestoreMenu.restoration')}
            </Text>
            .
          </Text>
        )}
        {totalCreated > 0 && (
          <Text>
            <Text color={COLORS.primary}>{selectedDeleteCount}</Text>{' '}
            {t('common:fileRestoreMenu.createdFilesStatus', {
              total: totalCreated,
            })}{' '}
            <Text color={COLORS.error}>
              {t('common:fileRestoreMenu.deletion')}
            </Text>
            .
          </Text>
        )}
        {totalEvicted > 0 && (
          <Text color={COLORS.warning}>
            {t('common:fileRestoreMenu.evictedFiles', { count: totalEvicted })}
          </Text>
        )}
      </Box>

      <Box flexDirection="column">
        {visibleSlice.map((item, index) => {
          const globalIndex = windowStart + index;
          const isCursor = globalIndex === selectedIndex;

          if (item.type === 'available') {
            const checkMark = item.selected ? '[x]' : '[ ]';
            const cursorColor = isCursor ? COLORS.primary : undefined;

            return (
              <Box key={item.filePath} flexDirection="row">
                <Text color={cursorColor}>{isCursor ? '> ' : '  '}</Text>
                <Text color={cursorColor}>{checkMark} </Text>
                <Text color={cursorColor}>{item.displayPath}</Text>
                <Text dimColor> ({formatBytes(item.snapshot!.size)})</Text>
                <Text color={COLORS.success} dimColor>
                  {' '}
                  {t('common:fileRestoreMenu.restoreLabel')}
                </Text>
              </Box>
            );
          }

          if (item.type === 'created') {
            const checkMark = item.selected ? '[x]' : '[ ]';
            const cursorColor = isCursor ? COLORS.primary : undefined;

            return (
              <Box key={item.filePath} flexDirection="row">
                <Text color={cursorColor}>{isCursor ? '> ' : '  '}</Text>
                <Text color={cursorColor}>{checkMark} </Text>
                <Text color={cursorColor}>{item.displayPath}</Text>
                <Text color={COLORS.error} dimColor>
                  {' '}
                  {t('common:fileRestoreMenu.deleteLabel')}
                </Text>
              </Box>
            );
          }

          // Evicted file
          return (
            <Box key={item.filePath} flexDirection="row">
              <Text color={COLORS.text.muted}>{isCursor ? '> ' : '  '}</Text>
              <Text color={COLORS.text.muted} strikethrough>
                {item.displayPath}
              </Text>
              <Text color={COLORS.warning} dimColor>
                {' '}
                {t('common:fileRestoreMenu.unavailable')}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{t('common:fileRestoreMenu.pressApplyOrSkip')}</Text>
      </Box>
    </MenuContainer>
  );
}
