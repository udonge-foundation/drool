import * as path from 'path';

import { Box, Text } from 'ink';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { AutonomyLevel } from '@industry/drool-sdk-ext/protocol/shared';
import { logInfo } from '@industry/logging';
import { getFlag } from '@industry/runtime/feature-flags';
import {
  clampAutonomyLevelToMax,
  getAllowedAutonomyLevels,
} from '@industry/utils';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { TextInput } from '@/components/common/TextInput';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import { matchKeyboardChord } from '@/keyboard/keyboardChords';
import { getEditorService } from '@/services/EditorService';
import { getSettingsService } from '@/services/SettingsService';
import { SpecModeAction } from '@/types/enums';
import { getContextSavingsPercentage } from '@/utils/contextPercentage';
import { detectEditor } from '@/utils/editorDetection';
import { calculateSpecFilePath } from '@/utils/industryPaths';

enum ConfirmationStage {
  ChooseOption = 'choose-option',
  EnterComment = 'enter-comment',
  Editing = 'editing',
  ChooseAutonomy = 'choose-autonomy',
}

interface SpecModeConfirmationProps {
  title?: string;
  plan: string;
  onConfirm: (
    action: SpecModeAction,
    comment?: string,
    autonomyLevel?: AutonomyLevel,
    editedSpecContent?: string
  ) => void;
  onCancel: () => void;
  onEditorGuidance?: (message: string | null) => void;
  onReasoningCycle?: () => void;
  isFocused?: boolean;
  width?: number;
  lastTokenUsage?: number | null;
  ctrlCPressed?: boolean;
  defaultAutonomyLevel?: AutonomyLevel;
}

interface MenuItem {
  label: string;
  action: SpecModeAction;
}

interface AutonomyMenuItem {
  label: string;
  level: AutonomyLevel;
}

interface PendingAutonomyConfirmation {
  returnStage: ConfirmationStage.ChooseOption | ConfirmationStage.EnterComment;
  confirm: (level: AutonomyLevel) => void;
}

function getApprovalActionForAutonomyLevel(
  level: AutonomyLevel
): SpecModeAction {
  switch (level) {
    case AutonomyLevel.Low:
      return SpecModeAction.ApproveLow;
    case AutonomyLevel.Medium:
      return SpecModeAction.ApproveMedium;
    case AutonomyLevel.High:
      return SpecModeAction.ApproveHigh;
    case AutonomyLevel.Off:
    default:
      return SpecModeAction.Approve;
  }
}

export function SpecModeConfirmation({
  title,
  plan,
  onConfirm,
  onCancel,
  onEditorGuidance,
  onReasoningCycle,
  isFocused = true,
  width = 95,
  lastTokenUsage,
  ctrlCPressed,
  defaultAutonomyLevel,
}: SpecModeConfirmationProps) {
  const { t } = useTranslation();
  const settings = getSettingsService();
  const specSaveDirSetting = settings.getSpecSaveDir();
  const maxAutonomyLevel = settings.getMaxAutonomyLevel();
  const allowedAutonomyLevels = useMemo(
    () => getAllowedAutonomyLevels(maxAutonomyLevel),
    [maxAutonomyLevel]
  );
  const [selectedAutonomyLevel, setSelectedAutonomyLevel] =
    useState<AutonomyLevel>(() =>
      clampAutonomyLevelToMax(
        defaultAutonomyLevel ??
          settings.getAutonomyLevel() ??
          AutonomyLevel.Off,
        maxAutonomyLevel
      )
    );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [actualSpecPath, setActualSpecPath] = useState<string | null>(null);
  const [stage, setStage] = useState<ConfirmationStage>(
    ConfirmationStage.ChooseOption
  );
  const [comment, setComment] = useState('');
  const pendingAutonomyConfirmationRef =
    useRef<PendingAutonomyConfirmation | null>(null);
  const [autonomySelectedIndex, setAutonomySelectedIndex] = useState(0);
  const [editFilePath, setEditFilePath] = useState<string | null>(null);
  const editCleanupRef = useRef<(() => Promise<void>) | null>(null);
  const editReadContentRef = useRef<(() => Promise<string>) | null>(null);
  const editInProgressRef = useRef(false);
  const editAutonomyLevelRef = useRef<AutonomyLevel | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [isOpeningEditor, setIsOpeningEditor] = useState(false);

  const [contextSavingsPercent, setContextSavingsPercent] = useState<
    number | null
  >(null);
  useEffect(() => {
    let cancelled = false;
    getContextSavingsPercentage(lastTokenUsage, plan)
      .then((value) => {
        if (!cancelled) setContextSavingsPercent(value);
      })
      .catch(() => {
        if (!cancelled) setContextSavingsPercent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [lastTokenUsage, plan]);

  // Detect which editor will be used for editing.
  const { editor, editorSource } = detectEditor();

  useEffect(() => {
    calculateSpecFilePath(specSaveDirSetting, title, plan)
      .then(setActualSpecPath)
      .catch((error) => {
        logInfo('[SpecModeConfirmation] Failed to calculate spec path', {
          error,
        });
        setActualSpecPath(null);
      });
  }, [title, plan, specSaveDirSetting]);

  const isNewSessionHandoffEnabled = getFlag(
    IndustryFeatureFlags.SpecNewSessionHandoff
  );

  const menuItems: MenuItem[] = useMemo(
    () => [
      {
        label: t('common:specModeConfirmation.proceedWithProposal'),
        action: SpecModeAction.Approve,
      },
      {
        label: t('common:specModeConfirmation.proceedWithComment'),
        action: SpecModeAction.ApproveWithComment,
      },
      ...(isNewSessionHandoffEnabled
        ? [
            {
              label:
                contextSavingsPercent !== null
                  ? t('common:specModeConfirmation.proceedAndClearContext', {
                      savings: contextSavingsPercent,
                    })
                  : t(
                      'common:specModeConfirmation.proceedAndClearContextNoPercent'
                    ),
              action: SpecModeAction.ApproveNewSession,
            },
          ]
        : []),
      {
        label: t('common:specModeConfirmation.manuallyEditSpec'),
        action: SpecModeAction.Edit,
      },
      {
        label: t('common:specModeConfirmation.noAndExplain'),
        action: SpecModeAction.Reject,
      },
    ],
    [contextSavingsPercent, isNewSessionHandoffEnabled, t]
  );

  const autonomyMenuItems: AutonomyMenuItem[] = useMemo(
    () =>
      allowedAutonomyLevels.map((level) => {
        switch (level) {
          case AutonomyLevel.Low:
            return {
              label: t('common:specModeConfirmation.proceedLowAutonomy'),
              level,
            };
          case AutonomyLevel.Medium:
            return {
              label: t('common:specModeConfirmation.proceedMediumAutonomy'),
              level,
            };
          case AutonomyLevel.High:
            return {
              label: t('common:specModeConfirmation.proceedHighAutonomy'),
              level,
            };
          case AutonomyLevel.Off:
          default:
            return {
              label: t('common:specModeConfirmation.proceedManualApprovals'),
              level: AutonomyLevel.Off,
            };
        }
      }),
    [allowedAutonomyLevels, t]
  );

  const cleanupEditTempDir = useCallback(async () => {
    const cleanup = editCleanupRef.current;
    editCleanupRef.current = null;
    editReadContentRef.current = null;
    setEditFilePath(null);

    if (!cleanup) {
      return;
    }

    try {
      await cleanup();
    } catch (error) {
      logInfo('[SpecModeConfirmation] Failed to clean up edit temp dir', {
        error,
      });
    }
  }, []);

  useEffect(() => {
    setSelectedAutonomyLevel((level) =>
      clampAutonomyLevelToMax(level, maxAutonomyLevel)
    );
  }, [maxAutonomyLevel]);

  const chooseAutonomyForConfirmation = useCallback(
    (pendingConfirmation: PendingAutonomyConfirmation) => {
      const clampedLevel = clampAutonomyLevelToMax(
        selectedAutonomyLevel,
        maxAutonomyLevel
      );
      const nextAutonomyIndex = autonomyMenuItems.findIndex(
        (item) => item.level === clampedLevel
      );
      pendingAutonomyConfirmationRef.current = pendingConfirmation;
      setSelectedAutonomyLevel(clampedLevel);
      setAutonomySelectedIndex(Math.max(0, nextAutonomyIndex));
      setStage(ConfirmationStage.ChooseAutonomy);
    },
    [autonomyMenuItems, maxAutonomyLevel, selectedAutonomyLevel]
  );

  const confirmEditedSpecWithAutonomyLevel = useCallback(
    (level: AutonomyLevel, editedSpecContent: string) => {
      onEditorGuidance?.(null);
      setSelectedAutonomyLevel(level);
      onConfirm(
        getApprovalActionForAutonomyLevel(level),
        comment || undefined,
        undefined,
        editedSpecContent
      );
    },
    [comment, onConfirm, onEditorGuidance]
  );

  const confirmEditedSpecOrChooseAutonomy = useCallback(
    (editedSpecContent: string) => {
      const confirmedAutonomyLevel = editAutonomyLevelRef.current;
      if (confirmedAutonomyLevel !== null) {
        editAutonomyLevelRef.current = null;
        confirmEditedSpecWithAutonomyLevel(
          confirmedAutonomyLevel,
          editedSpecContent
        );
        return;
      }

      chooseAutonomyForConfirmation({
        returnStage: ConfirmationStage.ChooseOption,
        confirm: (level) =>
          confirmEditedSpecWithAutonomyLevel(level, editedSpecContent),
      });
    },
    [chooseAutonomyForConfirmation, confirmEditedSpecWithAutonomyLevel]
  );

  const handleEditSelected = useCallback(
    async (confirmedAutonomyLevel: AutonomyLevel) => {
      if (editInProgressRef.current) {
        return;
      }

      editInProgressRef.current = true;
      editAutonomyLevelRef.current = confirmedAutonomyLevel;
      setIsOpeningEditor(true);
      setEditError(null);
      setStage(ConfirmationStage.Editing);

      try {
        await cleanupEditTempDir();

        const fileName = actualSpecPath
          ? path.basename(actualSpecPath)
          : 'spec.md';
        const editorResult = await getEditorService().openTextAndWait({
          content: plan,
          fileName,
          tempDirPrefix: 'industry-spec-edit-',
        });
        if (!editorResult.success) {
          setEditError(editorResult.error ?? 'Failed to open editor.');
          return;
        }

        if (editorResult.isAsyncEditor) {
          editCleanupRef.current = editorResult.cleanup;
          editReadContentRef.current = editorResult.readContent;
          setEditFilePath(editorResult.filePath);
          onEditorGuidance?.(
            t('common:specModeConfirmation.saveAndCloseEditor', {
              filePath: editorResult.filePath,
            })
          );
          return;
        }

        confirmEditedSpecOrChooseAutonomy(editorResult.content);
      } catch (error) {
        setEditError(error instanceof Error ? error.message : String(error));
      } finally {
        editInProgressRef.current = false;
        setIsOpeningEditor(false);
      }
    },
    [
      actualSpecPath,
      cleanupEditTempDir,
      confirmEditedSpecOrChooseAutonomy,
      onEditorGuidance,
      plan,
      t,
    ]
  );

  const confirmWithAutonomyLevel = useCallback(
    (level: AutonomyLevel) => {
      const pending = pendingAutonomyConfirmationRef.current;
      if (!pending) {
        return;
      }

      pendingAutonomyConfirmationRef.current = null;
      onEditorGuidance?.(null);
      setSelectedAutonomyLevel(level);
      pending.confirm(level);
    },
    [onEditorGuidance]
  );

  const handleEditingBack = useCallback(() => {
    void cleanupEditTempDir();
    editAutonomyLevelRef.current = null;
    onEditorGuidance?.(null);
    setEditError(null);
    setSelectedIndex(
      Math.max(
        0,
        menuItems.findIndex((item) => item.action === SpecModeAction.Edit)
      )
    );
    setStage(ConfirmationStage.ChooseOption);
  }, [cleanupEditTempDir, menuItems, onEditorGuidance]);

  const handleEditingDone = useCallback(async () => {
    const readContent = editReadContentRef.current;
    if (isOpeningEditor || editError || !editFilePath || !readContent) {
      return;
    }

    try {
      const finalEditedSpecContent = await readContent();
      await cleanupEditTempDir();
      confirmEditedSpecOrChooseAutonomy(finalEditedSpecContent);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    }
  }, [
    cleanupEditTempDir,
    editError,
    editFilePath,
    isOpeningEditor,
    confirmEditedSpecOrChooseAutonomy,
  ]);

  const handleSelect = useCallback(
    (indexOverride?: number) => {
      const index = indexOverride ?? selectedIndex;
      const selectedItem = menuItems[index];
      const action = selectedItem.action;

      if (stage === ConfirmationStage.ChooseOption) {
        if (action === SpecModeAction.Approve) {
          chooseAutonomyForConfirmation({
            returnStage: ConfirmationStage.ChooseOption,
            confirm: (level) =>
              onConfirm(
                getApprovalActionForAutonomyLevel(level),
                comment || undefined,
                undefined,
                undefined
              ),
          });
          return;
        }
        if (action === SpecModeAction.ApproveWithComment) {
          setStage(ConfirmationStage.EnterComment);
          return;
        }
        if (action === SpecModeAction.ApproveNewSession) {
          chooseAutonomyForConfirmation({
            returnStage: ConfirmationStage.ChooseOption,
            confirm: (level) =>
              onConfirm(
                SpecModeAction.ApproveNewSession,
                comment || undefined,
                level
              ),
          });
          return;
        }
        if (action === SpecModeAction.Edit) {
          chooseAutonomyForConfirmation({
            returnStage: ConfirmationStage.ChooseOption,
            confirm: (level) => {
              void handleEditSelected(level);
            },
          });
          return;
        }
      }

      onConfirm(action, comment || undefined);
    },
    [
      selectedIndex,
      onConfirm,
      menuItems,
      stage,
      handleEditSelected,
      comment,
      chooseAutonomyForConfirmation,
    ]
  );

  const handleCommentSubmit = useCallback(
    (submittedComment?: string) => {
      const nextComment = submittedComment ?? comment;
      setComment(nextComment);
      chooseAutonomyForConfirmation({
        returnStage: ConfirmationStage.EnterComment,
        confirm: (level) =>
          onConfirm(
            getApprovalActionForAutonomyLevel(level),
            nextComment || undefined,
            undefined,
            undefined
          ),
      });
    },
    [chooseAutonomyForConfirmation, comment, onConfirm]
  );

  const handleInput = useCallback(
    (
      input: string,
      key: {
        upArrow?: boolean;
        downArrow?: boolean;
        return?: boolean;
        escape?: boolean;
        ctrl?: boolean;
        tab?: boolean;
        shift?: boolean;
        name?: string;
        sequence?: string;
      }
    ) => {
      if (matchKeyboardChord({ input, key }, 'reasoning-cycle')) {
        onReasoningCycle?.();
        return;
      }

      // In enter-comment stage, only handle Esc to go back
      // TextInput handles all other input
      if (stage === ConfirmationStage.EnterComment) {
        if (matchKeyboardChord({ input, key }, 'escape')) {
          setComment('');
          setSelectedIndex(0);
          setStage(ConfirmationStage.ChooseOption);
        }
        return;
      }

      if (stage === ConfirmationStage.Editing) {
        if (matchKeyboardChord({ input, key }, 'escape')) {
          handleEditingBack();
          return;
        }
        if (matchKeyboardChord({ input, key }, 'enter')) {
          void handleEditingDone();
          return;
        }
        return;
      }

      if (stage === ConfirmationStage.ChooseAutonomy) {
        if (matchKeyboardChord({ input, key }, 'escape')) {
          setStage(
            pendingAutonomyConfirmationRef.current?.returnStage ??
              ConfirmationStage.ChooseOption
          );
          pendingAutonomyConfirmationRef.current = null;
          return;
        }

        if (matchKeyboardChord({ input, key }, 'up-arrow')) {
          setAutonomySelectedIndex((prev) =>
            prev > 0 ? prev - 1 : autonomyMenuItems.length - 1
          );
          return;
        }

        if (matchKeyboardChord({ input, key }, 'down-arrow')) {
          setAutonomySelectedIndex((prev) =>
            prev < autonomyMenuItems.length - 1 ? prev + 1 : 0
          );
          return;
        }

        if (matchKeyboardChord({ input, key }, 'enter')) {
          const selectedAutonomyItem = autonomyMenuItems[autonomySelectedIndex];
          if (selectedAutonomyItem) {
            confirmWithAutonomyLevel(selectedAutonomyItem.level);
          }
          return;
        }

        const num = parseInt(input || '', 10);
        const itemCount = autonomyMenuItems.length;
        if (!Number.isNaN(num) && num >= 1 && num <= itemCount) {
          const index = num - 1;
          confirmWithAutonomyLevel(autonomyMenuItems[index].level);
        }
        return;
      }

      // Handle navigation and selection
      if (matchKeyboardChord({ input, key }, 'escape')) {
        onCancel();
        return;
      }

      if (matchKeyboardChord({ input, key }, 'up-arrow')) {
        setSelectedIndex((prev) =>
          prev > 0 ? prev - 1 : menuItems.length - 1
        );
        return;
      }

      if (matchKeyboardChord({ input, key }, 'down-arrow')) {
        setSelectedIndex((prev) =>
          prev < menuItems.length - 1 ? prev + 1 : 0
        );
        return;
      }

      if (matchKeyboardChord({ input, key }, 'enter')) {
        handleSelect();
        return;
      }

      // ctrl-g shortcut for Edit plan and continue (only in choose-option stage)
      if (
        stage === ConfirmationStage.ChooseOption &&
        ((!key.ctrl && input === '[103;5u') || (key.ctrl && input === 'g'))
      ) {
        const editIndex = menuItems.findIndex(
          (item) => item.action === SpecModeAction.Edit
        );
        if (editIndex >= 0) {
          setSelectedIndex(editIndex);
          handleSelect(editIndex);
        }
        return;
      }

      // Number shortcuts
      const num = parseInt(input || '', 10);
      const itemCount = menuItems.length;
      if (!Number.isNaN(num) && num >= 1 && num <= itemCount) {
        const index = num - 1;
        setSelectedIndex(index);
        handleSelect(index); // Pass index directly to avoid stale state
      }
    },
    [
      onCancel,
      stage,
      menuItems,
      handleSelect,
      handleEditingDone,
      handleEditingBack,
      onReasoningCycle,
      autonomyMenuItems,
      autonomySelectedIndex,
      confirmWithAutonomyLevel,
    ]
  );

  useKeypressHandler(handleInput, { isActive: isFocused, isPrimary: true });

  const { width: terminalWidth } = useTerminalDimensions();
  const safeWidth = Math.min(width, terminalWidth) - 2;

  const editorSuffix =
    editorSource === 'IDE' ? editor : `${editor} via ${editorSource}`;

  return (
    <Box flexDirection="column" width={safeWidth} paddingLeft={1}>
      <Box paddingLeft={3} marginBottom={1}>
        <Text color={COLORS.spec}>
          {t('common:specModeConfirmation.willSaveTo', {
            path:
              actualSpecPath || t('common:specModeConfirmation.calculating'),
          })}
        </Text>
      </Box>

      <MenuContainer
        width={safeWidth}
        helpText={
          stage === ConfirmationStage.EnterComment
            ? 'Enter submit · Tab reasoning · Esc back'
            : stage === ConfirmationStage.Editing
              ? '↵ done · Tab reasoning · Esc back'
              : stage === ConfirmationStage.ChooseAutonomy
                ? `↑↓ navigate · 1-${autonomyMenuItems.length} select · Enter select · Tab reasoning · Esc back`
                : `↑↓ navigate · 1-${menuItems.length} select · Enter select · Tab reasoning · Esc cancel`
        }
        showDefaultHelp={false}
        marginTop={0}
      >
        <Box flexDirection="column">
          {stage === ConfirmationStage.EnterComment ? (
            <Box flexDirection="row">
              <Text color={COLORS.success}>
                {t('common:specModeConfirmation.commentLabel')}
              </Text>
              <TextInput
                focus={isFocused}
                showCursor
                value={comment}
                onChange={setComment}
                onSubmit={handleCommentSubmit}
                placeholder={t(
                  'common:specModeConfirmation.commentPlaceholder'
                )}
              />
            </Box>
          ) : stage === ConfirmationStage.Editing ? (
            <Text color={editError ? COLORS.error : COLORS.text.secondary}>
              {editError
                ? t('common:specModeConfirmation.editorError', {
                    error: editError,
                  })
                : isOpeningEditor
                  ? t('common:specModeConfirmation.openingEditor')
                  : t('common:specModeConfirmation.saveAndCloseEditor', {
                      filePath: editFilePath ?? '',
                    })}
            </Text>
          ) : stage === ConfirmationStage.ChooseAutonomy ? (
            <Box flexDirection="column">
              {autonomyMenuItems.map((item, index) => {
                const isSelected = index === autonomySelectedIndex;

                return (
                  <Box key={item.level}>
                    <Text
                      color={
                        isSelected ? COLORS.text.primary : COLORS.text.muted
                      }
                      bold={isSelected}
                    >
                      {index + 1}. {item.label}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          ) : (
            <Box flexDirection="column">
              {comment && (
                <Box marginBottom={1}>
                  <Text color={COLORS.text.muted}>
                    {t('common:specModeConfirmation.commentLabel')}
                  </Text>
                  <Text color={COLORS.text.secondary}>{comment}</Text>
                </Box>
              )}
              {menuItems.map((item, index) => {
                const isSelected = index === selectedIndex;
                const isEditOption = item.action === SpecModeAction.Edit;

                return (
                  <Box key={item.action}>
                    <Text
                      color={
                        isSelected ? COLORS.text.primary : COLORS.text.muted
                      }
                      bold={isSelected}
                    >
                      {index + 1}. {item.label}
                      {isEditOption && (
                        <Text color={COLORS.text.muted}> ({editorSuffix})</Text>
                      )}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>
      </MenuContainer>
      {ctrlCPressed && (
        <Box paddingLeft={2}>
          <Text color={COLORS.text.muted}>
            {t('common:process.ctrlCToExit').trim()}
          </Text>
        </Box>
      )}
    </Box>
  );
}
