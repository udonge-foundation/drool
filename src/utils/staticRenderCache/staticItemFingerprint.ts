import type {
  CollapsedToolGroup,
  GroupedItem,
  ToolExecution,
} from '@/types/types';
import { createStaticRenderFingerprint } from '@/utils/staticRenderCache';

const itemFingerprintCache = new WeakMap<object, string>();

function getStringSize(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (value === undefined || value === null) return 0;
  return JSON.stringify(value).length;
}

function getValueFingerprint(value: unknown): string {
  if (value === undefined || value === null) return 'empty';
  return createStaticRenderFingerprint(value);
}

function isCollapsedToolGroup(item: GroupedItem): item is CollapsedToolGroup {
  return 'kind' in item && item.kind === 'collapsed-tool-group';
}

function createToolPayload(item: ToolExecution): unknown {
  return {
    type: 'tool',
    id: item.id,
    toolName: item.toolName,
    status: item.status,
    isError: item.isError,
    input: getValueFingerprint(item.toolInput),
    result: getValueFingerprint(item.result),
    detailed: getValueFingerprint(item.detailedContent),
    progressCount: item.progressUpdates?.length ?? 0,
    endTime: item.endTime,
  };
}

function createItemPayload(item: GroupedItem): unknown {
  if (isCollapsedToolGroup(item)) {
    return {
      type: 'collapsed-tool-group',
      id: item.id,
      toolName: item.toolName,
      tools: item.tools.map(createToolPayload),
    };
  }

  if ('toolName' in item && 'status' in item) {
    return createToolPayload(item);
  }

  return {
    type: 'message',
    id: item.id,
    role: item.role,
    messageType: item.messageType,
    content: getValueFingerprint(item.content),
    imageCount: item.images?.length ?? 0,
    hookStatus: item.hookStatus,
    hookCount: item.hookCommands?.length ?? 0,
    thinking: getValueFingerprint(item.thinkingBlock?.thinking),
  };
}

function getStaticRenderItemFingerprint(item: GroupedItem): string {
  const objectKey = item as object;
  const cached = itemFingerprintCache.get(objectKey);
  if (cached) return cached;

  const fingerprint = createStaticRenderFingerprint(createItemPayload(item));
  itemFingerprintCache.set(objectKey, fingerprint);
  return fingerprint;
}

export function getStaticRenderItemsFingerprint(items: GroupedItem[]): string {
  return items.map(getStaticRenderItemFingerprint).join(',');
}

export function estimateStaticRenderItemsSize(items: GroupedItem[]): number {
  return items.reduce((total, item) => {
    if (isCollapsedToolGroup(item)) {
      return total + estimateStaticRenderItemsSize(item.tools);
    }

    if ('toolName' in item && 'status' in item) {
      return (
        total +
        getStringSize(item.toolInput) +
        getStringSize(item.result) +
        getStringSize(item.detailedContent)
      );
    }
    return (
      total +
      getStringSize(item.content) +
      getStringSize(item.thinkingBlock?.thinking)
    );
  }, 0);
}
