import { validateStructuredOutput } from '@industry/drool-core/llms/client/structured-output';
import {
  StructuredOutputErrorCode,
  type OutputFormat,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  type IndustryDroolMessage,
  MessageContentBlockType,
  MessageVisibility,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

import { MessageRole } from '@/hooks/enums';
import { generateUUID } from '@/utils/uuid';

const STRUCTURED_OUTPUT_CANDIDATE_MAX_CHARS = 4000;

function buildLlmOnlySystemMessage(text: string): IndustryDroolMessage {
  const now = Date.now();
  return {
    id: generateUUID(),
    role: MessageRole.System,
    content: [{ type: MessageContentBlockType.Text, text }],
    visibility: MessageVisibility.LLMOnly,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildStructuredOutputInstruction(
  outputFormat: OutputFormat
): string {
  return [
    'The user requested a structured final response.',
    'You may use available tools as needed during the task.',
    'When you are ready to answer, your final assistant message must be a JSON object only, with no Markdown or explanatory text, matching this JSON Schema:',
    JSON.stringify(outputFormat.schema),
  ].join('\n');
}

function truncateStructuredOutputCandidate(candidate: string): string {
  return candidate.length > STRUCTURED_OUTPUT_CANDIDATE_MAX_CHARS
    ? `${candidate.slice(0, STRUCTURED_OUTPUT_CANDIDATE_MAX_CHARS)}…`
    : candidate;
}

export function validateStructuredOutputText(
  candidate: string,
  outputFormat: OutputFormat
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return {
      ok: false as const,
      code: StructuredOutputErrorCode.InvalidStructuredOutput,
      message:
        error instanceof Error
          ? `Final response must be valid JSON: ${error.message}`
          : 'Final response must be valid JSON.',
    };
  }

  return validateStructuredOutput(parsed, outputFormat);
}

export function buildStructuredOutputRetryMessage(params: {
  candidate: string;
  errorMessage: string;
  outputFormat: OutputFormat;
}): IndustryDroolMessage {
  return buildLlmOnlySystemMessage(
    [
      'Your previous final response did not satisfy the requested structured output contract.',
      `Validation error: ${params.errorMessage}`,
      'Previous final response:',
      truncateStructuredOutputCandidate(params.candidate),
      'Retry now. You may still use tools if necessary, but your final assistant message must be a JSON object only matching this JSON Schema:',
      JSON.stringify(params.outputFormat.schema),
    ].join('\n')
  );
}
