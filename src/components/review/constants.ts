import { ReviewPresetType } from '@/components/review/enums';
import type { ReviewPreset } from '@/components/review/types';

/**
 * Review presets — the name/description fields here are translation keys.
 * Render them with t() in components.
 */
export const REVIEW_PRESETS: ReviewPreset[] = [
  {
    id: ReviewPresetType.BaseBranch,
    name: 'common:review.presetBaseBranch',
    description: 'common:review.presetBaseBranchDesc',
    requiresBaseBranch: true,
  },
  {
    id: ReviewPresetType.Uncommitted,
    name: 'common:review.presetUncommitted',
    description: 'common:review.presetUncommittedDesc',
  },
  {
    id: ReviewPresetType.Commit,
    name: 'common:review.presetCommit',
    description: 'common:review.presetCommitDesc',
    requiresCommit: true,
  },
  {
    id: ReviewPresetType.Custom,
    name: 'common:review.presetCustom',
    description: 'common:review.presetCustomDesc',
    requiresInstructions: true,
  },
];
