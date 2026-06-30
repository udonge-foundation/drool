import { Box, Text } from 'ink';
import { Fragment, useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { UsageMode } from '@industry/common/billing';
import { getUsageStatus, getUsageStatusText } from '@industry/utils/billing';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import type {
  UsageLimitsPanelProps,
  LimitsBucketData,
} from '@/components/types';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';

type LimitsTab = 'standard' | 'core' | 'extra';
type PreferenceOption = 'droolCore' | 'openBilling';
// 3 buckets × (label+bar=2) + 2 spacers = 8
const TAB_CONTENT_HEIGHT = 8;
const PROGRESS_BAR_COLOR = COLORS.warning;

function formatTimeRemaining(windowEnd: string | null): string | null {
  if (!windowEnd) return null;
  const now = Date.now();
  const end = new Date(windowEnd).getTime();
  const diffMs = end - now;
  if (diffMs <= 0) return null;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days} day${days !== 1 ? 's' : ''}`;
  }
  if (hours > 0) return `${hours}h ${minutes}min`;
  return `${minutes}min`;
}

function isBucketExpired(bucket: LimitsBucketData): boolean {
  if (!bucket.windowEnd) return true;
  return new Date(bucket.windowEnd).getTime() <= Date.now();
}

function ProgressBar({
  percent,
  width,
  dimmed,
}: {
  percent: number;
  width: number;
  dimmed?: boolean;
}) {
  const clampedPct = Math.max(0, Math.min(100, percent));
  const barWidth = Math.max(10, width);
  const filledCount = Math.round((clampedPct / 100) * barWidth);
  const emptyCount = barWidth - filledCount;
  const filledColor = dimmed ? COLORS.text.muted : PROGRESS_BAR_COLOR;
  return (
    <Text>
      <Text color={filledColor}>{'█'.repeat(filledCount)}</Text>
      <Text color={COLORS.text.muted}>{'░'.repeat(emptyCount)}</Text>
    </Text>
  );
}

function BucketRow({
  label,
  bucket,
  barWidth,
  useDroolToStartText,
  dimmed,
}: {
  label: string;
  bucket: LimitsBucketData;
  barWidth: number;
  useDroolToStartText: string;
  dimmed?: boolean;
}) {
  const expired = isBucketExpired(bucket);
  const pct = expired ? 0 : bucket.usedPercent;
  const timeRemaining = formatTimeRemaining(bucket.windowEnd);
  const timeStr =
    expired || !timeRemaining ? useDroolToStartText : `↻ ${timeRemaining}`;
  const pctStr = `${pct}%`;
  const pctColor = expired || dimmed ? COLORS.text.muted : PROGRESS_BAR_COLOR;

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text>
          <Text color={dimmed ? COLORS.text.muted : COLORS.text.secondary}>
            {label.padEnd(9)}
          </Text>
          <Text color={pctColor}>{pctStr.padEnd(5)}</Text>
        </Text>
        <Text
          color={expired || dimmed ? COLORS.text.muted : COLORS.text.secondary}
        >
          {timeStr}
        </Text>
      </Box>
      <Box>
        <ProgressBar percent={pct} width={barWidth} dimmed={dimmed} />
      </Box>
    </Box>
  );
}

export function UsageLimitsPanel({
  limitsData,
  extraUsageBalanceCents,
  currentPreference,
  extraUsageAllowed = false,
  isCurrentModelCore,
  onSelect,
  onCancel,
}: UsageLimitsPanelProps) {
  const { t } = useTranslation('common');
  const { width: terminalWidth } = useTerminalDimensions();
  const [selectedTab, setSelectedTab] = useState<LimitsTab>('standard');
  const [selectedPrefIndex, setSelectedPrefIndex] = useState(0);
  const [arrowFrame, setArrowFrame] = useState(0);
  const arrowTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const preferenceOptions: {
    key: PreferenceOption;
    label: string;
    desc: string;
    disabled?: boolean;
  }[] = [
    {
      key: 'droolCore',
      label: t('usageLimits.preferences.switchToDroolCore'),
      desc: t('usageLimits.preferences.switchToDroolCoreDesc'),
    },
    {
      key: 'openBilling',
      label: t('usageLimits.preferences.enableExtraUsage'),
      desc: extraUsageAllowed
        ? t('usageLimits.preferences.enableExtraUsageDesc')
        : t('usageLimits.preferences.extraUsageDisabledTrial'),
      disabled: !extraUsageAllowed,
    },
  ];

  const getNextEnabledPreferenceIndex = (
    currentIndex: number,
    direction: 1 | -1
  ) => {
    for (let offset = 1; offset <= preferenceOptions.length; offset++) {
      const nextIndex =
        (currentIndex + direction * offset + preferenceOptions.length) %
        preferenceOptions.length;
      if (!preferenceOptions[nextIndex]?.disabled) return nextIndex;
    }
    return currentIndex;
  };

  useEffect(() => {
    arrowTimerRef.current = setInterval(() => {
      setArrowFrame((f) => (f === 0 ? 1 : 0));
    }, 600);
    return () => {
      if (arrowTimerRef.current) {
        clearInterval(arrowTimerRef.current);
        arrowTimerRef.current = null;
      }
    };
  }, []);

  const extraBalanceDollars = ((extraUsageBalanceCents ?? 0) / 100).toFixed(2);

  const getNextTab = (current: LimitsTab): LimitsTab => {
    switch (current) {
      case 'standard':
        return 'core';
      case 'core':
        return 'extra';
      case 'extra':
        return 'standard';
      default:
        return 'standard';
    }
  };

  useKeypressHandler((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.tab) {
      setSelectedTab((prev) => getNextTab(prev));
      return;
    }
    if (key.upArrow) {
      setSelectedPrefIndex((prev) => getNextEnabledPreferenceIndex(prev, -1));
      return;
    }
    if (key.downArrow) {
      setSelectedPrefIndex((prev) => getNextEnabledPreferenceIndex(prev, 1));
      return;
    }
    if (key.return) {
      const option = preferenceOptions[selectedPrefIndex];
      if (option && !option.disabled) {
        onSelect(option.key);
      }
    }
  });

  const standardPool = limitsData?.standard;
  const corePool = limitsData?.core;
  const barWidth = terminalWidth - 4;

  const extraUsageBalanceDollars = (extraUsageBalanceCents ?? 0) / 100;
  const { usageMode, highestUsageLimit, standardResetDate, extraUsageBalance } =
    getUsageStatus({
      tokenLimits: limitsData ? { limits: limitsData } : null,
      limitPreference: currentPreference ?? null,
      extraUsageBalanceDollars,
    });

  const usageStatusLine = {
    color:
      usageMode === UsageMode.Blocked
        ? COLORS.error
        : usageMode === UsageMode.Standard &&
            highestUsageLimit &&
            highestUsageLimit.percentage >= 70
          ? COLORS.warning
          : COLORS.success,
    text: getUsageStatusText({
      mode: usageMode,
      highestUsageLimit,
      standardResetDate,
      extraUsageBalance,
    }),
  };

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        marginTop={1}
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={1}
        width={terminalWidth}
      >
        <Box marginBottom={1}>
          <Text color={COLORS.text.secondary} bold>
            {`ⓘ  ${t('usageLimits.howItWorks')}`}
          </Text>
        </Box>
        <Text color={COLORS.text.muted} wrap="wrap">
          {t('usageLimits.howItWorksDescription')}
        </Text>
        <Box marginTop={1}>
          <Text color={usageStatusLine.color}>{'● '}</Text>
          <Text color={COLORS.text.secondary}>{usageStatusLine.text}</Text>
        </Box>
      </Box>
      <MenuContainer
        title={t('usageLimits.title')}
        titleBold={false}
        width={terminalWidth}
        marginTop={0}
        headerRight={
          <Box>
            <Text
              color={
                selectedTab === 'standard' ? COLORS.primary : COLORS.text.muted
              }
            >
              {selectedTab === 'standard' ? '◉' : '○'}{' '}
              {t('usageLimits.tabs.standard')}
            </Text>
            <Text color={COLORS.text.muted}> | </Text>
            <Text
              color={
                selectedTab === 'core' ? COLORS.primary : COLORS.text.muted
              }
            >
              {selectedTab === 'core' ? '◉' : '○'}{' '}
              {t('usageLimits.tabs.droolCore')}
            </Text>
            <Text color={COLORS.text.muted}> | </Text>
            <Text
              color={
                selectedTab === 'extra' ? COLORS.primary : COLORS.text.muted
              }
            >
              {selectedTab === 'extra' ? '◉' : '○'}{' '}
              {t('usageLimits.tabs.extraUsage')}
            </Text>
          </Box>
        }
        helpText={t('usageLimits.helpText')}
        showDefaultHelp={false}
      >
        <Box flexDirection="column" height={TAB_CONTENT_HEIGHT}>
          {(selectedTab === 'standard' || selectedTab === 'core') && (
            <Box flexDirection="column">
              {(() => {
                const pool =
                  selectedTab === 'standard' ? standardPool : corePool;
                const isDimmed =
                  selectedTab === 'core' && usageMode === UsageMode.Standard;
                if (!pool) {
                  return (
                    <Text color={COLORS.text.muted}>
                      {t('usageLimits.noUsageData')}
                    </Text>
                  );
                }
                const buckets: { labelKey: string; data: LimitsBucketData }[] =
                  [
                    {
                      labelKey: 'usageLimits.buckets.fiveHour',
                      data: pool.fiveHour,
                    },
                    {
                      labelKey: 'usageLimits.buckets.weekly',
                      data: pool.weekly,
                    },
                    {
                      labelKey: 'usageLimits.buckets.monthly',
                      data: pool.monthly,
                    },
                  ];
                return (
                  <>
                    {buckets.map((b, idx) => (
                      <Fragment key={b.labelKey}>
                        {idx > 0 && <Box height={1} />}
                        <BucketRow
                          label={t(b.labelKey)}
                          bucket={b.data}
                          barWidth={barWidth}
                          useDroolToStartText={t('usageLimits.useDroolToStart')}
                          dimmed={isDimmed}
                        />
                      </Fragment>
                    ))}
                  </>
                );
              })()}
            </Box>
          )}

          {selectedTab === 'extra' && (
            <Box flexDirection="column">
              <Text color={COLORS.text.secondary}>
                {t('usageLimits.balance')}
              </Text>
              <Box height={1} />
              <Text>
                <Text
                  color={
                    (extraUsageBalanceCents ?? 0) === 0
                      ? COLORS.text.muted
                      : (extraUsageBalanceCents ?? 0) < 1000
                        ? COLORS.warning
                        : COLORS.text.primary
                  }
                >
                  ${extraBalanceDollars}
                </Text>
                <Text color={COLORS.text.muted}>
                  {' '}
                  {t('usageLimits.remaining')}
                </Text>
              </Text>
            </Box>
          )}
        </Box>

        <Box marginTop={1} marginBottom={1}>
          <Text color={COLORS.text.muted}>{'─'.repeat(barWidth)}</Text>
        </Box>
        <Text color={COLORS.text.secondary}>
          {t('usageLimits.whenLimitReached')}
        </Text>
        <Box height={1} />
        <Box flexDirection="column">
          {preferenceOptions.map((option, index) => {
            const isCursor = index === selectedPrefIndex;
            const isDisabled = !!option.disabled;
            const isCurrent = currentPreference
              ? option.key === currentPreference ||
                (option.key === 'openBilling' &&
                  currentPreference === 'extraUsage')
              : option.key === 'droolCore' && !!isCurrentModelCore;
            const textColor = isDisabled
              ? COLORS.text.muted
              : isCursor
                ? COLORS.text.primary
                : COLORS.text.muted;
            return (
              <Box key={option.key} flexDirection="column">
                {index > 0 && <Box height={1} />}
                <Box>
                  <Box width={2}>
                    <Text
                      color={
                        isDisabled
                          ? COLORS.text.muted
                          : isCursor
                            ? COLORS.success
                            : isCurrent
                              ? COLORS.primary
                              : undefined
                      }
                    >
                      {isCursor
                        ? arrowFrame === 0
                          ? '> '
                          : ' >'
                        : isCurrent
                          ? '●'
                          : ' '}
                    </Text>
                  </Box>
                  <Text bold={isCursor && !isDisabled} color={textColor}>
                    {option.label}
                  </Text>
                </Box>
                <Box>
                  <Box width={4}>
                    <Text> </Text>
                  </Box>
                  <Text color={COLORS.text.muted}>
                    {option.key === 'openBilling'
                      ? `${option.desc} ($${extraBalanceDollars} ${t('usageLimits.remaining')})`
                      : option.desc}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      </MenuContainer>
    </Box>
  );
}
