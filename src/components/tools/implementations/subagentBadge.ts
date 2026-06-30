import { COLORS } from '@/components/chat/themedColors';
import { ToolHeaderBadge } from '@/components/tools/registry/types';

type BadgeColors = { backgroundColor: string; textColor: string };

function getSubagentBadgeColors(): BadgeColors[] {
  return COLORS.subagent.badgeColors.map((c) => ({
    backgroundColor: c.bg,
    textColor: c.fg,
  }));
}

function getBuiltInBadgeColors(): Record<string, BadgeColors> {
  const colors = getSubagentBadgeColors();
  return {
    worker: colors[0],
    explorer: colors[1],
  };
}

function getBadgeColorsForSubagentType(subagentType: string): BadgeColors {
  const builtIn = getBuiltInBadgeColors()[subagentType.toLowerCase()];
  if (builtIn) return builtIn;

  const badgeColors = getSubagentBadgeColors();
  const HASH_MODULUS = 0x7fffffff;
  let hash = 0;
  for (let i = 0; i < subagentType.length; i++) {
    hash = (hash * 31 + subagentType.charCodeAt(i)) % HASH_MODULUS;
  }
  return badgeColors[hash % badgeColors.length];
}

function formatSubagentBadgeText(subagentType: string): string {
  if (!subagentType) return subagentType;
  return subagentType.charAt(0).toUpperCase() + subagentType.slice(1);
}

export function getSubagentPlaceholderBadge(): ToolHeaderBadge {
  return {
    text: '···',
    backgroundColor: COLORS.subagent.placeholderBg,
    textColor: COLORS.subagent.placeholderFg,
  };
}

export function getSubagentBadge(
  subagentType: string | undefined
): ToolHeaderBadge {
  if (!subagentType) {
    return getSubagentPlaceholderBadge();
  }

  return {
    text: formatSubagentBadgeText(subagentType),
    ...getBadgeColorsForSubagentType(subagentType),
  };
}
