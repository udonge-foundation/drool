import { Automation } from '@industry/common/api/v0/automations';
import { ToolExecutionErrorType } from '@industry/common/session';
import {
  createAutomationCliTool,
  deleteAutomationCliTool,
  editAutomationCliTool,
  listAutomationsCliTool,
  readAutomationCliTool,
} from '@industry/drool-core/tools/definitions';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import { Metrics } from '@industry/logging';
import { ToolAbortError } from '@industry/logging/errors';

import {
  createAutomation,
  deleteAutomation,
  editAutomation,
  listAutomations,
  readAutomation,
} from '@/services/automations/automationService';
import { getTUIToolRegistry } from '@/tools/registry';
import type {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';

import type { AutomationEntry } from '@industry/common/daemon';
import type {
  AutomationCreateParams,
  AutomationDeleteParams,
  AutomationEditParams,
  AutomationListParams,
  AutomationReadParams,
} from '@industry/drool-core/tools/definitions/cli';
import type {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';

const AUTOMATION_TOOL_METRIC = 'automation_tool_invocation_count';

function logAutomationTool(
  tool: 'create' | 'list' | 'read' | 'edit' | 'delete',
  outcome: 'success' | 'failure',
  location: 'local' | 'remote'
): void {
  Metrics.addToCounter(AUTOMATION_TOOL_METRIC, 1, {
    toolName: tool,
    status: outcome,
    location,
  });
}

function formatRemoteAutomation(automation: Automation): string {
  const computer = automation.computerName ?? automation.computerId ?? 'none';
  const runs = automation.runCount ?? 0;
  return `${automation.id} · ${automation.name} · ${automation.status} · ${automation.schedule} · computer:${computer} · #${runs}`;
}

function formatLocalAutomation(entry: AutomationEntry): string {
  const schedule = entry.schedule ?? 'n/a';
  return `${entry.id} · ${entry.name} · ${entry.status} · ${schedule} · local`;
}

function formatReadAutomation(
  read: Awaited<ReturnType<typeof readAutomation>>
): string | null {
  if (read.location === 'remote') {
    return read.automation ? formatRemoteAutomation(read.automation) : null;
  }
  return read.automation ? formatLocalAutomation(read.automation) : null;
}

function emitError(
  tool: 'create' | 'list' | 'read' | 'edit' | 'delete',
  location: 'local' | 'remote',
  error: unknown
): DraftToolFeedback<string> {
  logAutomationTool(tool, 'failure', location);
  const message = error instanceof Error ? error.message : String(error);
  return {
    type: DraftToolFeedbackType.Result,
    isError: true,
    errorType: ToolExecutionErrorType.InvalidParameterLLMError,
    userError: message,
    llmError: message,
  };
}

function createCreateAutomationExecutor(): ClientToolExecutor<
  CliClientSpecificToolDependencies,
  string
> {
  return {
    async *execute(
      dependencies: CliClientToolDependencies,
      parameters: AutomationCreateParams
    ): AsyncGenerator<DraftToolFeedback<string>> {
      if (dependencies.abortSignal?.aborted) {
        throw new ToolAbortError();
      }
      try {
        const result = await createAutomation({
          executionLocation: parameters.executionLocation,
          name: parameters.name,
          schedule: parameters.schedule,
          prompt: parameters.prompt,
          description: parameters.description,
          visualizationInstruction: parameters.visualization_instruction,
          memoryInstruction: parameters.memory_instruction,
          computerId: parameters.computerId,
        });
        const read = await readAutomation(
          parameters.executionLocation,
          result.automationId
        );
        const formatted = formatReadAutomation(read);
        const noun =
          parameters.executionLocation === 'remote'
            ? 'Cloud automation'
            : 'Automation';
        let value = formatted
          ? `${noun} created:\n${formatted}`
          : `${noun} ${result.automationId} created.`;
        if (result.runNote) {
          value += `\n${result.runNote}`;
        }
        logAutomationTool('create', 'success', parameters.executionLocation);
        yield { type: DraftToolFeedbackType.Result, isError: false, value };
      } catch (error) {
        yield emitError('create', parameters.executionLocation, error);
      }
    },
  };
}

function createListAutomationsExecutor(): ClientToolExecutor<
  CliClientSpecificToolDependencies,
  string
> {
  return {
    async *execute(
      dependencies: CliClientToolDependencies,
      parameters: AutomationListParams
    ): AsyncGenerator<DraftToolFeedback<string>> {
      if (dependencies.abortSignal?.aborted) {
        throw new ToolAbortError();
      }
      try {
        const listed = await listAutomations(parameters.executionLocation);
        let value: string;
        if (listed.location === 'remote') {
          value =
            listed.automations.length > 0
              ? listed.automations.map(formatRemoteAutomation).join('\n')
              : 'No cloud automations.';
        } else {
          value =
            listed.automations.length > 0
              ? listed.automations.map(formatLocalAutomation).join('\n')
              : 'No local automations.';
        }
        logAutomationTool('list', 'success', parameters.executionLocation);
        yield { type: DraftToolFeedbackType.Result, isError: false, value };
      } catch (error) {
        yield emitError('list', parameters.executionLocation, error);
      }
    },
  };
}

function createReadAutomationExecutor(): ClientToolExecutor<
  CliClientSpecificToolDependencies,
  string
> {
  return {
    async *execute(
      dependencies: CliClientToolDependencies,
      parameters: AutomationReadParams
    ): AsyncGenerator<DraftToolFeedback<string>> {
      if (dependencies.abortSignal?.aborted) {
        throw new ToolAbortError();
      }
      try {
        const read = await readAutomation(
          parameters.executionLocation,
          parameters.automationId
        );
        const formatted = formatReadAutomation(read);
        const noun =
          parameters.executionLocation === 'remote'
            ? 'Cloud automation'
            : 'Local automation';
        const value =
          formatted ?? `${noun} ${parameters.automationId} was not found.`;
        logAutomationTool('read', 'success', parameters.executionLocation);
        yield { type: DraftToolFeedbackType.Result, isError: false, value };
      } catch (error) {
        yield emitError('read', parameters.executionLocation, error);
      }
    },
  };
}

function createEditAutomationExecutor(): ClientToolExecutor<
  CliClientSpecificToolDependencies,
  string
> {
  return {
    async *execute(
      dependencies: CliClientToolDependencies,
      parameters: AutomationEditParams
    ): AsyncGenerator<DraftToolFeedback<string>> {
      if (dependencies.abortSignal?.aborted) {
        throw new ToolAbortError();
      }
      try {
        await editAutomation({
          executionLocation: parameters.executionLocation,
          automationId: parameters.automationId,
          name: parameters.name,
          description: parameters.description,
          schedule: parameters.schedule,
          prompt: parameters.prompt,
          status: parameters.status,
          computerId: parameters.computerId,
        });
        const read = await readAutomation(
          parameters.executionLocation,
          parameters.automationId
        );
        const formatted = formatReadAutomation(read);
        const noun =
          parameters.executionLocation === 'remote'
            ? 'Cloud automation'
            : 'Automation';
        const value = formatted
          ? `${noun} updated:\n${formatted}`
          : `${noun} ${parameters.automationId} updated.`;
        logAutomationTool('edit', 'success', parameters.executionLocation);
        yield { type: DraftToolFeedbackType.Result, isError: false, value };
      } catch (error) {
        yield emitError('edit', parameters.executionLocation, error);
      }
    },
  };
}

function createDeleteAutomationExecutor(): ClientToolExecutor<
  CliClientSpecificToolDependencies,
  string
> {
  return {
    async *execute(
      dependencies: CliClientToolDependencies,
      parameters: AutomationDeleteParams
    ): AsyncGenerator<DraftToolFeedback<string>> {
      if (dependencies.abortSignal?.aborted) {
        throw new ToolAbortError();
      }
      try {
        await deleteAutomation(
          parameters.executionLocation,
          parameters.automationId
        );
        const value =
          parameters.executionLocation === 'remote'
            ? `Cloud automation ${parameters.automationId} deleted.`
            : `Local automation ${parameters.automationId} deleted.`;
        logAutomationTool('delete', 'success', parameters.executionLocation);
        yield { type: DraftToolFeedbackType.Result, isError: false, value };
      } catch (error) {
        yield emitError('delete', parameters.executionLocation, error);
      }
    },
  };
}

export function registerAutomationTools(): void {
  getTUIToolRegistry().register({
    tool: createAutomationCliTool,
    executorIndustry: createCreateAutomationExecutor,
  });
  getTUIToolRegistry().register({
    tool: listAutomationsCliTool,
    executorIndustry: createListAutomationsExecutor,
  });
  getTUIToolRegistry().register({
    tool: readAutomationCliTool,
    executorIndustry: createReadAutomationExecutor,
  });
  getTUIToolRegistry().register({
    tool: editAutomationCliTool,
    executorIndustry: createEditAutomationExecutor,
  });
  getTUIToolRegistry().register({
    tool: deleteAutomationCliTool,
    executorIndustry: createDeleteAutomationExecutor,
  });
}
