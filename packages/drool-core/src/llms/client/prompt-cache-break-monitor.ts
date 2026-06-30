import { logWarn } from '@industry/logging';

import type {
  PromptCacheBreakMonitorInput,
  PromptCachePrefixResult,
  PromptCacheRequestSnapshot,
  PromptCacheSegmentInput,
  PromptCacheSegmentSnapshot,
} from './types';

const NON_PROMPT_REQUEST_KEYS = new Set([
  'additionalModelRequestFields',
  'frequency_penalty',
  'generationConfig',
  'include',
  'inferenceConfig',
  'max_completion_tokens',
  'max_output_tokens',
  'max_tokens',
  'metadata',
  'model',
  'n',
  'parallel_tool_calls',
  'presence_penalty',
  'prompt_cache_key',
  'prompt_cache_retention',
  'reasoning',
  'reasoning_effort',
  'safety_identifier',
  'service_tier',
  'stop',
  'stop_sequences',
  'store',
  'stream',
  'stream_options',
  'temperature',
  'thinking',
  'tool_choice',
  'top_k',
  'top_p',
  'user',
]);
const APPENDABLE_PROMPT_REQUEST_KEYS = new Set([
  'contents',
  'input',
  'messages',
]);
const MAX_MONITORED_SESSIONS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePromptCacheValue(
  value: unknown,
  seen = new WeakSet<object>()
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizePromptCacheValue(item, seen));
  }

  if (!isRecord(value)) {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  const normalized = Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, nestedValue]) =>
          key !== 'cache_control' && nestedValue !== undefined
      )
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, nestedValue]) => [
        key,
        normalizePromptCacheValue(nestedValue, seen),
      ])
  );
  seen.delete(value);
  return normalized;
}

function stringifyPromptCacheSegment(value: unknown): string {
  try {
    return JSON.stringify(normalizePromptCacheValue(value));
  } catch (error) {
    logWarn(
      '[Prompt-Caching] Failed to serialize prompt segment for prefix check',
      { cause: error }
    );
    return '{}';
  }
}

function createPromptCacheSegmentSnapshot(
  segment: PromptCacheSegmentInput
): PromptCacheSegmentSnapshot {
  if (typeof segment.value === 'string') {
    return {
      label: segment.label,
      textValue: segment.value,
    };
  }

  return {
    label: segment.label,
    serializedValue: stringifyPromptCacheSegment(segment.value),
  };
}

function getSegmentObjectWithoutKey(
  value: Record<string, unknown>,
  omittedKey: string
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== omittedKey)
  );
}

function getSingleTextBlockValue(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 1) {
    return undefined;
  }

  const block = value[0];
  if (!isRecord(block) || typeof block.text !== 'string') {
    return undefined;
  }
  if (
    typeof block.type === 'string' &&
    !['input_text', 'output_text', 'text'].includes(block.type)
  ) {
    return undefined;
  }

  const promptKeys = Object.keys(block).filter(
    (key) => key !== 'cache_control'
  );
  return promptKeys.every((key) => key === 'type' || key === 'text')
    ? block.text
    : undefined;
}

function getPromptSegmentRoleSuffix(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('role' in value)) {
    return '';
  }

  const role = (value as { role?: unknown }).role;
  return typeof role === 'string' ? `.${role}` : '';
}

function promptStructuredSegments(
  labelPrefix: string,
  value: unknown
): PromptCacheSegmentInput[] {
  if (value == null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      promptStructuredSegments(
        `${labelPrefix}.${index}${getPromptSegmentRoleSuffix(item)}`,
        item
      )
    );
  }

  if (typeof value !== 'object') {
    return [{ label: labelPrefix, value }];
  }

  const record = value as Record<string, unknown>;
  const singleTextContent = getSingleTextBlockValue(record.content);
  if (singleTextContent !== undefined) {
    return [
      {
        label: `${labelPrefix}.metadata`,
        value: getSegmentObjectWithoutKey(record, 'content'),
      },
      { label: `${labelPrefix}.content`, value: singleTextContent },
    ];
  }

  const nestedPromptKey = Array.isArray(record.content)
    ? 'content'
    : Array.isArray(record.parts)
      ? 'parts'
      : undefined;

  if (nestedPromptKey) {
    return [
      {
        label: `${labelPrefix}.metadata`,
        value: getSegmentObjectWithoutKey(record, nestedPromptKey),
      },
      ...promptStructuredSegments(
        `${labelPrefix}.${nestedPromptKey}`,
        record[nestedPromptKey]
      ),
    ];
  }

  if (typeof record.content === 'string') {
    return [
      {
        label: `${labelPrefix}.metadata`,
        value: getSegmentObjectWithoutKey(record, 'content'),
      },
      { label: `${labelPrefix}.content`, value: record.content },
    ];
  }

  if (typeof record.text === 'string') {
    return [
      {
        label: `${labelPrefix}.metadata`,
        value: getSegmentObjectWithoutKey(record, 'text'),
      },
      { label: `${labelPrefix}.text`, value: record.text },
    ];
  }

  return [{ label: labelPrefix, value }];
}

function promptRequestSegments(
  labelPrefix: string,
  request: unknown
): PromptCacheSegmentInput[] {
  if (!isRecord(request)) {
    return promptStructuredSegments(labelPrefix, request);
  }

  return Object.entries(request)
    .filter(
      ([key, value]) => !NON_PROMPT_REQUEST_KEYS.has(key) && value != null
    )
    .sort(([leftKey], [rightKey]) => {
      const leftRank = APPENDABLE_PROMPT_REQUEST_KEYS.has(leftKey) ? 1 : 0;
      const rightRank = APPENDABLE_PROMPT_REQUEST_KEYS.has(rightKey) ? 1 : 0;
      return leftRank - rightRank || leftKey.localeCompare(rightKey);
    })
    .flatMap(([key, value]) =>
      promptStructuredSegments(`${labelPrefix}.${key}`, value)
    );
}

function promptSegmentMatchesPrefix(
  previousSegment: PromptCacheSegmentSnapshot,
  currentSegment: PromptCacheSegmentSnapshot,
  allowTextPrefix: boolean
): boolean {
  if (previousSegment.label !== currentSegment.label) {
    return false;
  }

  if (
    previousSegment.textValue !== undefined &&
    currentSegment.textValue !== undefined
  ) {
    return allowTextPrefix
      ? currentSegment.textValue.startsWith(previousSegment.textValue)
      : currentSegment.textValue === previousSegment.textValue;
  }

  return previousSegment.serializedValue === currentSegment.serializedValue;
}

function isPromptCacheRequestPrefix(
  previousSegments: PromptCacheSegmentSnapshot[],
  currentSegments: PromptCacheSegmentSnapshot[]
): PromptCachePrefixResult {
  for (let index = 0; index < previousSegments.length; index++) {
    const previousSegment = previousSegments[index];
    const currentSegment = currentSegments[index];
    if (
      !currentSegment ||
      !promptSegmentMatchesPrefix(
        previousSegment,
        currentSegment,
        index === previousSegments.length - 1
      )
    ) {
      return { isPrefix: false, firstMismatchIndex: index };
    }
  }

  return { isPrefix: true };
}

export function createPromptCacheBreakMonitor() {
  const lastRequestsBySession = new Map<string, PromptCacheRequestSnapshot>();

  return {
    resetSession(sessionId: string): void {
      lastRequestsBySession.delete(sessionId);
    },

    recordOutgoingRequest({
      sessionId,
      assistantMessageId,
      providerPath,
      modelId,
      apiProvider,
      request,
    }: PromptCacheBreakMonitorInput): void {
      const previousSnapshot = lastRequestsBySession.get(sessionId);
      const destinationChanged = previousSnapshot
        ? previousSnapshot.providerPath !== providerPath ||
          previousSnapshot.modelId !== modelId ||
          previousSnapshot.apiProvider !== apiProvider
        : false;

      const currentSnapshot: PromptCacheRequestSnapshot = {
        assistantMessageId,
        providerPath,
        modelId,
        apiProvider,
        segments: promptRequestSegments(providerPath, request).map(
          createPromptCacheSegmentSnapshot
        ),
      };

      if (previousSnapshot && !destinationChanged) {
        const prefixResult = isPromptCacheRequestPrefix(
          previousSnapshot.segments,
          currentSnapshot.segments
        );

        if (!prefixResult.isPrefix) {
          const firstMismatchIndex = prefixResult.firstMismatchIndex ?? 0;
          const value = {
            previousAssistantMessageId: previousSnapshot.assistantMessageId,
            previousModelId: previousSnapshot.modelId,
            providerPath,
            previousProviderPath: previousSnapshot.providerPath,
            previousApiProvider: previousSnapshot.apiProvider,
            reason: 'prefix_mismatch',
            previousSegmentCount: previousSnapshot.segments.length,
            currentSegmentCount: currentSnapshot.segments.length,
            firstMismatchIndex,
            previousSegmentLabel:
              previousSnapshot.segments[firstMismatchIndex]?.label,
            currentSegmentLabel:
              currentSnapshot.segments[firstMismatchIndex]?.label,
          };
          logWarn(
            '[Prompt-Caching] Outgoing request is not append-only; prompt cache may be broken',
            {
              sessionId,
              assistantMessageId,
              modelId,
              apiProvider,
              eventName: 'prompt_cache_miss_detected',
              eventType: 'llm_prompt_cache',
              value,
            }
          );
        }
      }

      lastRequestsBySession.delete(sessionId);
      lastRequestsBySession.set(sessionId, currentSnapshot);
      if (lastRequestsBySession.size > MAX_MONITORED_SESSIONS) {
        const oldestSessionId = lastRequestsBySession.keys().next().value;
        if (oldestSessionId !== undefined) {
          lastRequestsBySession.delete(oldestSessionId);
        }
      }
    },
  };
}
