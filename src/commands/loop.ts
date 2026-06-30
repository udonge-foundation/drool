import {
  cronCreateCliTool,
  cronDeleteCliTool,
  cronListCliTool,
} from '@industry/drool-core/tools/definitions';
import { LOOP_INTERVAL_POLICY } from '@industry/drool-sdk-ext/protocol/drool';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { Metrics } from '@industry/logging';

import { LoopIntervalParseFailureReason } from '@/commands/enums';
import { isLoopFeatureEnabled } from '@/commands/loopFeatureFlag';
import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { createSessionCron } from '@/services/crons/cronActions';
import {
  formatCronCadence,
  formatCronCountdown,
  formatCronRecord,
  formatCronRecordList,
  formatCronTime,
} from '@/services/crons/format';
import { resolveDefaultLoopPrompt } from '@/services/crons/loopPrompt';
import {
  isCronRepresentableIntervalMs,
  parseDuration,
  splitLeadingInterval,
  splitTrailingEveryInterval,
} from '@/services/crons/loopSchedule';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getDeferredToolsService } from '@/services/deferredTools/DeferredToolsService';
import { getSessionService } from '@/services/SessionService';

import type { CronRecord } from '@industry/common/daemon';

const CRON_TOOLS = [cronCreateCliTool, cronListCliTool, cronDeleteCliTool];
const LOOP_COMMAND_METRIC = 'cron_loop_command_count';

type LoopIntervalParseResult =
  | { ok: true; intervalMs: number }
  | { ok: false; reason: LoopIntervalParseFailureReason };

function validateLoopIntervalMs(intervalMs: number): LoopIntervalParseResult {
  if (intervalMs < LOOP_INTERVAL_POLICY.minMs) {
    return { ok: false, reason: LoopIntervalParseFailureReason.TooShort };
  }
  if (intervalMs > LOOP_INTERVAL_POLICY.maxMs) {
    return { ok: false, reason: LoopIntervalParseFailureReason.TooLong };
  }
  if (!isCronRepresentableIntervalMs(intervalMs)) {
    return {
      ok: false,
      reason: LoopIntervalParseFailureReason.InvalidFormat,
    };
  }
  return { ok: true, intervalMs };
}

export function parseLoopInterval(input: string): LoopIntervalParseResult {
  const duration = parseDuration(input);
  if (!duration) {
    return {
      ok: false,
      reason: LoopIntervalParseFailureReason.InvalidFormat,
    };
  }
  return validateLoopIntervalMs(duration.intervalMs);
}

export function formatLoopInterval(intervalMs: number): string {
  if (intervalMs % (60 * 60_000) === 0) {
    return `${intervalMs / (60 * 60_000)}h`;
  }
  if (intervalMs % 60_000 === 0) {
    return `${intervalMs / 60_000}m`;
  }
  return `${Math.round(intervalMs / 1_000)}s`;
}

export function getLoopIntervalParseErrorMessage(
  reason: LoopIntervalParseFailureReason
): string {
  const values = {
    examples: LOOP_INTERVAL_POLICY.examples,
    max: formatLoopInterval(LOOP_INTERVAL_POLICY.maxMs),
    min: formatLoopInterval(LOOP_INTERVAL_POLICY.minMs),
    range: LOOP_INTERVAL_POLICY.displayRange,
  };
  switch (reason) {
    case LoopIntervalParseFailureReason.TooShort:
      return getI18n().t('commands:loop.interval.tooShort', values);
    case LoopIntervalParseFailureReason.TooLong:
      return getI18n().t('commands:loop.interval.tooLong', values);
    case LoopIntervalParseFailureReason.InvalidFormat:
      return getI18n().t('commands:loop.interval.invalidFormat', values);
    default:
      return getI18n().t('commands:loop.interval.invalidFormat', values);
  }
}

function addLoopMessage(context: CommandContext, content: string): void {
  context.addEphemeralSystemMessage(content, {
    messageType: MessageType.SystemNotification,
    visibility: MessageVisibility.UserOnly,
  });
}

function logLoopCommand(action: string): void {
  Metrics.addToCounter(LOOP_COMMAND_METRIC, 1, { type: action });
}

function canRunWhenLoopCommandDisabled(
  subcommand: string | undefined
): boolean {
  return (
    subcommand === 'stop' || subcommand === 'status' || subcommand === 'list'
  );
}

function getCurrentSessionIdOrReport(context: CommandContext): string | null {
  const sessionId = getSessionService().getCurrentSessionId();
  if (!sessionId) {
    addLoopMessage(context, getI18n().t('commands:loop.noActiveSession'));
    return null;
  }
  return sessionId;
}

function enableAndLoadCronToolsForSession(sessionId: string): void {
  const sessionService = getSessionService();
  const currentEnabled = sessionService.getEnabledToolIds();
  const nextEnabled = new Set(currentEnabled);
  for (const tool of CRON_TOOLS) {
    nextEnabled.add(tool.id);
  }
  if (CRON_TOOLS.some((tool) => !currentEnabled.includes(tool.id))) {
    sessionService.setEnabledToolIds([...nextEnabled]);
  }
  getDeferredToolsService().markLoadedBatch(
    sessionId,
    CRON_TOOLS.map((tool) => tool.llmId ?? tool.id)
  );
}

function resolveLoopScheduleAndPrompt(input: string): {
  intervalMs: number;
  prompt: string;
} {
  const leading = splitLeadingInterval(input);
  const trailing = splitTrailingEveryInterval(input);
  const intervalMs = leading.intervalMs ?? trailing.intervalMs;
  if (intervalMs === null) {
    throw new Error(getI18n().t('commands:loop.usage'));
  }
  const validatedInterval = validateLoopIntervalMs(intervalMs);
  if (!validatedInterval.ok) {
    throw new Error(getLoopIntervalParseErrorMessage(validatedInterval.reason));
  }
  const prompt =
    (leading.intervalMs !== null ? leading.prompt : trailing.prompt) ||
    resolveDefaultLoopPrompt();
  return { intervalMs: validatedInterval.intervalMs, prompt };
}

export function formatLoopScheduledMessage(cron: CronRecord): string {
  const cadence = formatCronCadence(cron.schedule.expression);
  const nextRun = formatCronTime(cron.schedule.nextRunAt);
  const countdown = formatCronCountdown(cron.schedule.nextRunAt);
  if (!nextRun) {
    return getI18n().t('commands:loop.scheduled.base', { cadence });
  }
  if (countdown) {
    return getI18n().t('commands:loop.scheduled.withCountdown', {
      cadence,
      countdown,
      nextRun,
    });
  }
  return getI18n().t('commands:loop.scheduled.withNextRun', {
    cadence,
    nextRun,
  });
}

function buildDynamicLoopSchedulingPrompt(request: string): string {
  return [
    'Create a session-scoped cron for this /loop request.',
    'Infer the best standard 5-field cron expression from the request.',
    'Call CronCreate exactly once with recurring=true, target.type="same_session", and job.type="prompt".',
    'Set job.prompt to a concise prompt that captures the requested recurring work.',
    'If the cadence is ambiguous, choose a reasonable recurring cadence and mention the assumption after the tool call.',
    `Request: ${request}`,
  ].join('\n');
}

// eslint-disable-next-line industry/constants-file-organization
export const loopCommand: SlashCommand = {
  name: 'loop',
  description:
    'Repeat a prompt on an interval until stopped, e.g. /loop 30min continue checklist.md',
  execute: async (
    args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    logLoopCommand('invoked');
    const subcommand = args[0]?.toLowerCase();
    if (!isLoopFeatureEnabled() && !canRunWhenLoopCommandDisabled(subcommand)) {
      logLoopCommand('disabled');
      addLoopMessage(context, getI18n().t('commands:loop.disabled'));
      return { handled: true };
    }

    const sessionId = getCurrentSessionIdOrReport(context);
    if (!sessionId) return { handled: true };
    enableAndLoadCronToolsForSession(sessionId);

    if (subcommand === 'stop') {
      const controller =
        await getTuiDaemonAdapter().ensureConnectedAndGetController();
      const taskId = args[1];
      if (taskId === 'all') {
        const { crons } = await controller.listCrons({ sessionId });
        await Promise.all(
          crons.map((cron) =>
            controller.deleteCron({ cronId: cron.id, sessionId })
          )
        );
        logLoopCommand('stopped_all');
      } else if (taskId) {
        await controller.deleteCron({ cronId: taskId, sessionId });
        logLoopCommand('stopped_one');
      } else {
        const { crons } = await controller.listCrons({ sessionId });
        if (crons.length === 1) {
          await controller.deleteCron({ cronId: crons[0].id, sessionId });
          logLoopCommand('stopped_one');
        } else {
          logLoopCommand('stop_failed_validation');
          addLoopMessage(context, getI18n().t('commands:loop.usage'));
          return { handled: true };
        }
      }
      addLoopMessage(context, getI18n().t('commands:loop.stopped'));
      return { handled: true };
    }

    if (subcommand === 'status' || subcommand === 'list') {
      const controller =
        await getTuiDaemonAdapter().ensureConnectedAndGetController();
      const { crons } = await controller.listCrons({ sessionId });
      logLoopCommand(subcommand === 'status' ? 'statused' : 'listed');
      addLoopMessage(context, formatCronRecordList(crons));
      return { handled: true };
    }

    const input = args.join(' ').trim();

    if (!input) {
      logLoopCommand('opened_modal');
      context.showLoopModal?.();
      return { handled: true };
    }

    if (
      splitLeadingInterval(input).intervalMs === null &&
      splitTrailingEveryInterval(input).intervalMs === null
    ) {
      return {
        handled: true,
        messageText: buildDynamicLoopSchedulingPrompt(input),
      };
    }

    let intervalMs: number;
    let prompt: string;
    try {
      ({ intervalMs, prompt } = resolveLoopScheduleAndPrompt(input));
    } catch (error) {
      logLoopCommand('failed_validation');
      addLoopMessage(
        context,
        error instanceof Error
          ? error.message
          : getI18n().t('commands:loop.usage')
      );
      return { handled: true };
    }
    const sessionCwd =
      getSessionService().getCurrentSessionCwd() ?? process.cwd();
    const cron = await createSessionCron({
      sessionId,
      sessionCwd,
      intervalMs,
      prompt,
    });
    logLoopCommand('created');
    addLoopMessage(
      context,
      `${formatLoopScheduledMessage(cron)}\n${formatCronRecord(cron)}`
    );
    return { handled: true };
  },
};
