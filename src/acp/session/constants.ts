import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import { AutonomyMode } from '@industry/drool-sdk-ext/protocol/shared';

export const CONFIG_OPTION_REASONING_EFFORT = 'reasoning_effort';
export const CONFIG_OPTION_AUTONOMY_LEVEL = 'autonomy_level';
export const CONFIG_OPTION_MODEL = 'model';

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  [ReasoningEffort.None]: 'None',
  [ReasoningEffort.Dynamic]: 'Dynamic',
  [ReasoningEffort.Off]: 'Off',
  [ReasoningEffort.Minimal]: 'Minimal',
  [ReasoningEffort.Low]: 'Low',
  [ReasoningEffort.Medium]: 'Medium',
  [ReasoningEffort.High]: 'High',
  [ReasoningEffort.ExtraHigh]: 'Extra High',
  [ReasoningEffort.Max]: 'Maximum',
};

export const AUTONOMY_LEVEL_LABELS: Record<AutonomyMode, string> = {
  [AutonomyMode.Normal]: 'Auto (Off)',
  [AutonomyMode.Spec]: 'Spec',
  [AutonomyMode.AutoLow]: 'Auto (Low)',
  [AutonomyMode.AutoMedium]: 'Auto (Medium)',
  [AutonomyMode.AutoHigh]: 'Auto (High)',
};

export const AUTONOMY_MODE_ORDER: AutonomyMode[] = [
  AutonomyMode.Normal,
  AutonomyMode.Spec,
  AutonomyMode.AutoLow,
  AutonomyMode.AutoMedium,
  AutonomyMode.AutoHigh,
];

export const DEFAULT_REASONING_EFFORTS: ReasoningEffort[] = [
  ReasoningEffort.Off,
  ReasoningEffort.Low,
  ReasoningEffort.Medium,
  ReasoningEffort.High,
];
