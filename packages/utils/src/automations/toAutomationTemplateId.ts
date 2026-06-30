import { AutomationTemplateId } from '@industry/common/automations';

/**
 * Coerce an arbitrary template / CI-mode identifier into a canonical
 * `AutomationTemplateId`. The security variant of code review
 * (`code-review-security`) collapses into `code-review` since both belong to
 * the same template and SDLC stage. Unknown / custom values return `undefined`
 * (treated as a non-templated automation).
 */
export function toAutomationTemplateId(
  value: string | null | undefined
): AutomationTemplateId | undefined {
  switch (value) {
    case AutomationTemplateId.CodeReview:
    case 'code-review-security':
      return AutomationTemplateId.CodeReview;
    case AutomationTemplateId.Qa:
      return AutomationTemplateId.Qa;
    case AutomationTemplateId.Wiki:
      return AutomationTemplateId.Wiki;
    case AutomationTemplateId.SecurityAudit:
      return AutomationTemplateId.SecurityAudit;
    case AutomationTemplateId.Triage:
      return AutomationTemplateId.Triage;
    case AutomationTemplateId.IncidentResponse:
      return AutomationTemplateId.IncidentResponse;
    default:
      return undefined;
  }
}
