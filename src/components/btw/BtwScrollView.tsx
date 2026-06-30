import { Box, Text } from 'ink';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException } from '@industry/logging';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { TextInput } from '@/components/common/TextInput';
import { MarkdownText } from '@/components/MarkdownText';
import { Spinner } from '@/components/Spinner';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { matchKeyboardChord } from '@/keyboard/keyboardChords';
import { BtwEntryStatus } from '@/services/btw/enums';
import type { BtwEntry } from '@/services/btw/types';
import { TuiSpinnerPresetName } from '@/utils/tuiSpinner/enums';

interface BtwScrollViewProps {
  entries: ReadonlyArray<BtwEntry>;
  width: number;
  onDismiss: () => void;
  onRemoveEntry: (id: string) => void;
  onSubmitQuestion: (question: string) => void | Promise<void>;
}

const MAX_VISIBLE = 4;

/**
 * Scroll view shown in place of the chat input when user types `/btw`
 * with no arguments. Displays the latest questions and, for the highlighted
 * one, its answer. Esc returns focus to the input. Styled to match the
 * reskin menu pattern (MenuContainer + useMenuNavigation) used by /model,
 * /settings, /rewind, etc.
 */
export function BtwScrollView({
  entries,
  width,
  onDismiss,
  onRemoveEntry,
  onSubmitQuestion,
}: BtwScrollViewProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');

  const items: BtwEntry[] = useMemo(() => {
    if (entries.length <= MAX_VISIBLE) return entries.slice();
    return entries.slice(entries.length - MAX_VISIBLE);
  }, [entries]);

  const initialIndex = items.length === 0 ? 0 : items.length - 1;

  const selectedIndexRef = useRef(0);

  const handleRemove = useCallback(() => {
    const entry = items[selectedIndexRef.current];
    if (!entry) return;
    onRemoveEntry(entry.id);
    if (items.length <= 1) {
      onDismiss();
    }
  }, [items, onDismiss, onRemoveEntry]);

  const handleSubmitDraft = useCallback(
    (value: string) => {
      const question = value
        .trim()
        .replace(/^\/btw(?:\s+|$)/i, '')
        .trim();
      setDraft('');
      if (!question) return;

      void Promise.resolve(onSubmitQuestion(question)).catch((error) => {
        logException(error, 'Error submitting /btw question from menu');
      });
    },
    [onSubmitQuestion]
  );

  const { selectedIndex } = useMenuNavigation<BtwEntry>({
    items,
    initialIndex,
    wrapAround: true,
    enableCharKeys: false,
    onSelect: () => {
      handleSubmitDraft(draft);
    },
    onCancel: onDismiss,
  });

  useKeypressHandler(
    (input, key) => {
      if (matchKeyboardChord({ input, key }, 'ctrl-x')) {
        handleRemove();
      }
    },
    { isActive: items.length > 0 }
  );

  const displaySelectedIndex =
    selectedIndex >= items.length
      ? Math.max(0, items.length - 1)
      : selectedIndex;
  selectedIndexRef.current = displaySelectedIndex;

  const selectedEntry = items[displaySelectedIndex] ?? null;
  const contentWidth = Math.max(20, width - 4);

  const inputField = (
    <Box marginTop={1} flexDirection="column">
      <Box flexDirection="row">
        <Text color={COLORS.btw}>{t('common:btw.inputPrefix')} </Text>
        <TextInput
          value={draft}
          onChange={setDraft}
          onSubmit={handleSubmitDraft}
          placeholder={t('common:btw.inputPlaceholder')}
        />
      </Box>
    </Box>
  );

  if (items.length === 0) {
    return (
      <MenuContainer
        title={t('common:btw.scrollTitle')}
        titleBold={false}
        width={width}
        minWidth={Math.min(40, width)}
        helpText={t('common:btw.emptyHelpText')}
        showDefaultHelp={false}
      >
        <Text color={COLORS.text.muted}>{t('common:btw.emptyHint')}</Text>
        {inputField}
      </MenuContainer>
    );
  }

  return (
    <MenuContainer
      title={t('common:btw.scrollTitle')}
      titleBold={false}
      width={width}
      minWidth={Math.min(40, width)}
      helpText={t('common:btw.scrollHelpText')}
      showDefaultHelp={false}
    >
      {items.map((entry, index) => {
        const isSelected = index === displaySelectedIndex;
        const truncated =
          entry.question.length > contentWidth - 4
            ? `${entry.question.slice(0, contentWidth - 5)}…`
            : entry.question;
        const statusSuffix =
          entry.status === BtwEntryStatus.Streaming ||
          entry.status === BtwEntryStatus.Pending
            ? ' …'
            : entry.status === BtwEntryStatus.Error
              ? ' ✗'
              : '';
        return (
          <Box key={entry.id} flexDirection="row">
            <Text
              bold={isSelected}
              color={isSelected ? COLORS.text.primary : COLORS.text.muted}
            >
              {truncated}
              {statusSuffix}
            </Text>
          </Box>
        );
      })}
      {selectedEntry && (
        <Box marginTop={1} flexDirection="column" paddingLeft={2}>
          <Text color={COLORS.text.menuSectionHeader}>
            {t('common:btw.answerLabel')}
          </Text>
          {selectedEntry.answer ? (
            <Box marginTop={0}>
              <MarkdownText
                color={COLORS.text.primary}
                maxWidth={contentWidth - 2}
              >
                {selectedEntry.answer}
              </MarkdownText>
            </Box>
          ) : null}
          {selectedEntry.status === BtwEntryStatus.Pending ||
          selectedEntry.status === BtwEntryStatus.Streaming ? (
            <Box marginTop={0} flexDirection="row" gap={1}>
              <Spinner preset={TuiSpinnerPresetName.Dots10} />
              <Text color={COLORS.text.muted}>{t('common:btw.answering')}</Text>
            </Box>
          ) : !selectedEntry.answer ? (
            <Box marginTop={0}>
              <Text color={COLORS.text.muted}>{t('common:btw.noAnswer')}</Text>
            </Box>
          ) : null}
        </Box>
      )}
      {inputField}
    </MenuContainer>
  );
}
