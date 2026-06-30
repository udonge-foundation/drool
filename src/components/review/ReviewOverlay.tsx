import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { logError } from '@industry/logging';

import { COLORS } from '@/components/chat/themedColors';
import { BaseBranchScreen } from '@/components/review/BaseBranchScreen';
import { CommitSelectionScreen } from '@/components/review/CommitSelectionScreen';
import { CustomInstructionsScreen } from '@/components/review/CustomInstructionsScreen';
import { ReviewPresetType, ReviewStep } from '@/components/review/enums';
import { PresetSelectionScreen } from '@/components/review/PresetSelectionScreen';
import type { CommitInfo, ReviewPreset } from '@/components/review/types';
import { Spinner } from '@/components/Spinner';
import type { UseReviewManager } from '@/hooks/types';
import { generateReviewMessage } from '@/services/review/review-message-generator';

type Props = {
  width: number;
  controller: UseReviewManager;
};

export function ReviewOverlay({ width, controller }: Props) {
  const { t } = useTranslation();
  // Handle preset selection and navigate to appropriate next step
  const handlePresetSelection = async (preset: ReviewPreset) => {
    controller.setPreset(preset);

    // Navigate to the appropriate next step based on preset
    switch (preset.id) {
      case ReviewPresetType.BaseBranch:
        controller.setStep(ReviewStep.BaseBranch);
        break;
      case ReviewPresetType.Commit:
        controller.setStep(ReviewStep.Commit);
        break;
      case ReviewPresetType.Custom:
        controller.setStep(ReviewStep.CustomInstructions);
        break;
      case ReviewPresetType.Uncommitted:
        // For uncommitted changes, start review immediately
        try {
          const { openingLine, fullMessage } = await generateReviewMessage({
            preset,
          });
          controller.startReview(openingLine, fullMessage);
        } catch (error) {
          logError('Failed to start review (preset selection)', { error });
          controller.setError(t('common:review.failedToStartReview'));
        }
        break;
      default:
        // Should not reach here, but handle gracefully
        controller.setStep(ReviewStep.Preset);
        break;
    }
  };

  const handleBaseBranchSelection = async (branch: string) => {
    controller.setBaseBranch(branch);

    // Generate review message and start review
    try {
      const { openingLine, fullMessage } = await generateReviewMessage({
        preset: controller.preset!,
        baseBranch: branch,
        currentBranch: controller.currentBranch || undefined,
      });
      controller.startReview(openingLine, fullMessage);
    } catch (error) {
      logError('Failed to start review (base branch selection)', { error });
      controller.setError(t('common:review.failedToStartReview'));
    }
  };

  const handleCommitSelection = async (commit: CommitInfo) => {
    controller.setTargetCommit(commit);

    // Generate review message and start review
    try {
      const { openingLine, fullMessage } = await generateReviewMessage({
        preset: controller.preset!,
        commit,
      });
      controller.startReview(openingLine, fullMessage);
    } catch (error) {
      logError('Failed to start review (commit selection)', { error });
      controller.setError(t('common:review.failedToStartReview'));
    }
  };

  const handleCustomInstructions = async (instructions: string) => {
    controller.setCustomInstructions(instructions);

    // Generate review message and start review
    try {
      const { openingLine, fullMessage } = await generateReviewMessage({
        preset: controller.preset!,
        customInstructions: instructions,
      });
      controller.startReview(openingLine, fullMessage);
    } catch (error) {
      logError('Failed to start review (custom instructions)', { error });
      controller.setError(t('common:review.failedToStartReview'));
    }
  };

  // Render appropriate screen based on current step
  switch (controller.step) {
    case ReviewStep.Preset:
      return (
        <PresetSelectionScreen width={width} onSelect={handlePresetSelection} />
      );

    case ReviewStep.BaseBranch:
      return (
        <BaseBranchScreen
          width={width}
          currentBranch={controller.currentBranch}
          onSelect={handleBaseBranchSelection}
        />
      );

    case ReviewStep.Commit:
      return (
        <CommitSelectionScreen width={width} onSelect={handleCommitSelection} />
      );

    case ReviewStep.CustomInstructions:
      return (
        <CustomInstructionsScreen
          width={width}
          onSubmit={handleCustomInstructions}
        />
      );

    case ReviewStep.Progress:
      // This state should not be reached anymore as review starts immediately
      // Keeping as fallback
      return (
        <Box
          width={width}
          flexDirection="column"
          paddingX={2}
          paddingY={1}
          borderStyle="round"
          borderColor={COLORS.border}
        >
          <Text bold>{t('common:review.startingReview')}</Text>
          <Box marginTop={1}>
            <Text color={COLORS.primary}>
              <Spinner /> {t('common:review.preparingReview')}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {t('common:review.reviewStartNote')}
            </Text>
          </Box>
        </Box>
      );

    case ReviewStep.Results:
      // This state is not used - results show in main session
      return null;

    default:
      return null;
  }
}
