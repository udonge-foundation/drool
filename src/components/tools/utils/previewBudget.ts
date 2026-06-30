import { ToolPreviewTier } from '@/components/tools/enums';
import type { ToolPreviewBudget } from '@/components/tools/types';

const MAX_VIEWPORT_HEIGHT_BY_TIER: Record<
  Exclude<ToolPreviewTier, ToolPreviewTier.LG>,
  number
> = {
  [ToolPreviewTier.XS]: 24,
  [ToolPreviewTier.SM]: 32,
  [ToolPreviewTier.MD]: 44,
};

const MAX_PREVIEW_LINES_BY_TIER: Record<ToolPreviewTier, number> = {
  [ToolPreviewTier.XS]: 7,
  [ToolPreviewTier.SM]: 9,
  [ToolPreviewTier.MD]: 11,
  [ToolPreviewTier.LG]: 13,
};

export function getToolPreviewTier(viewportHeight: number): ToolPreviewTier {
  if (viewportHeight <= MAX_VIEWPORT_HEIGHT_BY_TIER[ToolPreviewTier.XS]) {
    return ToolPreviewTier.XS;
  }

  if (viewportHeight <= MAX_VIEWPORT_HEIGHT_BY_TIER[ToolPreviewTier.SM]) {
    return ToolPreviewTier.SM;
  }

  if (viewportHeight <= MAX_VIEWPORT_HEIGHT_BY_TIER[ToolPreviewTier.MD]) {
    return ToolPreviewTier.MD;
  }

  return ToolPreviewTier.LG;
}

export function getToolPreviewBudget(
  viewportHeight: number
): ToolPreviewBudget {
  const tier = getToolPreviewTier(viewportHeight);

  return {
    viewportHeight,
    tier,
    maxLines: MAX_PREVIEW_LINES_BY_TIER[tier],
  };
}
