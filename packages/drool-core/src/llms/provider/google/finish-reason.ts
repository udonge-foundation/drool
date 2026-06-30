import { FinishReason } from '@google/genai';

import { LanguageModelFinishReason } from '../../../streaming/enums';

/**
 * Maps Google Gemini finish reasons to our internal LanguageModelFinishReason enum
 *
 * @param finishReason The finish reason returned by Google Gemini API
 * @param hasToolCalls Whether the response contains tool calls
 * @returns The mapped LanguageModelFinishReason
 */
export function mapGeminiFinishReason(
  finishReason: FinishReason | null | undefined,
  hasToolCalls = false
): LanguageModelFinishReason {
  if (hasToolCalls) {
    return LanguageModelFinishReason.ToolCalls;
  }
  switch (finishReason) {
    // https://cloud.google.com/python/docs/reference/aiplatform/latest/google.cloud.aiplatform_v1.types.Candidate.FinishReason
    case 'STOP':
      return LanguageModelFinishReason.Stop;
    case 'MAX_TOKENS':
      return LanguageModelFinishReason.Length;
    case 'BLOCKLIST':
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return LanguageModelFinishReason.ContentFilter;
    case 'MALFORMED_FUNCTION_CALL':
      return LanguageModelFinishReason.Error;
    case 'FINISH_REASON_UNSPECIFIED':
    case 'OTHER':
    default:
      return LanguageModelFinishReason.Unknown;
  }
}
