import { ToolExecutionErrorType } from '@industry/common/session';
import {
  cronCreateCliTool,
  cronDeleteCliTool,
  cronListCliTool,
} from '@industry/drool-core/tools/definitions';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import { Metrics } from '@industry/logging';
import { MetaError, ToolAbortError } from '@industry/logging/errors';

import {
  formatCronRecord,
  formatCronRecordList,
} from '@/services/crons/format';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getSessionService } from '@/services/SessionService';
import { getTUIToolRegistry } from '@/tools/registry';
import type {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';

import type { CronRecord } from '@industry/common/daemon';
import type {
  CronCreateParams,
  CronDeleteParams,
  CronListParams,
} from '@industry/drool-core/tools/definitions/cli';
import type {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';

const CRON_TOOL_METRIC = 'cron_tool_invocation_count';

function logCronTool(
  tool: 'create' | 'list' | 'delete',
  outcome: 'success' | 'failure',
  labels: { type?: string; status?: string } = {}
): void {
  Metrics.addToCounter(CRON_TOOL_METRIC, 1, {
    toolName: tool,
    status: outcome,
    ...labels,
  });
}

function getToolSessionId(
  dependencies: CliClientToolDependencies
): string | null {
  const sessionId =
    dependencies.sessionId === 'unknown'
      ? getSessionService().getCurrentSessionId()
      : dependencies.sessionId;
  return sessionId ?? null;
}

function uniqueCrons(crons: CronRecord[]): CronRecord[] {
  return [...new Map(crons.map((cron) => [cron.id, cron])).values()];
}

function createCronCreateCliExecutor(): ClientToolExecutor<
  CliClientSpecificToolDependencies,
  string
> {
  return {
    async *execute(
      dependencies: CliClientToolDependencies,
      parameters: CronCreateParams
    ): AsyncGenerator<DraftToolFeedback<string>> {
      if (dependencies.abortSignal?.aborted) {
        throw new ToolAbortError();
      }

      try {
        const sessionId = getToolSessionId(dependencies);
        const target = parameters.target ?? { type: 'same_session' as const };
        const sessionCwd =
          getSessionService().getCurrentSessionCwd() ?? process.cwd();
        const controller =
          await getTuiDaemonAdapter().ensureConnectedAndGetController();
        const { cron } = await (async () => {
          if (target.type === 'same_session') {
            if (!sessionId) {
              throw new MetaError('No active session for cron');
            }
            return controller.createCron({
              kind: 'session_prompt',
              source: 'cron_tool',
              scope: {
                type: 'session',
                sessionId,
                sessionCwd,
              },
              schedule: {
                expression: parameters.expression,
                recurring: parameters.recurring,
              },
              runPolicy: {
                whenSessionInactive: 'hold',
              },
              payload: {
                type: 'prompt',
                prompt: parameters.job.prompt,
                target: { type: 'same_session' },
              },
            });
          }

          return controller.createCron({
            kind: 'root_prompt',
            source: 'cron_tool',
            scope: { type: 'root' },
            schedule: {
              expression: parameters.expression,
              recurring: parameters.recurring,
            },
            runPolicy: {
              whenSessionInactive: 'run_in_background',
            },
            payload: {
              type: 'prompt',
              prompt: parameters.job.prompt,
              target: {
                type: 'new_session',
                ...(target.cwd ? { cwd: target.cwd } : {}),
                ...(target.title ? { title: target.title } : {}),
              },
            },
          });
        })();
        logCronTool('create', 'success', {
          type: `${target.type}_${parameters.recurring ? 'recurring' : 'once'}`,
        });

        yield {
          type: DraftToolFeedbackType.Result,
          isError: false,
          value: `Cron created:\n${formatCronRecord(cron)}`,
        };
      } catch (error) {
        logCronTool('create', 'failure');
        const message = error instanceof Error ? error.message : String(error);
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.InvalidParameterLLMError,
          userError: message,
          llmError: message,
        };
      }
    },
  };
}

function createCronListCliExecutor(): ClientToolExecutor<
  CliClientSpecificToolDependencies,
  string
> {
  return {
    async *execute(
      dependencies: CliClientToolDependencies,
      _parameters: CronListParams
    ): AsyncGenerator<DraftToolFeedback<string>> {
      if (dependencies.abortSignal?.aborted) {
        throw new ToolAbortError();
      }

      const sessionId = getToolSessionId(dependencies);
      const controller =
        await getTuiDaemonAdapter().ensureConnectedAndGetController();
      const [{ crons: sessionCrons }, { crons: visibleCrons }] =
        await Promise.all([
          sessionId
            ? controller.listCrons({ sessionId })
            : Promise.resolve({ crons: [] }),
          controller.listCrons({}),
        ]);
      const crons = uniqueCrons([
        ...sessionCrons,
        ...visibleCrons.filter((cron) => cron.scope.type === 'root'),
      ]);
      logCronTool('list', 'success');
      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: formatCronRecordList(crons),
      };
    },
  };
}

function createCronDeleteCliExecutor(): ClientToolExecutor<
  CliClientSpecificToolDependencies,
  string
> {
  return {
    async *execute(
      dependencies: CliClientToolDependencies,
      parameters: CronDeleteParams
    ): AsyncGenerator<DraftToolFeedback<string>> {
      if (dependencies.abortSignal?.aborted) {
        throw new ToolAbortError();
      }

      const sessionId = getToolSessionId(dependencies);
      const controller =
        await getTuiDaemonAdapter().ensureConnectedAndGetController();
      let deleted = false;
      if (sessionId) {
        ({ deleted } = await controller.deleteCron({
          cronId: parameters.cronId,
          sessionId,
        }));
      }
      if (!deleted) {
        const { crons } = await controller.listCrons({ includeInactive: true });
        const target = crons.find((cron) => cron.id === parameters.cronId);
        if (target?.scope.type === 'root') {
          ({ deleted } = await controller.deleteCron({
            cronId: parameters.cronId,
          }));
        }
      }
      logCronTool('delete', 'success');

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: deleted
          ? `Cron ${parameters.cronId} cancelled.`
          : `Cron ${parameters.cronId} was not found.`,
      };
    },
  };
}

export function registerCronTools(): void {
  getTUIToolRegistry().register({
    tool: cronCreateCliTool,
    executorIndustry: createCronCreateCliExecutor,
  });
  getTUIToolRegistry().register({
    tool: cronListCliTool,
    executorIndustry: createCronListCliExecutor,
  });
  getTUIToolRegistry().register({
    tool: cronDeleteCliTool,
    executorIndustry: createCronDeleteCliExecutor,
  });
}
