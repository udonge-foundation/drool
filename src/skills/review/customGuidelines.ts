import {
  CUSTOM_REVIEW_GUIDELINES_DIRECTIVE,
  CUSTOM_SECURITY_REVIEW_GUIDELINES_DIRECTIVE,
} from '@/skills/review/constants';
import { sanitizeSkillName } from '@/utils/skills/paths';

import type { Skill } from '@industry/common/settings';

/**
 * Append `directive` to `systemPrompt` only when a skill named
 * `guidelinesSkillName` is present in `allSkills`. The directive tells the
 * orchestrator (and, transitively, each subagent) to invoke the guidelines
 * skill itself — which is what loads the actual repo-specific guidance.
 *
 * When the guidelines skill is absent, invalid, or disabled, the prompt is
 * returned unchanged so the model is never told to invoke a skill it cannot
 * successfully load (which is what produced the `Skill "<name>" not found`
 * error before).
 */
function injectCustomGuidelines(
  systemPrompt: string,
  allSkills: readonly Skill[],
  guidelinesSkillName: string,
  directive: string
): string {
  const hasGuidelines = allSkills.some(
    (s) =>
      sanitizeSkillName(s.metadata.name) === guidelinesSkillName &&
      s.validationResult.valid &&
      s.metadata.enabled !== false
  );
  if (!hasGuidelines) {
    return systemPrompt;
  }

  const trimmed = systemPrompt.replace(/\s+$/, '');
  return `${trimmed}\n\n${directive}\n`;
}

/**
 * Splice the `review-guidelines` invocation directive into the `review` skill's
 * system prompt when that skill is present in the repo.
 */
export function injectCustomReviewGuidelines(
  reviewSystemPrompt: string,
  allSkills: readonly Skill[]
): string {
  return injectCustomGuidelines(
    reviewSystemPrompt,
    allSkills,
    'review-guidelines',
    CUSTOM_REVIEW_GUIDELINES_DIRECTIVE
  );
}

/**
 * Splice the `security-review-guidelines` invocation directive into the
 * `security-review` / `deep-security-review` skill prompts when that skill is
 * present in the repo. Its rules take priority over the shared security
 * methodology when they conflict.
 */
export function injectCustomSecurityReviewGuidelines(
  securityReviewSystemPrompt: string,
  allSkills: readonly Skill[]
): string {
  return injectCustomGuidelines(
    securityReviewSystemPrompt,
    allSkills,
    'security-review-guidelines',
    CUSTOM_SECURITY_REVIEW_GUIDELINES_DIRECTIVE
  );
}
