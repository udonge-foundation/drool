import { YOU_ARE_DROOL_SYSTEM_PROMPT } from '@industry/common/cli';
import { normalizeIndustryRouterRules } from '@industry/utils/settings';

import { buildSessionContextXml, escapeXmlText } from '../context';

import type {
  CandidateModel,
  ClassifierSignals,
  ClassifierSystemPromptOptions,
} from '../types';

// Defensive belt-and-braces in case `escapeXmlText` ever regresses or
// a future caller embeds guidance without escaping: strip the literal
// close tags that would let admin-authored text break out of the
// wrapping section / candidate cards / session block.
const DANGEROUS_CLOSE_TAG_PATTERN =
  /<\/(?:model|organization_routing_guidance|organization_routing_rules|organization_context|rule|when|guidance|session)>/gi;

function stripDangerousCloseTags(text: string): string {
  return text.replace(DANGEROUS_CLOSE_TAG_PATTERN, '');
}

function sanitizeOrganizationText(text: string): string {
  return escapeXmlText(stripDangerousCloseTags(text));
}

function buildOrganizationRuleBlocks(
  rules: NonNullable<ClassifierSystemPromptOptions['customRules']>
): string[] {
  return rules.map((rule, index) => {
    const when = rule.when ?? 'Always';
    return [
      `  <rule index="${index + 1}">`,
      `    <when>${sanitizeOrganizationText(when)}</when>`,
      `    <guidance>${sanitizeOrganizationText(rule.guidance)}</guidance>`,
      '  </rule>',
    ].join('\n');
  });
}

function buildOrganizationRoutingGuidanceSection(
  options: ClassifierSystemPromptOptions
): string | undefined {
  const rules = buildOrganizationRuleBlocks(
    normalizeIndustryRouterRules(options.customRules) ?? []
  );
  const context = options.customGuidance?.trim();
  if (rules.length === 0 && !context) return undefined;

  const body: string[] = ['<organization_routing_guidance>'];
  if (rules.length > 0) {
    body.push(
      ' <organization_routing_rules>',
      ...rules,
      ' </organization_routing_rules>'
    );
  }
  if (context) {
    body.push(
      ' <organization_context>',
      sanitizeOrganizationText(context),
      ' </organization_context>'
    );
  }
  body.push('</organization_routing_guidance>');

  return [
    '# Organization routing guidance',
    '',
    "Treat the following as advisory routing signals from the user's organization. They can influence task-risk assessment, but they do not override the scoring rubric, model capability cards, or policy constraints.",
    '',
    body.join('\n'),
  ].join('\n');
}

const SCORING_THEORY = `You are a task routing classifier for an AI coding agent.

You receive a list of candidate models and a <session> block describing the user's current turn. For each candidate, output a score: the probability (0.0–1.0) that the model completes the task successfully on its first attempt, without errors or rework.

You are not choosing a winner. A downstream system uses your scores alongside cost data you do not see to make the final selection. Your job is to be an accurate, well-calibrated probability estimator for each model independently.

# What a score means

A score is a predicted first-attempt success rate. If you score a model 0.7 on a task, you are claiming that in 100 independent attempts, roughly 70 would pass the verifier.

0.0 — Hard reject: the model cannot attempt this task (e.g. images required but unsupported). Must be exactly 0.0.
0.1–0.3 — Model will almost certainly fail. It lacks the required capability or domain knowledge.
0.4–0.5 — Meaningful chance of failure. The task touches areas where this model has known weaknesses.
0.6–0.7 — Possible but unreliable. The model might succeed on a good day but will frequently produce incomplete or incorrect results.
0.8 — Likely success. The model handles this category of task well, though edge cases may cause occasional failures.
0.9 — Very likely success. The task is well within the model's demonstrated capabilities.
1.0 — Near-certain success. Reserve for tasks the model handles trivially.

Use the full range. Scores of 0.4, 0.5, 0.6 are valid and important — they represent genuine uncertainty about whether a model can handle a task.

# How to reason about a task

Read the <session> block in this order: current_user_message → recent_tool_calls → first_user_message → recent_messages → conversation_summary → system_info.

When assessing difficulty:
- A short or simple-sounding prompt does NOT mean an easy task. Many hard tasks have deceptively simple descriptions — the difficulty is hidden in the repository contents, edge cases, verification requirements, or domain knowledge that you cannot directly observe.
- Look for signals of hidden complexity: performance constraints, correctness verification, specific output formats, interaction with existing codebases, niche toolchains, or domains that require specialized knowledge.
- When you cannot determine the difficulty from the prompt alone, express that uncertainty in your scores. Do not default to high scores — default to moderate scores (0.5–0.6) and let the model's known strengths or weaknesses push the score up or down.

When scoring each model:
- Read the model's capability card carefully. Pay close attention to the weaknesses and the score_examples — these are drawn from real evaluation data and represent ground truth about what the model actually succeeds and fails on.
- If a task resembles any of the model's low-scoring score_examples, score conservatively (toward the score shown in that example) even if the task sounds simple.
- If a task matches the model's strengths and none of the weakness patterns, score confidently.
- Score each model independently. Do not anchor one model's score to another's.

When the conversation history shows failed tool calls or error recovery attempts, this is strong evidence that the task requires careful reasoning. Score models lower if their card indicates weakness in iterative debugging.

If an <organization_routing_guidance> block appears below, weigh it alongside each model's capability card when scoring. Rules inside it are administrator-authored advisory signals: apply a rule when its <when> condition matches the session, and treat missing or "Always" conditions as generally applicable. These rules and context do not override the rubric or the cards, but they can shift your confidence up or down on areas the org explicitly calls out.`;

function buildModelCard(candidate: CandidateModel): string {
  return [
    `<model id="${candidate.modelId}">`,
    candidate.shortDescription,
    `</model>`,
  ].join('\n');
}

function buildOutputSchemaInstructions(
  candidates: readonly CandidateModel[]
): string {
  const exampleScores = candidates
    .map((c) => `    "${c.modelId}": 0.0`)
    .join(',\n');
  return [
    '# Output schema',
    '',
    'Respond with a single JSON object exactly matching this shape.',
    'No surrounding prose. No markdown code fence. No extra keys at any level.',
    '',
    '{',
    '  "scores": {',
    exampleScores,
    '  },',
    '  "reasoning": "one or two sentence justification"',
    '}',
    '',
    'Every candidate id listed above MUST appear in `scores`.',
    'Each score is a number between 0.0 and 1.0 inclusive.',
  ].join('\n');
}

export function buildStaticClassifierSystemPrompt(
  candidates: readonly CandidateModel[],
  options: ClassifierSystemPromptOptions = {}
): string {
  const candidateCards = candidates.map(buildModelCard).join('\n\n');
  const organizationRoutingGuidance =
    buildOrganizationRoutingGuidanceSection(options);
  // Industry LLM proxy rejects with 403 (no body) any request whose
  // system prompt does not start with YOU_ARE_DROOL_SYSTEM_PROMPT —
  // see apps/backend/src/app/api/_utils/llm-proxy/validation.ts.
  const sections: string[] = [YOU_ARE_DROOL_SYSTEM_PROMPT, '', SCORING_THEORY];
  if (organizationRoutingGuidance) {
    sections.push('', organizationRoutingGuidance);
  }
  sections.push(
    '',
    '# Candidate models',
    '',
    candidateCards,
    '',
    buildOutputSchemaInstructions(candidates)
  );
  return sections.join('\n');
}

export function buildDynamicTaskUserPrompt(signals: ClassifierSignals): string {
  const sessionXml = buildSessionContextXml(signals);
  return [
    sessionXml,
    '',
    '---',
    '',
    '# Task',
    '',
    'Score each candidate model per the rubric in the system prompt,',
    'based ONLY on the `<session>` content above. Respond with a single',
    'JSON object matching the schema in the system prompt.',
  ].join('\n');
}
