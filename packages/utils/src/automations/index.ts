export {
  resolveCIWorkflowMode,
  resolveCIWorkflowModeById,
} from './resolveCIWorkflowMode';
export { toAutomationTemplateId } from './toAutomationTemplateId';
export { isLocalAutomation } from './locality';
export { decideVisualPolicy } from './brand-visual-policy';
export { VisualPolicyBranch } from './enums';
export type { VisualPolicyDecision } from './types';
export { buildAutomationSlug } from './slug';
export { buildAutomationScaffoldLocationReminder } from './working-directory';
export {
  buildAutomationRunFailureLabels,
  buildAutomationRunLabels,
  getAutomationRunFailureReason,
  isAutomationRunFailureReason,
  isAutomationRunTriggerSource,
} from './metrics';
export type {
  AutomationRunFailureReason,
  AutomationRunTriggerSource,
} from './types';
