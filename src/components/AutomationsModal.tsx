import { Box, Text } from 'ink';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { buildAutomationSlug } from '@industry/utils/automations';

import { COLORS } from '@/components/chat/themedColors';
import { CadenceChips } from '@/components/common/CadenceChips';
import { MenuContainer } from '@/components/common/MenuContainer';
import { TextInput } from '@/components/common/TextInput';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import {
  createLocalAutomation,
  getLocalAutomationHistory,
  pauseLocalAutomation,
  resumeLocalAutomation,
} from '@/services/automations/automationActions';
import { AUTOMATION_SCHEDULE_CHIPS } from '@/services/automations/constants';
import type { LocalAutomationRunRecord } from '@/services/automations/types';
import { formatCronTime } from '@/services/crons/format';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';

import type { AutomationEntry } from '@industry/common/daemon';

type Focus =
  | 'name'
  | 'schedule'
  | 'scheduleCustom'
  | 'instructions'
  | 'visual'
  | 'memory'
  | 'submit';

type Screen = 'browse' | 'paused' | 'details' | 'create';
type DetailsParent = 'browse' | 'paused';

type BrowseItem =
  | { kind: 'automation'; automation: AutomationEntry }
  | { kind: 'create' }
  | { kind: 'paused' };

interface AutomationsModalProps {
  automations: AutomationEntry[];
  isLoading: boolean;
  onCancel: () => void;
  onChanged: () => void;
  onOpenSession: (sessionId: string) => Promise<boolean>;
}

const DEFAULT_CHIP_INDEX = 0;
const CUSTOM_CHIP_INDEX = AUTOMATION_SCHEDULE_CHIPS.findIndex(
  (chip) => chip.value === null
);

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayValue(value: string): string {
  return sanitizeTerminalDisplayText(value, { stripSgr: true });
}

function formatRunDuration(durationMs: number | undefined): string | null {
  if (durationMs === undefined) {
    return null;
  }
  return `${Math.max(1, Math.round(durationMs / 1000))}s`;
}

interface DetailLine {
  readonly label: string;
  readonly value: string;
}

function buildAutomationDetailLines(
  automation: AutomationEntry,
  t: (key: string) => string
): DetailLine[] {
  const lines: DetailLine[] = [];
  if (automation.description) {
    lines.push({
      label: t('automations.modal.detail.description'),
      value: displayValue(automation.description),
    });
  }
  if (automation.schedule) {
    lines.push({
      label: t('automations.modal.detail.schedule'),
      value: displayValue(automation.schedule),
    });
  }
  lines.push({
    label: t('automations.modal.detail.status'),
    value: automation.status,
  });
  const nextRun = formatCronTime(automation.nextRunAt);
  if (nextRun) {
    lines.push({
      label: t('automations.modal.detail.nextRun'),
      value: nextRun,
    });
  }
  const lastRun = formatCronTime(automation.lastRunAt);
  if (lastRun) {
    lines.push({
      label: t('automations.modal.detail.lastRun'),
      value: lastRun,
    });
  }
  return lines;
}

interface AutomationRowProps {
  automation: AutomationEntry;
  isSelected: boolean;
}

function AutomationRow({ automation, isSelected }: AutomationRowProps) {
  const accent = isSelected ? COLORS.primary : COLORS.text.secondary;
  return (
    <Text color={accent}>
      {`${isSelected ? '\u25b8' : ' '} ${displayValue(automation.name)} [${
        automation.status
      }] ${automation.schedule ? `\u00b7 ${displayValue(automation.schedule)}` : ''}`}
    </Text>
  );
}

interface FormTextFieldProps {
  label: string;
  value: string;
  placeholder: string;
  isFocused: boolean;
  onChange: (value: string) => void;
  onSubmit?: () => void;
}

function FormTextField({
  label,
  value,
  placeholder,
  isFocused,
  onChange,
  onSubmit,
}: FormTextFieldProps) {
  return (
    <Box flexDirection="column">
      <Text color={COLORS.text.muted}>{label}</Text>
      <TextInput
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        focus={isFocused}
        {...(onSubmit ? { onSubmit } : {})}
      />
    </Box>
  );
}

export function AutomationsModal({
  automations,
  isLoading,
  onCancel,
  onChanged,
  onOpenSession,
}: AutomationsModalProps) {
  const { t } = useTranslation('commands');
  const sortedAutomations = useMemo(
    () =>
      automations.toSorted((left, right) =>
        left.name.localeCompare(right.name)
      ),
    [automations]
  );
  const activeAutomations = useMemo(
    () =>
      sortedAutomations.filter((automation) => automation.status !== 'paused'),
    [sortedAutomations]
  );
  const pausedAutomations = useMemo(
    () =>
      sortedAutomations.filter((automation) => automation.status === 'paused'),
    [sortedAutomations]
  );
  const browseItems = useMemo<BrowseItem[]>(
    () => [
      ...activeAutomations.map((automation) => ({
        kind: 'automation' as const,
        automation,
      })),
      { kind: 'create' as const },
      ...(pausedAutomations.length > 0 ? [{ kind: 'paused' as const }] : []),
    ],
    [activeAutomations, pausedAutomations.length]
  );
  const [screen, setScreen] = useState<Screen>('browse');
  const [focus, setFocus] = useState<Focus>('name');
  const [browseSelectedIndex, setBrowseSelectedIndex] = useState(0);
  const [pausedSelectedIndex, setPausedSelectedIndex] = useState(0);
  const [detailAutomationId, setDetailAutomationId] = useState<string | null>(
    null
  );
  const [detailsParent, setDetailsParent] = useState<DetailsParent>('browse');
  const [selectedRunIndex, setSelectedRunIndex] = useState(0);
  const [runHistory, setRunHistory] = useState<
    Record<string, LocalAutomationRunRecord[]>
  >({});
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [chipIndex, setChipIndex] = useState(DEFAULT_CHIP_INDEX);
  const [customSchedule, setCustomSchedule] = useState('');
  const [instructions, setInstructions] = useState('');
  const [visualDescription, setVisualDescription] = useState('');
  const [memoryStrategy, setMemoryStrategy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectedChip = AUTOMATION_SCHEDULE_CHIPS[chipIndex];
  const isCustomChip = chipIndex === CUSTOM_CHIP_INDEX;
  const effectiveBrowseIndex = Math.min(
    browseSelectedIndex,
    Math.max(0, browseItems.length - 1)
  );
  const effectivePausedIndex = Math.min(
    pausedSelectedIndex,
    Math.max(0, pausedAutomations.length - 1)
  );
  const selectedBrowseItem = browseItems[effectiveBrowseIndex];
  const detailAutomation = sortedAutomations.find(
    (automation) => automation.id === detailAutomationId
  );
  const selectedAutomation =
    screen === 'details'
      ? detailAutomation
      : screen === 'paused'
        ? pausedAutomations[effectivePausedIndex]
        : selectedBrowseItem?.kind === 'automation'
          ? selectedBrowseItem.automation
          : undefined;
  const detailRuns = detailAutomationId
    ? (runHistory[detailAutomationId] ?? [])
    : [];
  const effectiveRunIndex = Math.max(
    0,
    Math.min(selectedRunIndex, Math.max(0, detailRuns.length - 1))
  );

  const formFields = useMemo<Focus[]>(
    () => [
      'name',
      'schedule',
      ...(isCustomChip ? (['scheduleCustom'] as const) : []),
      'instructions',
      'visual',
      'memory',
      'submit',
    ],
    [isCustomChip]
  );

  const handleFieldChange =
    (setter: (value: string) => void) => (value: string) => {
      setter(value);
      setError(null);
      setNotice(null);
    };

  const cycleFormFocus = useCallback(
    (direction: 1 | -1) => {
      const currentIndex = formFields.indexOf(focus);
      const nextIndex =
        (Math.max(0, currentIndex) + direction + formFields.length) %
        formFields.length;
      setFocus(formFields[nextIndex]);
    },
    [focus, formFields]
  );

  const cycleChip = useCallback((direction: 1 | -1) => {
    setError(null);
    setNotice(null);
    setChipIndex((previous) => {
      const length = AUTOMATION_SCHEDULE_CHIPS.length;
      return (previous + direction + length) % length;
    });
  }, []);

  const openDetails = useCallback(
    async (automation: AutomationEntry, parent: DetailsParent) => {
      setDetailAutomationId(automation.id);
      setDetailsParent(parent);
      setSelectedRunIndex(0);
      setScreen('details');
      setError(null);
      setNotice(null);
      if (
        !automation.isValid ||
        runHistory[automation.id] !== undefined ||
        historyLoadingId === automation.id
      ) {
        return;
      }
      setHistoryLoadingId(automation.id);
      try {
        const runs = await getLocalAutomationHistory(automation.id);
        setRunHistory((previous) => ({ ...previous, [automation.id]: runs }));
      } catch (caughtError) {
        setError(formatError(caughtError));
      } finally {
        setHistoryLoadingId((current) =>
          current === automation.id ? null : current
        );
      }
    },
    [historyLoadingId, runHistory]
  );

  const handleCreate = useCallback(async () => {
    const trimmedName = name.trim();
    const trimmedSchedule = isCustomChip
      ? customSchedule.trim()
      : (selectedChip?.value ?? '');
    if (!trimmedName) {
      setError(t('automations.modal.emptyName'));
      return;
    }
    if (!trimmedSchedule) {
      setError(t('automations.modal.emptySchedule'));
      return;
    }
    setError(null);
    setNotice(null);
    setIsSubmitting(true);
    try {
      await createLocalAutomation({
        id: buildAutomationSlug(trimmedName),
        name: trimmedName,
        schedule: trimmedSchedule,
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        ...(visualDescription.trim()
          ? { visualDescription: visualDescription.trim() }
          : {}),
        ...(memoryStrategy.trim()
          ? { memoryStrategy: memoryStrategy.trim() }
          : {}),
      });
      setName('');
      setInstructions('');
      setVisualDescription('');
      setMemoryStrategy('');
      setCustomSchedule('');
      setChipIndex(DEFAULT_CHIP_INDEX);
      setFocus('name');
      setBrowseSelectedIndex(0);
      setScreen('browse');
      setNotice(t('automations.modal.created'));
      onChanged();
    } catch (caughtError) {
      setError(formatError(caughtError));
    } finally {
      setIsSubmitting(false);
    }
  }, [
    customSchedule,
    instructions,
    isCustomChip,
    memoryStrategy,
    name,
    onChanged,
    selectedChip,
    t,
    visualDescription,
  ]);

  const handleTogglePaused = useCallback(async () => {
    if (!selectedAutomation?.isValid) return;
    setError(null);
    setNotice(null);
    setIsSubmitting(true);
    try {
      if (selectedAutomation.status === 'paused') {
        await resumeLocalAutomation(selectedAutomation.id);
        setDetailsParent('browse');
        setNotice(t('automations.modal.resumed'));
      } else {
        await pauseLocalAutomation(selectedAutomation.id);
        setDetailsParent('paused');
        setNotice(t('automations.modal.paused'));
      }
      onChanged();
    } catch (caughtError) {
      setError(formatError(caughtError));
    } finally {
      setIsSubmitting(false);
    }
  }, [onChanged, selectedAutomation, t]);

  const handleOpenRun = useCallback(async () => {
    const run = detailRuns[effectiveRunIndex];
    if (!run) return;
    if (!run.sessionId) {
      setNotice(t('automations.modal.detail.noSession'));
      return;
    }
    setError(null);
    setNotice(t('automations.modal.detail.openingSession'));
    setIsSubmitting(true);
    try {
      const opened = await onOpenSession(run.sessionId);
      if (!opened) {
        setNotice(null);
        setError(t('automations.modal.detail.sessionUnavailable'));
      }
    } catch (caughtError) {
      setNotice(null);
      setError(formatError(caughtError));
    } finally {
      setIsSubmitting(false);
    }
  }, [detailRuns, effectiveRunIndex, onOpenSession, t]);

  useKeypressHandler(
    (input, key) => {
      if (key.escape) {
        if (screen === 'browse') {
          onCancel();
        } else if (screen === 'details') {
          setScreen(detailsParent);
          setError(null);
          setNotice(null);
        } else {
          setScreen('browse');
          setError(null);
          setNotice(null);
        }
        return;
      }
      if (isSubmitting) return;

      if (screen === 'browse') {
        if (key.upArrow) {
          setBrowseSelectedIndex((previous) => Math.max(0, previous - 1));
          return;
        }
        if (key.downArrow) {
          setBrowseSelectedIndex((previous) =>
            Math.min(browseItems.length - 1, previous + 1)
          );
          return;
        }
        if (key.return) {
          if (selectedBrowseItem?.kind === 'automation') {
            void openDetails(selectedBrowseItem.automation, 'browse');
          } else if (selectedBrowseItem?.kind === 'create') {
            setScreen('create');
            setFocus('name');
            setError(null);
            setNotice(null);
          } else if (selectedBrowseItem?.kind === 'paused') {
            setScreen('paused');
            setPausedSelectedIndex(0);
            setError(null);
            setNotice(null);
          }
        }
        return;
      }

      if (screen === 'paused') {
        if (key.upArrow) {
          setPausedSelectedIndex((previous) => Math.max(0, previous - 1));
          return;
        }
        if (key.downArrow) {
          setPausedSelectedIndex((previous) =>
            Math.min(pausedAutomations.length - 1, previous + 1)
          );
          return;
        }
        if (key.return && selectedAutomation) {
          void openDetails(selectedAutomation, 'paused');
        }
        return;
      }

      if (screen === 'details') {
        if (input === 'p' || input === 'P') {
          void handleTogglePaused();
          return;
        }
        if (key.upArrow) {
          setSelectedRunIndex((previous) => Math.max(0, previous - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedRunIndex((previous) =>
            Math.min(Math.max(0, detailRuns.length - 1), previous + 1)
          );
          return;
        }
        if (key.return) {
          void handleOpenRun();
        }
        return;
      }

      if (focus === 'schedule') {
        if (key.leftArrow) {
          cycleChip(-1);
          return;
        }
        if (key.rightArrow) {
          cycleChip(1);
          return;
        }
        if (key.return) {
          cycleFormFocus(1);
          return;
        }
      }
      if (focus === 'submit' && key.return) {
        void handleCreate();
        return;
      }
      if (key.upArrow) {
        cycleFormFocus(-1);
        return;
      }
      if (key.downArrow || key.tab) {
        cycleFormFocus(1);
      }
    },
    { isActive: true }
  );

  const title =
    screen === 'details' && detailAutomation
      ? t('automations.modal.detail.title', {
          name: displayValue(detailAutomation.name),
        })
      : screen === 'paused'
        ? t('automations.modal.pausedTitle')
        : screen === 'create'
          ? t('automations.modal.createTitle')
          : t('automations.modal.title');
  const helpText =
    screen === 'browse'
      ? t('automations.modal.helpBrowse')
      : screen === 'paused'
        ? t('automations.modal.helpPaused')
        : screen === 'details'
          ? t('automations.modal.helpDetail')
          : focus === 'schedule'
            ? t('automations.modal.helpSchedule')
            : t('automations.modal.helpCreate');

  return (
    <MenuContainer title={title} helpText={helpText}>
      <Box flexDirection="column">
        {screen === 'browse' && (
          <Box flexDirection="column">
            {isLoading ? (
              <Text color={COLORS.text.muted}>
                {t('automations.modal.loading')}
              </Text>
            ) : (
              <>
                <Text color={COLORS.text.secondary}>
                  {t('automations.modal.activeHeader')}
                </Text>
                {activeAutomations.length > 0 ? (
                  activeAutomations.map((automation, index) => (
                    <AutomationRow
                      key={automation.id}
                      automation={automation}
                      isSelected={index === effectiveBrowseIndex}
                    />
                  ))
                ) : (
                  <Text color={COLORS.text.muted}>
                    {t('automations.modal.noActive')}
                  </Text>
                )}
                <Box marginTop={1} flexDirection="column">
                  <Text
                    color={
                      effectiveBrowseIndex === activeAutomations.length
                        ? COLORS.primary
                        : COLORS.text.secondary
                    }
                  >
                    {`${effectiveBrowseIndex === activeAutomations.length ? '\u25b8' : ' '} ${t('automations.modal.createAction')}`}
                  </Text>
                  {pausedAutomations.length > 0 && (
                    <Text
                      color={
                        effectiveBrowseIndex === activeAutomations.length + 1
                          ? COLORS.primary
                          : COLORS.text.secondary
                      }
                    >
                      {`${effectiveBrowseIndex === activeAutomations.length + 1 ? '\u25b8' : ' '} ${t('automations.modal.pausedAction', { count: pausedAutomations.length })}`}
                    </Text>
                  )}
                </Box>
              </>
            )}
          </Box>
        )}

        {screen === 'paused' && (
          <Box flexDirection="column">
            {pausedAutomations.map((automation, index) => (
              <AutomationRow
                key={automation.id}
                automation={automation}
                isSelected={index === effectivePausedIndex}
              />
            ))}
          </Box>
        )}

        {screen === 'details' && detailAutomation && (
          <Box flexDirection="column">
            {buildAutomationDetailLines(detailAutomation, t).map((line) => (
              <Box key={`${detailAutomation.id}-detail-${line.label}`}>
                <Text color={COLORS.text.muted}>{line.label}: </Text>
                <Text color={COLORS.text.secondary}>{line.value}</Text>
              </Box>
            ))}
            <Box marginTop={1} flexDirection="column">
              <Text color={COLORS.text.secondary}>
                {t('automations.modal.detail.recentRuns')}
              </Text>
              {historyLoadingId === detailAutomation.id ? (
                <Text color={COLORS.text.muted}>
                  {t('automations.modal.detail.loadingRuns')}
                </Text>
              ) : detailRuns.length > 0 ? (
                detailRuns.map((run, index) => {
                  const startedAt =
                    formatCronTime(run.startedAt) ?? run.startedAt;
                  const duration = formatRunDuration(run.durationMs);
                  const runText = duration
                    ? t('automations.modal.detail.runLineWithDuration', {
                        status: run.status,
                        startedAt,
                        duration,
                      })
                    : t('automations.modal.detail.runLine', {
                        status: run.status,
                        startedAt,
                      });
                  return (
                    <Text
                      key={run.runId}
                      color={
                        index === effectiveRunIndex
                          ? COLORS.primary
                          : COLORS.text.secondary
                      }
                    >
                      {`${index === effectiveRunIndex ? '\u25b8' : ' '} ${runText}${
                        run.sessionId
                          ? t('automations.modal.detail.openSessionSuffix')
                          : ''
                      }`}
                    </Text>
                  );
                })
              ) : (
                <Text color={COLORS.text.muted}>
                  {t('automations.modal.detail.noRuns')}
                </Text>
              )}
            </Box>
          </Box>
        )}

        {screen === 'create' && (
          <Box flexDirection="column">
            <Text color={COLORS.text.secondary}>
              {t('automations.modal.createIntro')}
            </Text>
            <Box marginTop={1} flexDirection="column">
              <FormTextField
                label={t('automations.modal.nameLabel')}
                value={name}
                onChange={handleFieldChange(setName)}
                placeholder={t('automations.modal.namePlaceholder')}
                isFocused={focus === 'name'}
                onSubmit={() => setFocus('schedule')}
              />
              <Text color={COLORS.text.muted}>
                {t('automations.modal.scheduleLabel')}
              </Text>
              <CadenceChips
                chips={AUTOMATION_SCHEDULE_CHIPS}
                selectedIndex={chipIndex}
                isFocused={focus === 'schedule'}
              />
              {isCustomChip && (
                <FormTextField
                  label={t('automations.modal.scheduleCustomLabel')}
                  value={customSchedule}
                  onChange={handleFieldChange(setCustomSchedule)}
                  placeholder={t('automations.modal.scheduleCustomPlaceholder')}
                  isFocused={focus === 'scheduleCustom'}
                  onSubmit={() => setFocus('instructions')}
                />
              )}
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text color={COLORS.text.secondary}>
                {t('automations.modal.guidanceHeader')}
              </Text>
              <FormTextField
                label={t('automations.modal.instructionsLabel')}
                value={instructions}
                onChange={handleFieldChange(setInstructions)}
                placeholder={t('automations.modal.instructionsPlaceholder')}
                isFocused={focus === 'instructions'}
                onSubmit={() => setFocus('visual')}
              />
              <FormTextField
                label={t('automations.modal.visualLabel')}
                value={visualDescription}
                onChange={handleFieldChange(setVisualDescription)}
                placeholder={t('automations.modal.visualPlaceholder')}
                isFocused={focus === 'visual'}
                onSubmit={() => setFocus('memory')}
              />
              <FormTextField
                label={t('automations.modal.memoryLabel')}
                value={memoryStrategy}
                onChange={handleFieldChange(setMemoryStrategy)}
                placeholder={t('automations.modal.memoryPlaceholder')}
                isFocused={focus === 'memory'}
                onSubmit={() => setFocus('submit')}
              />
            </Box>
            <Box marginTop={1}>
              <Text
                bold={focus === 'submit'}
                color={
                  focus === 'submit' ? COLORS.primary : COLORS.text.secondary
                }
              >
                {`${focus === 'submit' ? '\u25b8' : ' '} ${t('automations.modal.createSubmit')}`}
              </Text>
            </Box>
          </Box>
        )}

        {isSubmitting && (
          <Text color={COLORS.primary}>{t('automations.modal.saving')}</Text>
        )}
        {notice && <Text color={COLORS.success}>{notice}</Text>}
        {error && <Text color={COLORS.error}>{error}</Text>}
      </Box>
    </MenuContainer>
  );
}
