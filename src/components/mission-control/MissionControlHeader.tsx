/**
 * Mission Control header component — single-line format
 *
 * Renders a single line:
 *   🔱 Mission Control  ~/path/to/project     Time Xh Ym · Industry Standard Credits X
 *
 * The header does NOT draw its own borders — the overlay handles the frame.
 * Accepts a `width` prop to compute padding between left and right content.
 */

import path from 'node:path';
import * as os from 'os';

import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { formatRateLimitUsagePercent } from '@industry/utils/billing';
import { formatMissionIndustryStandardCredits } from '@industry/utils/mission';

import { MC_COLORS } from '@/components/mission-control/constants';
import type { MissionControlHeaderProps } from '@/components/mission-control/types';
import { canViewTokenUsage } from '@/utils/tokenUsageVisibility';

/**
 * Shortens a path by replacing home directory with ~
 */
function shortenPath(pathStr: string): string {
  const homeDir = os.homedir();
  const normalizedHomeDir =
    homeDir.endsWith(path.sep) && homeDir !== path.sep
      ? homeDir.slice(0, -1)
      : homeDir;

  if (pathStr === normalizedHomeDir) {
    return '~';
  }

  if (pathStr.startsWith(`${normalizedHomeDir}${path.sep}`)) {
    return `~${pathStr.slice(normalizedHomeDir.length)}`;
  }

  return pathStr;
}

function truncatePathFromLeft(pathStr: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (pathStr.length <= maxLength) return pathStr;
  if (maxLength === 1) return '…';
  return `…${pathStr.slice(-(maxLength - 1))}`;
}

export function MissionControlHeader({
  workingDirectory,
  tokenUsage,
  rateLimitUsage,
  width,
  elapsedTime,
}: MissionControlHeaderProps) {
  const { t } = useTranslation('common');
  const shortPath = shortenPath(workingDirectory);

  const leftLabel = ` 🔱 ${t('common:missionControl.title')}`;
  const rawLeftPath = `  ${shortPath}`;

  const timeStr = elapsedTime ?? '-';
  const timeLabel = t('common:stats.time');
  const timeText = `${timeLabel} ${timeStr}`;
  const showTokenUsage = canViewTokenUsage();
  const industryCreditsLabel = t('common:missionControlHeader.industryCredits');
  const industryCreditsValue = formatMissionIndustryStandardCredits(tokenUsage);
  const rateLimitUsageLabel = t('common:missionControlHeader.rateLimitUsage');
  const rateLimitUsageValue = formatRateLimitUsagePercent(rateLimitUsage, '-');
  const rightParts = showTokenUsage
    ? [`${timeText} · ${industryCreditsLabel} ${industryCreditsValue}`, ` `]
    : [`${timeText} · ${rateLimitUsageLabel} ${rateLimitUsageValue}`, ` `];
  const rightLen = rightParts.join('').length;

  const contentWidth = width ?? 120;
  const maxLeftPathLen = Math.max(
    0,
    contentWidth - leftLabel.length - rightLen - 1
  );
  const leftPath = truncatePathFromLeft(rawLeftPath, maxLeftPathLen);
  const leftLen = leftLabel.length + leftPath.length;
  const padLen = Math.max(0, contentWidth - leftLen - rightLen);

  return (
    <Box width={contentWidth} height={1} overflow="hidden">
      <Text color={MC_COLORS.active}>{leftLabel}</Text>
      <Text color={MC_COLORS.tertiary}>{leftPath}</Text>
      <Text>{' '.repeat(padLen)}</Text>
      <Text color={MC_COLORS.tertiary}>{timeLabel} </Text>
      <Text color={MC_COLORS.dataValue}>{timeStr}</Text>
      {showTokenUsage ? (
        <>
          <Text color={MC_COLORS.ghost}> · </Text>
          <Text color={MC_COLORS.tertiary}>{industryCreditsLabel} </Text>
          <Text color={MC_COLORS.dataValue}>{industryCreditsValue}</Text>
        </>
      ) : (
        <>
          <Text color={MC_COLORS.ghost}> · </Text>
          <Text color={MC_COLORS.tertiary}>{rateLimitUsageLabel} </Text>
          <Text color={MC_COLORS.dataValue}>{rateLimitUsageValue}</Text>
        </>
      )}
      <Text> </Text>
    </Box>
  );
}
