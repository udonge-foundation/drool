import { ModelID, ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';

import {
  MISSION_ORCHESTRATOR_MIN_REASONING_EFFORTS,
  MISSION_ORCHESTRATOR_RECOMMENDED_MODELS,
} from './constants';
import { MODEL_REGISTRY } from './model-registry';

const REASONING_EFFORT_LABELS: Record<string, string> = {
  [ReasoningEffort.High]: 'High',
  [ReasoningEffort.ExtraHigh]: 'Extra High',
};

function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

function buildMissionWarning(): string {
  const models = formatList(
    MISSION_ORCHESTRATOR_RECOMMENDED_MODELS.map(
      (id) => MODEL_REGISTRY[id as ModelID]?.shortName ?? id
    )
  );
  const efforts = formatList(
    MISSION_ORCHESTRATOR_MIN_REASONING_EFFORTS.map(
      (e) => REASONING_EFFORT_LABELS[e] ?? e
    )
  );
  return `${models} with ${efforts} thinking are recommended for mission orchestration. Other models may not perform as well.`;
}

/** Warning message when user changes orchestrator model from recommended */
export const MISSION_ORCHESTRATOR_MODEL_WARNING = buildMissionWarning();
