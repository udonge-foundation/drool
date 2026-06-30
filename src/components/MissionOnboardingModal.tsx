import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import {
  MissionReadinessGateState,
  ReadinessLevel,
} from '@industry/common/agentReadiness/enums';
import {
  missionGateOffersFix,
  missionGateOffersReport,
} from '@industry/utils/agentReadiness';

import { COLORS } from '@/components/chat/themedColors';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';

import type { TFunction } from 'i18next';

/**
 * Localized readiness warning body for a non-Ok gate state. The shared
 * `getMissionReadinessWarning` helper is English-only, so the CLI maps each
 * state to an i18n key (with `{{level}}` interpolation for low score).
 */
function getLocalizedGateWarning(
  t: TFunction,
  gateState: MissionReadinessGateState,
  level?: ReadinessLevel
): string {
  switch (gateState) {
    case MissionReadinessGateState.LowScore:
      return t('common:missionOnboarding.gateWarningLowScore', {
        level: level ?? 0,
      });
    case MissionReadinessGateState.NoReport:
      return t('common:missionOnboarding.gateWarningNoReport');
    case MissionReadinessGateState.NoRemote:
      return t('common:missionOnboarding.gateWarningNoRemote');
    case MissionReadinessGateState.NoGit:
      return t('common:missionOnboarding.gateWarningNoGit');
    default:
      return '';
  }
}

interface MissionOnboardingModalProps {
  onContinue: () => void;
  onCancel: () => void;
  onRunReport?: () => void;
  onFixReport?: () => void;
  /** Whether to render the first-time onboarding content. */
  showOnboarding: boolean;
  /** The readiness gate outcome; `Ok` renders no warning. */
  gateState: MissionReadinessGateState;
  /** Agent readiness level (1-5), interpolated into the low-score warning. */
  level?: ReadinessLevel;
  width?: number;
}

export function MissionOnboardingModal({
  onContinue,
  onCancel,
  onRunReport,
  onFixReport,
  showOnboarding,
  gateState,
  level,
  width = 60,
}: MissionOnboardingModalProps) {
  const { t } = useTranslation();

  const showWarning = gateState !== MissionReadinessGateState.Ok;
  const offersReport =
    missionGateOffersReport(gateState) && Boolean(onRunReport);
  const offersFix = missionGateOffersFix(gateState) && Boolean(onFixReport);

  useKeypressHandler((input, key) => {
    if (key.return) {
      onContinue();
    } else if (key.escape) {
      onCancel();
    } else if (offersReport && input?.toLowerCase() === 'r') {
      onRunReport?.();
    } else if (offersFix && input?.toLowerCase() === 'f') {
      onFixReport?.();
    }
  });

  return (
    <Box flexDirection="column" width={width}>
      <Box
        borderStyle="round"
        borderColor={showWarning ? COLORS.warning : COLORS.agi}
        paddingX={2}
        paddingY={1}
        flexDirection="column"
      >
        {showOnboarding ? (
          <>
            <Text bold color={COLORS.agi}>
              {t('common:missionOnboarding.title')}
            </Text>

            <Box marginTop={1} flexDirection="column">
              <Text bold>{t('common:missionOnboarding.howItWorksTitle')}</Text>
              <Text> {t('common:missionOnboarding.howItWorks1')}</Text>
              <Text> {t('common:missionOnboarding.howItWorks2')}</Text>
              <Text> {t('common:missionOnboarding.howItWorks3')}</Text>
              <Text> {t('common:missionOnboarding.howItWorks4')}</Text>
            </Box>

            <Box marginTop={1} flexDirection="column">
              <Text bold>{t('common:missionOnboarding.keyConceptsTitle')}</Text>
              <Text> {t('common:missionOnboarding.keyConcept1')}</Text>
              <Text> {t('common:missionOnboarding.keyConcept2')}</Text>
              <Text> {t('common:missionOnboarding.keyConcept3')}</Text>
            </Box>

            <Box marginTop={1} flexDirection="column">
              <Text bold color={COLORS.warning}>
                {t('common:missionOnboarding.warningsTitle')}
              </Text>
              <Text color={COLORS.warning}>
                {' '}
                {t('common:missionOnboarding.warning1')}
              </Text>
              <Text color={COLORS.warning}>
                {' '}
                {t('common:missionOnboarding.warning2')}
              </Text>
              <Text color={COLORS.warning}>
                {' '}
                {t('common:missionOnboarding.warning3')}
              </Text>
            </Box>
          </>
        ) : null}

        {showWarning ? (
          <Box marginTop={showOnboarding ? 1 : 0} flexDirection="column">
            <Text bold color={COLORS.warning}>
              {t('common:missionOnboarding.gateTitle')}
            </Text>
            <Box marginTop={1}>
              <Text color={COLORS.warning}>
                {getLocalizedGateWarning(t, gateState, level)}
              </Text>
            </Box>
          </Box>
        ) : null}
      </Box>

      <Box marginTop={1} flexDirection="column" alignItems="center">
        <Text color={COLORS.primary}>
          {showWarning
            ? t('common:missionOnboarding.gateContinueHint')
            : t('common:missionOnboarding.continueHint')}
        </Text>
        {offersReport ? (
          <Text color={COLORS.primary}>
            {t('common:missionOnboarding.gateRunReportHint')}
          </Text>
        ) : null}
        {offersFix ? (
          <Text color={COLORS.primary}>
            {t('common:missionOnboarding.gateFixReportHint')}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
