import { Box, Text } from 'ink';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type CronRecord } from '@industry/common/daemon';

import {
  formatLoopInterval,
  getLoopIntervalParseErrorMessage,
  parseLoopInterval,
} from '@/commands/loop';
import { COLORS } from '@/components/chat/themedColors';
import { CadenceChips } from '@/components/common/CadenceChips';
import { MenuContainer } from '@/components/common/MenuContainer';
import { TextInput } from '@/components/common/TextInput';
import { useCountdownTick } from '@/hooks/useCountdownTick';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import {
  DEFAULT_CADENCE_CHIPS,
  SESSION_LOOP_RECIPES,
} from '@/services/crons/constants';
import {
  createSessionCron,
  deleteCronAction,
  editCron,
  pauseCron,
  resumeCron,
} from '@/services/crons/cronActions';
import {
  compareCronRecords,
  formatCronCadence,
  formatCronCountdown,
  formatCronStatusBadge,
  formatCronTime,
  formatHoldReason,
  formatPromptExcerpt,
  isUserVisibleCron,
} from '@/services/crons/format';
import { cronExpressionToIntervalMs } from '@/services/crons/loopSchedule';
import type { CronRecipe } from '@/services/crons/types';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';

type Focus = 'list' | 'chips' | 'custom' | 'prompt';
type FormMode = { kind: 'create' } | { kind: 'edit'; cronId: string };
type Confirm = null | { kind: 'one'; id: string } | { kind: 'all' };

interface LoopModalProps {
  scheduledTasks: CronRecord[];
  cronHistory?: CronRecord[];
  currentSessionId: string | null;
  currentSessionCwd: string;
  onCancel: () => void;
  onChanged?: () => void;
  onCreated?: (cron: CronRecord) => void;
}

const ID_DISPLAY_LENGTH = 8;
const PROMPT_PREVIEW_LENGTH = 40;
const MAX_RECENT_TEMPLATES = 3;
const DEFAULT_CHIP_INDEX = 0;
const CUSTOM_CHIP_INDEX = DEFAULT_CADENCE_CHIPS.findIndex(
  (chip) => chip.intervalMs === null
);

function formatLoopActionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortId(id: string): string {
  return id.slice(0, ID_DISPLAY_LENGTH);
}

function previewPrompt(cron: CronRecord): string {
  return formatPromptExcerpt(cron.payload.prompt, PROMPT_PREVIEW_LENGTH);
}

function sanitizeDetailValue(value: string): string {
  return sanitizeTerminalDisplayText(value, { stripSgr: true });
}

function parseCustomCadence(raw: string): {
  intervalMs: number | null;
  error: string | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { intervalMs: null, error: null };
  const parsed = parseLoopInterval(trimmed);
  if (!parsed.ok) {
    return {
      intervalMs: null,
      error: getLoopIntervalParseErrorMessage(parsed.reason),
    };
  }
  return { intervalMs: parsed.intervalMs, error: null };
}

function sessionTasks(
  tasks: CronRecord[],
  currentSessionId: string | null
): CronRecord[] {
  return tasks.filter(
    (task) =>
      isUserVisibleCron(task) &&
      task.scope.type === 'session' &&
      task.scope.sessionId === currentSessionId
  );
}

function recentTemplateKey(cron: CronRecord): string {
  return [cron.schedule.expression, cron.payload.prompt].join('\u0000');
}

function getRecentTemplates(
  history: CronRecord[],
  visibleTasks: CronRecord[]
): CronRecord[] {
  const visibleKeys = new Set(visibleTasks.map(recentTemplateKey));
  const selectedKeys = new Set<string>();

  return history
    .filter(
      (cron) =>
        ['held', 'paused', 'cancelled', 'expired'].includes(cron.status) &&
        cron.payload.target.type === 'same_session'
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .filter((cron) => {
      const key = recentTemplateKey(cron);
      if (visibleKeys.has(key) || selectedKeys.has(key)) {
        return false;
      }
      selectedKeys.add(key);
      return true;
    })
    .slice(0, MAX_RECENT_TEMPLATES);
}

interface DetailLine {
  readonly label: string;
  readonly value: string;
}

function buildDetailLines(
  cron: CronRecord,
  t: (key: string) => string
): DetailLine[] {
  const lines: DetailLine[] = [
    {
      label: t('loop.modal.detail.prompt'),
      value: sanitizeDetailValue(cron.payload.prompt),
    },
    {
      label: t('loop.modal.detail.target'),
      value: cron.payload.target.type,
    },
  ];
  if (cron.stats.lastRunAt) {
    const last = formatCronTime(cron.stats.lastRunAt);
    if (last) {
      lines.push({ label: t('loop.modal.detail.lastRun'), value: last });
    }
  }
  if (cron.stats.lastError) {
    lines.push({
      label: t('loop.modal.detail.lastError'),
      value: sanitizeDetailValue(cron.stats.lastError),
    });
  }
  const hold = formatHoldReason(cron);
  if (hold) {
    lines.push({
      label: t('loop.modal.detail.hold'),
      value: sanitizeDetailValue(hold),
    });
  }
  return lines;
}

interface LoopRowProps {
  task: CronRecord;
  isSelected: boolean;
  isFocused: boolean;
  isExpanded: boolean;
  isConfirming: boolean;
  confirmPrompt: string;
  now: number;
}

function LoopRow({
  task,
  isSelected,
  isFocused,
  isExpanded,
  isConfirming,
  confirmPrompt,
  now,
}: LoopRowProps) {
  const { t } = useTranslation('commands');
  const cadence = formatCronCadence(task.schedule.expression);
  const hasNoUpcomingRun =
    task.status === 'paused' || task.status === 'cancelled';
  const nextRun = hasNoUpcomingRun
    ? null
    : formatCronTime(task.schedule.nextRunAt);
  const countdown = hasNoUpcomingRun
    ? null
    : formatCronCountdown(task.schedule.nextRunAt, now);
  const whenSegment =
    task.status === 'paused'
      ? t('loop.modal.pausedBoundaryHint')
      : nextRun
        ? countdown
          ? `next ${nextRun} \u00b7 ${countdown}`
          : `next ${nextRun}`
        : null;
  const badge = formatCronStatusBadge(task.status);
  const accent = isConfirming
    ? COLORS.error
    : isSelected && isFocused
      ? COLORS.primary
      : COLORS.text.secondary;
  const muted = isConfirming ? COLORS.error : COLORS.text.muted;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={accent} bold={isSelected && isFocused}>
          {isSelected ? '\u25b8 ' : '  '}
        </Text>
        <Text color={accent}>{shortId(task.id)}</Text>
        <Text color={muted}>{'  '}</Text>
        <Text color={badge.color}>[{badge.label}]</Text>
        <Text color={muted}>{'  '}</Text>
        <Text color={muted}>{cadence.padEnd(10, ' ')}</Text>
        {whenSegment ? <Text color={muted}>{`  ${whenSegment}`}</Text> : null}
        <Text color={muted}>{'  \u00b7 '}</Text>
        <Text color={muted}>#{task.stats.fireCount}</Text>
        <Text color={muted}>{'  '}</Text>
        <Text color={accent}>{previewPrompt(task)}</Text>
      </Box>
      {isExpanded &&
        buildDetailLines(task, t).map((line) => (
          <Box key={`${task.id}-detail-${line.label}`} marginLeft={4}>
            <Text color={COLORS.text.muted}>{line.label}: </Text>
            <Text color={COLORS.text.secondary}>{line.value}</Text>
          </Box>
        ))}
      {isConfirming && (
        <Box marginLeft={2}>
          <Text color={COLORS.error}>{confirmPrompt}</Text>
        </Box>
      )}
    </Box>
  );
}

interface RecipePickerProps {
  recipes: readonly CronRecipe[];
  hint: string;
}

function RecipePicker({ recipes, hint }: RecipePickerProps) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={COLORS.text.secondary}>{hint}</Text>
      {recipes.map((recipe, index) => (
        <Box key={recipe.id}>
          <Text color={COLORS.primary}>{`  ${index + 1}.`}</Text>
          <Text color={COLORS.text.secondary}>{` ${recipe.label}`}</Text>
        </Box>
      ))}
    </Box>
  );
}

interface RecentTemplatePickerProps {
  templates: CronRecord[];
  isExpanded: boolean;
}

function RecentTemplatePicker({
  templates,
  isExpanded,
}: RecentTemplatePickerProps) {
  const { t } = useTranslation('commands');
  const noun = t('loop.modal.recentLoops');
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={COLORS.text.secondary}>
        {isExpanded
          ? t('loop.modal.recentExpanded', { noun })
          : t('loop.modal.recentCollapsed', {
              count: templates.length,
              noun,
            })}
      </Text>
      {isExpanded &&
        templates.map((template, index) => (
          <Box key={template.id}>
            <Text color={COLORS.primary}>{`  ${index + 1}.`}</Text>
            <Text color={COLORS.text.secondary}>
              {' '}
              {t('loop.modal.recentTemplate', {
                cadence: formatCronCadence(template.schedule.expression),
                prompt: previewPrompt(template),
              })}
            </Text>
          </Box>
        ))}
    </Box>
  );
}

// oxlint-disable-next-line react/no-giant-component, react/prefer-useReducer
export function LoopModal({
  scheduledTasks,
  cronHistory = [],
  currentSessionId,
  currentSessionCwd,
  onCancel,
  onChanged,
  onCreated,
}: LoopModalProps) {
  const { t } = useTranslation('commands');
  const now = useCountdownTick();

  const sortedTasks = useMemo(
    () =>
      sessionTasks(scheduledTasks, currentSessionId).toSorted(
        compareCronRecords
      ),
    [scheduledTasks, currentSessionId]
  );
  const recentTemplates = useMemo(
    () => getRecentTemplates(cronHistory, sortedTasks),
    [cronHistory, sortedTasks]
  );

  const [chipIndex, setChipIndex] = useState(DEFAULT_CHIP_INDEX);
  const [customCadence, setCustomCadence] = useState('');
  const [prompt, setPrompt] = useState('');
  // oxlint-disable react/rerender-state-only-in-handlers
  const [focus, setFocus] = useState<Focus>(
    sortedTasks.length > 0 ? 'list' : 'chips'
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [mode, setMode] = useState<FormMode>({ kind: 'create' });
  const [showRecent, setShowRecent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // oxlint-enable react/rerender-state-only-in-handlers

  const selectedChip = DEFAULT_CADENCE_CHIPS[chipIndex];
  const isCustomChip = chipIndex === CUSTOM_CHIP_INDEX;
  const { intervalMs: customIntervalMs, error: customError } = useMemo(
    () => parseCustomCadence(customCadence),
    [customCadence]
  );
  const intervalMs = isCustomChip
    ? customIntervalMs
    : (selectedChip?.intervalMs ?? null);

  const effectiveFocus: Focus =
    sortedTasks.length === 0 && focus === 'list' ? 'chips' : focus;
  const effectiveSelectedIndex =
    sortedTasks.length > 0
      ? Math.min(selectedIndex, sortedTasks.length - 1)
      : 0;
  const effectiveConfirm =
    confirm?.kind === 'one' &&
    !sortedTasks.some((task) => task.id === confirm.id)
      ? null
      : confirm;
  const effectiveExpandedId =
    expandedId && sortedTasks.some((task) => task.id === expandedId)
      ? expandedId
      : null;
  const selectedTask =
    sortedTasks.length > 0 ? sortedTasks[effectiveSelectedIndex] : null;

  const cycleChip = useCallback((direction: 1 | -1) => {
    setError(null);
    setChipIndex((prev) => {
      const len = DEFAULT_CADENCE_CHIPS.length;
      return (prev + direction + len) % len;
    });
  }, []);

  const cycleFocus = useCallback(
    (direction: 1 | -1) => {
      const sequence: Focus[] = ['list', 'chips'];
      if (isCustomChip) sequence.push('custom');
      sequence.push('prompt');
      const filtered =
        sortedTasks.length === 0
          ? sequence.filter((zone) => zone !== 'list')
          : sequence;
      const currentIdx = Math.max(0, filtered.indexOf(effectiveFocus));
      const nextIdx =
        (currentIdx + direction + filtered.length) % filtered.length;
      setFocus(filtered[nextIdx]);
      setError(null);
    },
    [effectiveFocus, isCustomChip, sortedTasks.length]
  );

  const recipes = SESSION_LOOP_RECIPES;

  const applyRecipe = useCallback((recipe: CronRecipe) => {
    const chipAtIndex = DEFAULT_CADENCE_CHIPS.findIndex(
      (chip) => chip.intervalMs === recipe.intervalMs
    );
    if (chipAtIndex >= 0) {
      setChipIndex(chipAtIndex);
      setCustomCadence('');
    } else {
      setChipIndex(CUSTOM_CHIP_INDEX);
      setCustomCadence(formatLoopInterval(recipe.intervalMs));
    }
    setPrompt(recipe.prompt);
    setFocus('prompt');
    setError(null);
  }, []);

  const resetForm = useCallback(() => {
    setPrompt('');
    setCustomCadence('');
    setChipIndex(DEFAULT_CHIP_INDEX);
    setMode({ kind: 'create' });
    setShowRecent(false);
    setNotice(null);
    setError(null);
  }, []);

  const prefillFromTask = useCallback((task: CronRecord) => {
    const intervalMsForExpr = cronExpressionToIntervalMs(
      task.schedule.expression
    );
    const chipForInterval =
      intervalMsForExpr === null
        ? -1
        : DEFAULT_CADENCE_CHIPS.findIndex(
            (chip) => chip.intervalMs === intervalMsForExpr
          );
    if (chipForInterval >= 0) {
      setChipIndex(chipForInterval);
      setCustomCadence('');
    } else if (intervalMsForExpr !== null) {
      setChipIndex(CUSTOM_CHIP_INDEX);
      setCustomCadence(formatLoopInterval(intervalMsForExpr));
    } else {
      setChipIndex(CUSTOM_CHIP_INDEX);
      setCustomCadence('');
    }
    setPrompt(task.payload.prompt);
  }, []);

  const applyRecentTemplate = useCallback(
    (task: CronRecord) => {
      prefillFromTask(task);
      setMode({ kind: 'create' });
      setShowRecent(false);
      setNotice(null);
      setFocus('prompt');
      setError(null);
    },
    [prefillFromTask]
  );

  const enterEditMode = useCallback(
    (task: CronRecord) => {
      prefillFromTask(task);
      setMode({ kind: 'edit', cronId: task.id });
      setShowRecent(false);
      setNotice(null);
      setFocus('prompt');
      setError(null);
    },
    [prefillFromTask]
  );

  const handleSubmit = useCallback(async () => {
    if (intervalMs === null) {
      setError(
        isCustomChip
          ? (customError ?? t('loop.modal.invalidInterval'))
          : t('loop.modal.invalidInterval')
      );
      return;
    }
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError(t('loop.modal.emptyPrompt'));
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      if (mode.kind === 'edit') {
        await editCron({
          cronId: mode.cronId,
          intervalMs,
          prompt: trimmedPrompt,
        });
        resetForm();
        setFocus('list');
        setSelectedIndex(0);
        onChanged?.();
        return;
      }
      if (!currentSessionId) {
        setError(t('loop.noActiveSession'));
        return;
      }
      const cron = await createSessionCron({
        sessionId: currentSessionId,
        sessionCwd: currentSessionCwd,
        intervalMs,
        prompt: trimmedPrompt,
      });
      onChanged?.();
      onCreated?.(cron);
      onCancel();
    } catch (caughtError) {
      setError(formatLoopActionError(caughtError));
    } finally {
      setIsSubmitting(false);
    }
  }, [
    currentSessionCwd,
    currentSessionId,
    customError,
    intervalMs,
    isCustomChip,
    mode,
    onCancel,
    onChanged,
    onCreated,
    prompt,
    resetForm,
    t,
  ]);

  const handleTogglePause = useCallback(
    async (task: CronRecord) => {
      const isPaused = task.status === 'paused';
      const action = isPaused ? resumeCron : pauseCron;
      setError(null);
      setNotice(null);
      setIsSubmitting(true);
      try {
        const updated = await action(task.id);
        if (isPaused) {
          const nextRun = formatCronTime(updated?.schedule.nextRunAt);
          setNotice(
            nextRun
              ? t('loop.modal.resumedAtBoundary', { time: nextRun })
              : t('loop.modal.resumedBoundary')
          );
        }
        onChanged?.();
      } catch (caughtError) {
        setError(formatLoopActionError(caughtError));
      } finally {
        setIsSubmitting(false);
      }
    },
    [onChanged, t]
  );

  const handleStopOne = useCallback(
    async (task: CronRecord) => {
      setError(null);
      setIsSubmitting(true);
      try {
        await deleteCronAction(
          task.id,
          task.scope.type === 'session' ? task.scope.sessionId : undefined
        );
        onChanged?.();
      } catch (caughtError) {
        setError(formatLoopActionError(caughtError));
      } finally {
        setIsSubmitting(false);
        setConfirm(null);
      }
    },
    [onChanged]
  );

  const handleStopAll = useCallback(async () => {
    setError(null);
    setIsSubmitting(true);
    try {
      await Promise.all(
        sortedTasks.map((task) =>
          deleteCronAction(
            task.id,
            task.scope.type === 'session' ? task.scope.sessionId : undefined
          )
        )
      );
      onChanged?.();
    } catch (caughtError) {
      setError(formatLoopActionError(caughtError));
    } finally {
      setIsSubmitting(false);
      setConfirm(null);
    }
  }, [onChanged, sortedTasks]);

  useKeypressHandler(
    (input, key) => {
      if (key.escape) {
        if (effectiveConfirm) {
          setConfirm(null);
          return;
        }
        if (mode.kind === 'edit') {
          resetForm();
          setFocus(sortedTasks.length > 0 ? 'list' : 'chips');
          return;
        }
        if (effectiveExpandedId) {
          setExpandedId(null);
          return;
        }
        onCancel();
        return;
      }

      if (effectiveConfirm) {
        if (input === 'y' || input === 'Y') {
          if (effectiveConfirm.kind === 'one') {
            const task = sortedTasks.find(
              (candidate) => candidate.id === effectiveConfirm.id
            );
            if (task) void handleStopOne(task);
          } else {
            void handleStopAll();
          }
          return;
        }
        if (input === 'n' || input === 'N') {
          setConfirm(null);
        }
        return;
      }

      if (
        mode.kind === 'create' &&
        recentTemplates.length > 0 &&
        effectiveFocus !== 'list' &&
        effectiveFocus !== 'prompt' &&
        effectiveFocus !== 'custom' &&
        input.toLowerCase() === 'r'
      ) {
        setShowRecent((previous) => !previous);
        setError(null);
        setNotice(null);
        return;
      }

      if (effectiveFocus !== 'list' && (key.upArrow || key.downArrow)) {
        cycleFocus(key.upArrow ? -1 : 1);
        return;
      }

      if (
        showRecent &&
        mode.kind === 'create' &&
        effectiveFocus !== 'prompt' &&
        effectiveFocus !== 'custom'
      ) {
        const idx = Number(input);
        if (
          Number.isInteger(idx) &&
          idx >= 1 &&
          idx <= recentTemplates.length
        ) {
          applyRecentTemplate(recentTemplates[idx - 1]);
          return;
        }
      }

      if (
        !showRecent &&
        sortedTasks.length === 0 &&
        effectiveFocus !== 'prompt' &&
        effectiveFocus !== 'custom'
      ) {
        const idx = Number(input);
        if (Number.isInteger(idx) && idx >= 1 && idx <= recipes.length) {
          applyRecipe(recipes[idx - 1]);
          return;
        }
      }

      if (effectiveFocus === 'list') {
        if (key.upArrow) {
          if (effectiveSelectedIndex === 0) {
            cycleFocus(-1);
          } else {
            setSelectedIndex((prev) => prev - 1);
          }
          return;
        }
        if (key.downArrow) {
          if (effectiveSelectedIndex === sortedTasks.length - 1) {
            cycleFocus(1);
          } else {
            setSelectedIndex((prev) => prev + 1);
          }
          return;
        }
        if (key.return && selectedTask) {
          const isOpening = effectiveExpandedId !== selectedTask.id;
          setExpandedId(isOpening ? selectedTask.id : null);
          return;
        }
        if (input === 'd' && selectedTask) {
          setConfirm({ kind: 'one', id: selectedTask.id });
          return;
        }
        if (input === 'D' && sortedTasks.length > 0) {
          setConfirm({ kind: 'all' });
          return;
        }
        if (input === 'e' && selectedTask) {
          enterEditMode(selectedTask);
          return;
        }
        if (input === 'p' && selectedTask) {
          void handleTogglePause(selectedTask);
          return;
        }
        return;
      }

      if (effectiveFocus === 'chips') {
        if (key.leftArrow) {
          cycleChip(-1);
          return;
        }
        if (key.rightArrow) {
          cycleChip(1);
          return;
        }
        if (key.return) {
          cycleFocus(1);
        }
      }
    },
    { isActive: true }
  );

  const helpText = effectiveConfirm
    ? t('loop.modal.helpConfirm')
    : effectiveFocus === 'list'
      ? t('loop.modal.helpList')
      : effectiveFocus === 'chips'
        ? t('loop.modal.helpChips')
        : effectiveFocus === 'custom'
          ? t('loop.modal.helpCustom')
          : t('loop.modal.helpPrompt');

  return (
    <MenuContainer title={t('loop.modal.title')} helpText={helpText}>
      <Box flexDirection="column">
        {sortedTasks.length > 0 ? (
          <>
            <Text color={COLORS.text.secondary}>
              {t('loop.modal.scheduledTasksHeader')}
            </Text>
            <Box marginTop={1} flexDirection="column">
              {sortedTasks.map((task, index) => (
                <LoopRow
                  key={task.id}
                  task={task}
                  isSelected={index === effectiveSelectedIndex}
                  isFocused={effectiveFocus === 'list'}
                  isExpanded={effectiveExpandedId === task.id}
                  isConfirming={
                    effectiveConfirm?.kind === 'one' &&
                    effectiveConfirm.id === task.id
                      ? true
                      : effectiveConfirm?.kind === 'all'
                  }
                  confirmPrompt={
                    effectiveConfirm?.kind === 'one' &&
                    effectiveConfirm.id === task.id
                      ? t('loop.modal.stopConfirm', { id: shortId(task.id) })
                      : effectiveConfirm?.kind === 'all' && index === 0
                        ? t('loop.modal.stopAllConfirm')
                        : ''
                  }
                  now={now}
                />
              ))}
            </Box>
            <Box marginTop={1}>
              <Text color={COLORS.text.muted}>{'\u2500'.repeat(38)}</Text>
            </Box>
          </>
        ) : (
          <>
            <Text color={COLORS.text.muted}>{t('loop.modal.emptyState')}</Text>
            {!showRecent && (
              <RecipePicker
                recipes={recipes}
                hint={t('loop.modal.recipeHint')}
              />
            )}
          </>
        )}

        <Box marginTop={1} flexDirection="column">
          <Text
            color={
              effectiveFocus !== 'list'
                ? COLORS.text.secondary
                : COLORS.text.muted
            }
            bold={effectiveFocus !== 'list'}
          >
            {mode.kind === 'edit'
              ? t('loop.modal.editingLabel', { id: shortId(mode.cronId) })
              : t('loop.modal.newLoopLabel')}
          </Text>
          {mode.kind === 'create' && recentTemplates.length > 0 && (
            <RecentTemplatePicker
              templates={recentTemplates}
              isExpanded={showRecent}
            />
          )}
          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text
                color={
                  effectiveFocus === 'chips'
                    ? COLORS.text.secondary
                    : COLORS.text.muted
                }
              >
                {t('loop.modal.cadenceLabel')}{' '}
              </Text>
            </Box>
            <CadenceChips
              chips={DEFAULT_CADENCE_CHIPS}
              selectedIndex={chipIndex}
              isFocused={effectiveFocus === 'chips'}
            />
            {isCustomChip && (
              <Box marginTop={1} flexDirection="column">
                <Text
                  color={
                    effectiveFocus === 'custom'
                      ? COLORS.text.secondary
                      : COLORS.text.muted
                  }
                >
                  {t('loop.modal.customCadenceLabel')}
                </Text>
                <Box>
                  <Text
                    color={
                      effectiveFocus === 'custom'
                        ? COLORS.primary
                        : COLORS.text.muted
                    }
                  >
                    &gt;{' '}
                  </Text>
                  <TextInput
                    value={customCadence}
                    onChange={(next) => {
                      setCustomCadence(next);
                      if (error) setError(null);
                    }}
                    placeholder={t('loop.modal.customCadencePlaceholder')}
                    focus={effectiveFocus === 'custom' && !effectiveConfirm}
                  />
                </Box>
                {customError && <Text color={COLORS.error}>{customError}</Text>}
              </Box>
            )}
            <Box marginTop={1} flexDirection="column">
              <Text
                color={
                  effectiveFocus === 'prompt'
                    ? COLORS.text.secondary
                    : COLORS.text.muted
                }
              >
                {t('loop.modal.promptLabel')}
              </Text>
              <Box>
                <Text
                  color={
                    effectiveFocus === 'prompt'
                      ? COLORS.primary
                      : COLORS.text.muted
                  }
                >
                  &gt;{' '}
                </Text>
                <TextInput
                  value={prompt}
                  onChange={(next) => {
                    setPrompt(next);
                    if (error) setError(null);
                  }}
                  onSubmit={() => {
                    if (effectiveFocus === 'prompt') void handleSubmit();
                  }}
                  placeholder={t('loop.modal.promptPlaceholder')}
                  focus={effectiveFocus === 'prompt' && !effectiveConfirm}
                />
              </Box>
            </Box>
          </Box>
        </Box>

        {isSubmitting && (
          <Box marginTop={1}>
            <Text color={COLORS.primary}>{t('loop.modal.starting')}</Text>
          </Box>
        )}
        {error && (
          <Box marginTop={1}>
            <Text color={COLORS.error}>{error}</Text>
          </Box>
        )}
        {notice && (
          <Box marginTop={1}>
            <Text color={COLORS.success}>{notice}</Text>
          </Box>
        )}
      </Box>
    </MenuContainer>
  );
}
