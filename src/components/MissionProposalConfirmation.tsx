import { Box, Text } from 'ink';
import { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { TextInput } from '@/components/common/TextInput';
import { MarkdownText } from '@/components/MarkdownText';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import { MissionProposalAction } from '@/types/enums';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';

interface MissionProposalConfirmationProps {
  title?: string;
  proposal: string;
  missionFilePath?: string;
  onConfirm: (action: MissionProposalAction, comment?: string) => void;
  onCancel: () => void;
  isFocused?: boolean;
  width?: number;
}

interface MenuItem {
  label: string;
  action: MissionProposalAction;
  color: string;
}

export function MissionProposalConfirmation({
  title,
  proposal,
  missionFilePath,
  onConfirm,
  onCancel,
  isFocused = true,
  width,
}: MissionProposalConfirmationProps) {
  const { t } = useTranslation();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [stage, setStage] = useState<'choose-option' | 'enter-comment'>(
    'choose-option'
  );
  const [comment, setComment] = useState('');
  const sanitizedTitle = useMemo(
    () =>
      title === undefined
        ? undefined
        : sanitizeTerminalDisplayText(title, { stripSgr: true }),
    [title]
  );
  const sanitizedProposal = useMemo(
    () => sanitizeTerminalDisplayText(proposal, { stripSgr: true }),
    [proposal]
  );
  const sanitizedMissionFilePath = useMemo(
    () =>
      missionFilePath === undefined
        ? undefined
        : sanitizeTerminalDisplayText(missionFilePath, { stripSgr: true }),
    [missionFilePath]
  );

  const menuItems: MenuItem[] = [
    {
      label: t('common:missionProposalConfirmation.proceedWithProposal'),
      action: MissionProposalAction.Approve,
      color: COLORS.success,
    },
    {
      label: t('common:missionProposalConfirmation.proceedWithComment'),
      action: MissionProposalAction.ApproveWithComment,
      color: COLORS.success,
    },
    {
      label: t('common:missionProposalConfirmation.noAndExplain'),
      action: MissionProposalAction.Reject,
      color: COLORS.error,
    },
  ];

  const handleSelect = useCallback(
    async (indexOverride?: number) => {
      const index = indexOverride ?? selectedIndex;
      const selectedItem = menuItems[index];
      const action = selectedItem.action;

      if (action === MissionProposalAction.ApproveWithComment) {
        setStage('enter-comment');
        return;
      }

      // Clear any stale comment when not using ApproveWithComment
      // (user might have started typing a comment, pressed ESC, then selected another option)
      onConfirm(action, undefined);
    },
    [selectedIndex, onConfirm, menuItems]
  );

  const handleCommentSubmit = useCallback(() => {
    onConfirm(MissionProposalAction.ApproveWithComment, comment);
  }, [onConfirm, comment]);

  const handleInput = useCallback(
    (
      input: string,
      key: {
        upArrow?: boolean;
        downArrow?: boolean;
        return?: boolean;
        escape?: boolean;
        ctrl?: boolean;
      }
    ) => {
      // In enter-comment stage, only handle Esc to go back
      // TextInput handles all other input
      if (stage === 'enter-comment') {
        if (key.escape) {
          setComment('');
          setSelectedIndex(0);
          setStage('choose-option');
        }
        return;
      }

      // Handle navigation and selection
      if (key.escape) {
        onCancel();
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((prev) =>
          prev > 0 ? prev - 1 : menuItems.length - 1
        );
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((prev) =>
          prev < menuItems.length - 1 ? prev + 1 : 0
        );
        return;
      }

      if (key.return) {
        void handleSelect();
        return;
      }

      // Number shortcuts
      const num = parseInt(input || '', 10);
      if (!Number.isNaN(num) && num >= 1 && num <= menuItems.length) {
        const index = num - 1;
        setSelectedIndex(index);
        void handleSelect(index);
      }
    },
    [onCancel, stage, menuItems, handleSelect]
  );

  useKeypressHandler(handleInput, { isActive: isFocused });

  const { width: terminalWidth } = useTerminalDimensions();
  const safeWidth = Math.min(width ?? terminalWidth, terminalWidth) - 2;
  const proposalContentWidth = Math.max(1, safeWidth - 6);
  const helpText =
    stage === 'enter-comment'
      ? t('common:missionProposalConfirmation.helpComment')
      : t('common:missionProposalConfirmation.helpMenu', {
          count: menuItems.length,
        });

  return (
    <Box flexDirection="column" width={safeWidth}>
      <Box paddingLeft={2} flexDirection="column">
        <Text color={COLORS.agi}>
          {t('common:missionProposalConfirmation.title')}
        </Text>
        {sanitizedTitle && (
          <Text color={COLORS.text.muted}>{sanitizedTitle}</Text>
        )}
      </Box>

      {sanitizedMissionFilePath && (
        <Box paddingLeft={2}>
          <Text color={COLORS.agi}>
            {t('common:missionProposalConfirmation.willSaveTo', {
              path: sanitizedMissionFilePath,
            })}
          </Text>
        </Box>
      )}

      {sanitizedProposal.trim().length > 0 && (
        <Box paddingX={2} marginTop={1}>
          <Box
            borderStyle="round"
            borderColor={COLORS.agi}
            paddingX={1}
            flexDirection="column"
            width={safeWidth - 4}
          >
            <MarkdownText maxWidth={proposalContentWidth}>
              {sanitizedProposal}
            </MarkdownText>
          </Box>
        </Box>
      )}

      <MenuContainer
        width={safeWidth}
        helpText={helpText}
        showDefaultHelp={false}
        marginTop={0}
      >
        {stage === 'enter-comment' ? (
          <Box flexDirection="row">
            <Text color={COLORS.success}>
              {t('common:missionProposalConfirmation.commentLabel')}
            </Text>
            <TextInput
              focus={isFocused}
              showCursor
              value={comment}
              onChange={setComment}
              onSubmit={handleCommentSubmit}
              placeholder={t(
                'common:missionProposalConfirmation.commentPlaceholder'
              )}
            />
          </Box>
        ) : (
          <Box flexDirection="column">
            {menuItems.map((item, index) => {
              const isSelected = index === selectedIndex;

              return (
                <Box key={item.action}>
                  <Text
                    color={isSelected ? COLORS.text.primary : COLORS.text.muted}
                    bold={isSelected}
                  >
                    {item.label}
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}
      </MenuContainer>
    </Box>
  );
}
