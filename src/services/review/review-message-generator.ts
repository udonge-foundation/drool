import {
  SYSTEM_NOTIFICATION_START,
  SYSTEM_NOTIFICATION_END,
} from '@industry/drool-sdk-ext/protocol/drool';
import { MetaError } from '@industry/logging/errors';

import type { CommitInfo, ReviewPreset } from '@/components/review/types';
import { getI18n } from '@/i18n';
import type { ReviewMessageComponents } from '@/services/review/types';
import { getAllSkills } from '@/skills/builtin';
import { injectCustomReviewGuidelines } from '@/skills/review/customGuidelines';
import { sanitizeSkillName } from '@/utils/skills/paths';

const SUGGESTION_BEGIN = '<!-- BEGIN_SUGGESTION_RULES -->';
const SUGGESTION_END = '<!-- END_SUGGESTION_RULES -->';

/**
 * Review message configuration based on preset type
 */
interface ReviewMessageConfig {
  baseBranch?: string;
  currentBranch?: string;
  commit?: CommitInfo;
  customInstructions?: string;
  preset: ReviewPreset;
  includeSuggestions?: boolean;
}

/**
 * Build user prompt for the specific review type
 * This matches Codex's user-facing prompts
 */
function buildUserPrompt(config: ReviewMessageConfig): string {
  const { preset, baseBranch, commit, customInstructions } = config;

  switch (preset.id) {
    case 'base-branch':
      if (!baseBranch) {
        throw new Error('Base branch is required for branch review');
      }
      return (
        `Review the code changes against the base branch '${baseBranch}'. ` +
        `Start by finding the merge diff between the current branch and ${baseBranch}'s upstream ` +
        `e.g. (\`git merge-base HEAD "$(git rev-parse --abbrev-ref "${baseBranch}@{upstream}")"\`), ` +
        `then run \`git diff\` against that SHA to see what changes we would merge into the ${baseBranch} branch. ` +
        `Provide prioritized, actionable findings.`
      );

    case 'commit':
      if (!commit) {
        throw new Error('Commit is required for commit review');
      }
      return (
        `Review the code changes introduced by commit ${commit.hash} ("${commit.message}"). ` +
        `Provide prioritized, actionable findings.`
      );

    case 'uncommitted':
      return 'Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.';

    case 'custom':
      if (!customInstructions) {
        throw new Error('Custom instructions are required for custom review');
      }
      // For custom reviews, the user's input IS the prompt
      return customInstructions;

    default:
      throw new MetaError('Unknown preset type', { value: preset.id });
  }
}

function stripSuggestionRules(content: string): string {
  const beginIdx = content.indexOf(SUGGESTION_BEGIN);
  const endIdx = content.indexOf(SUGGESTION_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    return content;
  }
  return (
    content.slice(0, beginIdx) + content.slice(endIdx + SUGGESTION_END.length)
  ).trim();
}

async function loadReviewSkillContent(
  includeSuggestions: boolean
): Promise<string> {
  const allSkills = await getAllSkills();
  const skill = allSkills.find(
    (s) => sanitizeSkillName(s.metadata.name) === 'review'
  );
  if (!skill?.systemPrompt) {
    throw new Error(
      'Review skill not found. Ensure the core plugin is installed.'
    );
  }
  const prompt = injectCustomReviewGuidelines(skill.systemPrompt, allSkills);
  return includeSuggestions ? prompt : stripSuggestionRules(prompt);
}

/**
 * Generate the opening message for a code review based on the review type
 * This returns both the user-visible opening line and the full message with hidden instructions
 */
export async function generateReviewMessage(
  config: ReviewMessageConfig
): Promise<ReviewMessageComponents> {
  const { preset, currentBranch, baseBranch, commit, customInstructions } =
    config;

  // Generate the opening line based on review type (user-facing hint)
  const t = getI18n().t;
  let openingLine = '';

  switch (preset.id) {
    case 'base-branch': {
      if (!baseBranch) {
        throw new Error('Base branch is required for branch review');
      }
      if (currentBranch) {
        openingLine = t('common:review.openingLineBranchWithCurrent', {
          currentBranch,
          baseBranch,
        });
      } else {
        openingLine = t('common:review.openingLineBranch', { baseBranch });
      }
      break;
    }

    case 'commit': {
      if (!commit) {
        throw new Error('Commit is required for commit review');
      }
      // Truncate long commit messages for display
      const truncatedMessage =
        commit.message.length > 50
          ? `${commit.message.substring(0, 50)}...`
          : commit.message;
      openingLine = t('common:review.openingLineCommit', {
        shortHash: commit.shortHash,
        message: truncatedMessage,
      });
      break;
    }

    case 'uncommitted':
      openingLine = t('common:review.openingLineUncommitted');
      break;

    case 'custom': {
      if (!customInstructions) {
        throw new Error('Custom instructions are required for custom review');
      }
      // Truncate long custom instructions for display
      const truncated =
        customInstructions.length > 50
          ? `${customInstructions.substring(0, 50)}...`
          : customInstructions;
      openingLine = t('common:review.openingLineCustom', {
        instructions: truncated,
      });
      break;
    }

    default:
      throw new MetaError('Unknown preset type', { value: preset.id });
  }

  // Build the complete message with separated base instructions and user prompt
  const userPrompt = buildUserPrompt(config);
  const includeSuggestions = config.includeSuggestions === true;
  const skillContent = await loadReviewSkillContent(includeSuggestions);

  const fullMessage = `${SYSTEM_NOTIFICATION_START}\n${skillContent}\n\n---\n\n${userPrompt}\n${SYSTEM_NOTIFICATION_END}`;

  // Return both the opening line (for user display) and the full message (for AI)
  return {
    openingLine,
    fullMessage,
  };
}
