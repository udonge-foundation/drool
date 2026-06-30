import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { FileRestoreChoice } from '@/components/enums';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';

interface FileRestoreChoiceMenuProps {
  /** Number of files available for restoration */
  restoreCount: number;
  /** Number of created files that would be deleted */
  deleteCount: number;
  /** Number of files that were evicted */
  evictedCount: number;
  /** Called when user selects an option */
  onSelect: (choice: FileRestoreChoice) => void;
  /** Called when user cancels */
  onCancel: () => void;
}

interface ChoiceItem {
  id: FileRestoreChoice;
  label: string;
  description: string;
}

export function FileRestoreChoiceMenu({
  restoreCount,
  deleteCount,
  evictedCount,
  onSelect,
  onCancel,
}: FileRestoreChoiceMenuProps) {
  const { t } = useTranslation();
  const choices = useMemo((): ChoiceItem[] => {
    const items: ChoiceItem[] = [];

    const totalActions = restoreCount + deleteCount;

    items.push({
      id: FileRestoreChoice.All,
      label: t('common:fileRestore.restoreAll'),
      description:
        totalActions > 0
          ? t('common:fileRestore.restoreAllDescription', {
              restoreCount,
              deleteCount,
            })
          : t('common:fileRestore.noFileChanges'),
    });

    items.push({
      id: FileRestoreChoice.Select,
      label: t('common:fileRestore.chooseFiles'),
      description: t('common:fileRestore.chooseFilesDescription'),
    });

    items.push({
      id: FileRestoreChoice.None,
      label: t('common:fileRestore.dontRestore'),
      description: t('common:fileRestore.dontRestoreDescription'),
    });

    return items;
  }, [restoreCount, deleteCount, t]);

  const { selectedIndex } = useMenuNavigation({
    items: choices,
    initialIndex: 0,
    wrapAround: true,
    onSelect: (item) => onSelect(item.id),
    onCancel,
  });

  const totalChanges = restoreCount + deleteCount;

  return (
    <MenuContainer
      title={t('common:fileRestore.title')}
      helpText={t('common:fileRestore.helpText')}
      showDefaultHelp={false}
    >
      <Box marginBottom={1} flexDirection="column">
        <Text>
          {t('common:fileRestore.fileChangesIntro', { count: totalChanges })}
        </Text>
        {restoreCount > 0 && (
          <Text>
            {'  '}•{' '}
            <Text color={COLORS.success}>
              {t('common:fileRestore.filesToRestore', { count: restoreCount })}
            </Text>
          </Text>
        )}
        {deleteCount > 0 && (
          <Text>
            {'  '}•{' '}
            <Text color={COLORS.error}>
              {t('common:fileRestore.filesToDelete', { count: deleteCount })}
            </Text>
          </Text>
        )}
        {evictedCount > 0 && (
          <Text color={COLORS.warning}>
            {'  '}•{' '}
            {t('common:fileRestore.filesUnavailable', { count: evictedCount })}
          </Text>
        )}
      </Box>

      <Box flexDirection="column">
        {choices.map((choice, index) => {
          const isCursor = index === selectedIndex;
          const cursorColor = isCursor ? COLORS.primary : undefined;

          return (
            <Box key={choice.id} flexDirection="column" marginBottom={1}>
              <Box flexDirection="row">
                <Text color={cursorColor}>{isCursor ? '> ' : '  '}</Text>
                <Text color={cursorColor} bold={isCursor}>
                  {choice.label}
                </Text>
              </Box>
              <Box marginLeft={4}>
                <Text dimColor>{choice.description}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </MenuContainer>
  );
}
