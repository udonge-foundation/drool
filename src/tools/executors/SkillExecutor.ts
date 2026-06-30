import { ToolExecutionErrorType } from '@industry/common/session';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import { Metrics } from '@industry/logging';
import { ToolAbortError } from '@industry/logging/errors';
import { Metric } from '@industry/logging/metrics/enums';

import { getI18n } from '@/i18n';
import { getAllSkills } from '@/skills/builtin';
import {
  injectCustomReviewGuidelines,
  injectCustomSecurityReviewGuidelines,
} from '@/skills/review/customGuidelines';
import { CustomerMetrics } from '@/telemetry/customer/CustomerMetrics';
import { AttributeName, MetricName } from '@/telemetry/customer/enums';
import { SkillActivationSource } from '@/telemetry/enums';
import { trackSkillUsage } from '@/telemetry/trackSkillUsage';
import type {
  CliClientToolDependencies,
  CliClientSpecificToolDependencies,
} from '@/tools/types';
import { sanitizeSkillName } from '@/utils/skills/paths';

import type {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';

interface SkillToolParams {
  skill: string;
}

/**
 * Executor for the Skill tool
 */
export class SkillExecutor
  implements ClientToolExecutor<CliClientSpecificToolDependencies, string>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: SkillToolParams
  ): AsyncGenerator<DraftToolFeedback<string>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const { skill: skillName } = parameters;

    if (!skillName) {
      yield this.error(getI18n().t('common:skillExecutor.skillNameRequired'));
      return;
    }

    // Load skills from SettingsManager and merge with built-in skills
    const allSkills = await getAllSkills();
    const sanitized = sanitizeSkillName(skillName);
    const skill = allSkills.find(
      (s) => sanitizeSkillName(s.metadata.name) === sanitized
    );

    trackSkillUsage({
      skillName: sanitized,
      location: skill?.location,
      activationSource: SkillActivationSource.Tool,
    });

    Metrics.addToCounter(Metric.SKILL_INVOKED_COUNT, 1, {
      skillName: sanitized,
      location: skill?.location ?? 'unknown',
    });

    if (!skill) {
      Metrics.addToCounter(Metric.SKILL_INVOCATION_ERROR_COUNT, 1, {
        skillName: sanitized,
        errorType: 'not_found',
      });
      yield this.error(
        getI18n().t('common:skillExecutor.skillNotFound', { skillName })
      );
      return;
    }

    if (!skill.validationResult.valid) {
      Metrics.addToCounter(Metric.SKILL_INVOCATION_ERROR_COUNT, 1, {
        skillName: sanitized,
        errorType: 'invalid',
      });
      yield this.error(
        getI18n().t('common:skillExecutor.skillInvalid', {
          skillName,
          errors: skill.validationResult.errors.join(', '),
        })
      );
      return;
    }

    if (skill.metadata.enabled === false) {
      Metrics.addToCounter(Metric.SKILL_INVOCATION_ERROR_COUNT, 1, {
        skillName: sanitized,
        errorType: 'disabled',
      });
      yield this.error(
        getI18n().t('common:skillExecutor.skillDisabled', { skillName })
      );
      return;
    }

    Metrics.addToCounter(Metric.SKILL_INVOCATION_SUCCESS_COUNT, 1, {
      skillName: sanitized,
      location: skill.location,
    });

    // Customer telemetry for skill invocations
    CustomerMetrics.addToCounter(MetricName.SKILL_INVOCATIONS, 1, {
      [AttributeName.SKILL_NAME]: sanitized,
    });

    // For the review / security-review skills, splice any repo-specific
    // *-guidelines directive into the payload so the model knows to invoke the
    // guidelines skill and treat its rules as taking priority (and does not
    // error on repos that don't define one).
    const systemPrompt =
      sanitized === 'review'
        ? injectCustomReviewGuidelines(skill.systemPrompt, allSkills)
        : sanitized === 'security-review' ||
            sanitized === 'deep-security-review'
          ? injectCustomSecurityReviewGuidelines(skill.systemPrompt, allSkills)
          : skill.systemPrompt;

    // Return full skill content so model sees it immediately this turn
    yield {
      type: DraftToolFeedbackType.Result,
      isError: false,
      value: `Skill "${skill.metadata.name}" is now active.

<skill name="${skill.metadata.name}" filePath="${skill.filePath}">
${systemPrompt}
</skill>`,
    };
  }

  private error(llmError: string): DraftToolFeedback<string> {
    return {
      type: DraftToolFeedbackType.Result,
      isError: true,
      errorType: ToolExecutionErrorType.InvalidParameterLLMError,
      llmError,
      userError: getI18n().t('common:skillExecutor.failedToLoadSkill'),
    };
  }
}
