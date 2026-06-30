import { DefaultTool } from '@/components/tools/implementations/DefaultTool';
import { getSubagentBadge } from '@/components/tools/implementations/subagentBadge';
import {
  ToolComponent,
  ToolComponentProps,
  ToolHeaderBadge,
} from '@/components/tools/registry/types';
import { backgroundTaskManager } from '@/services/BackgroundTaskManager';
import { getTextContent } from '@/utils/tool-result-helpers';

import type { ToolStreamingUpdate } from '@industry/drool-sdk-ext/protocol/drool';

interface TaskOutputMetadata {
  subagentType?: string;
  description?: string;
  result?: string;
}

function parseTaskOutputMetadata(
  result: ToolComponentProps['result']
): TaskOutputMetadata {
  const text = getTextContent(result);
  if (!text) return {};

  const lines = text.split('\n');
  const remainingLines: string[] = [];
  let subagentType: string | undefined;
  let description: string | undefined;

  for (const line of lines) {
    const subagentTypeMatch = line.match(/^Subagent Type:\s*(.+)$/);
    if (subagentTypeMatch?.[1]) {
      subagentType = subagentTypeMatch[1].trim();
      continue;
    }

    const descriptionMatch = line.match(/^Description:\s*(.+)$/);
    if (descriptionMatch?.[1]) {
      description = descriptionMatch[1].trim();
      continue;
    }

    remainingLines.push(line);
  }

  return {
    subagentType,
    description,
    result: remainingLines.join('\n'),
  };
}

function parseTaskOutputProgressMetadata(
  progressUpdates: ToolStreamingUpdate[] | undefined
): TaskOutputMetadata {
  if (!progressUpdates) return {};

  for (const update of progressUpdates) {
    const subagentType = update.parameters?.subagent_type;
    const description = update.parameters?.description;
    if (typeof subagentType === 'string' || typeof description === 'string') {
      return {
        ...(typeof subagentType === 'string'
          ? { subagentType: subagentType.trim() }
          : {}),
        ...(typeof description === 'string'
          ? { description: description.trim() }
          : {}),
      };
    }
  }

  return {};
}

function getTaskOutputHeaderBadge(
  input: Record<string, unknown>
): ToolHeaderBadge {
  if (typeof input.subagent_type === 'string') {
    return getSubagentBadge(input.subagent_type);
  }

  const taskId = input.task_id as string | undefined;
  if (taskId) {
    const task = backgroundTaskManager.getTask(taskId);
    if (task?.subagentType) {
      return getSubagentBadge(task.subagentType);
    }
  }
  return getSubagentBadge('worker');
}

function getTaskOutputHeaderLabel(input: Record<string, unknown>): string {
  if (typeof input.description === 'string' && input.description) {
    return `"${input.description}"`;
  }

  const taskId = input.task_id as string | undefined;
  if (taskId) {
    const task = backgroundTaskManager.getTask(taskId);
    if (task?.description) {
      return `"${task.description}"`;
    }
  }
  return DefaultTool.getHeaderLabel(input);
}

const taskOutputTool: ToolComponent = {
  ...DefaultTool,
  getDisplayOverride({ input, result, progressUpdates }: ToolComponentProps) {
    const resultMetadata = parseTaskOutputMetadata(result);
    const progressMetadata = parseTaskOutputProgressMetadata(progressUpdates);
    const metadata = {
      ...progressMetadata,
      ...resultMetadata,
    };
    if (!metadata.subagentType && !metadata.description) {
      return undefined;
    }

    return {
      toolName: 'TaskOutput',
      input: {
        ...input,
        ...(metadata.subagentType
          ? { subagent_type: metadata.subagentType }
          : {}),
        ...(metadata.description ? { description: metadata.description } : {}),
      },
      ...(metadata.result !== undefined ? { result: metadata.result } : {}),
    };
  },
  getHeaderBadge: getTaskOutputHeaderBadge,
  getHeaderLabel: getTaskOutputHeaderLabel,
};

export { taskOutputTool as TaskOutputTool };
