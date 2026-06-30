import { MetaError } from '@industry/logging/errors';

import { clampScore } from './clampScore';

/**
 * Typed score payload extracted from the classifier's raw JSON.
 * Kept local to the parser (not exported to the broader router
 * barrel) since it's an implementation detail of the parse step.
 */
interface TaskClassifierScorePayload {
  scores: Record<string, number>;
  classification?: string;
  reasoning?: string;
}

/**
 * Parse the JSON emitted by the model into a typed payload. Tolerates
 * common failure modes that can slip past the structured-output API:
 * leading/trailing whitespace, a single ```json code fence, or stray
 * prose wrapping a single balanced object.
 *
 * Lives in its own file so the test in
 * `parseTaskClassifierResponse.test.ts` can exercise it directly and
 * the classifier has a genuine cross-file production consumer
 * (otherwise knip flags the export as unused since its only same-file
 * caller would be private).
 */
export function parseTaskClassifierResponse(
  raw: string
): TaskClassifierScorePayload {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\n([\s\S]*?)\n```/);
  const hasJsonFence = fenceMatch !== null;
  const jsonSource = fenceMatch ? fenceMatch[1]! : trimmed;

  let jsonString = jsonSource.trim();
  if (!jsonString.startsWith('{')) {
    const start = jsonString.indexOf('{');
    const end = jsonString.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
      throw new MetaError('Task classifier returned non-JSON output', {
        length: trimmed.length,
        hasJsonFence,
        stage: 'extract-object',
      });
    }
    jsonString = jsonString.slice(start, end + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    throw new MetaError('Task classifier emitted invalid JSON', {
      length: jsonString.length,
      hasJsonFence,
      stage: 'parse-json',
      errorMessage: err instanceof Error ? err.message : 'unknown',
    });
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('scores' in parsed) ||
    parsed.scores === null ||
    typeof parsed.scores !== 'object'
  ) {
    throw new MetaError('Task classifier JSON missing `scores` object', {
      length: jsonString.length,
      hasJsonFence,
      stage: 'validate-scores',
    });
  }

  const scores: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed.scores)) {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) continue;
    scores[key] = clampScore(num);
  }

  const classification =
    'classification' in parsed && typeof parsed.classification === 'string'
      ? parsed.classification
      : undefined;
  const reasoning =
    'reasoning' in parsed && typeof parsed.reasoning === 'string'
      ? parsed.reasoning
      : undefined;

  return { scores, classification, reasoning };
}
