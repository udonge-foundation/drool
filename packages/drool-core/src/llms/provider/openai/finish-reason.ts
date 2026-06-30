import { LanguageModelFinishReason } from '../../../streaming/enums';

export function mapOpenaiFinishReason(
  reason: string | null | undefined
): LanguageModelFinishReason {
  switch (reason) {
    // https://github.com/openai/openai-python/blob/main/src/openai/types/chat/chat_completion.py#L23
    case 'stop':
      return LanguageModelFinishReason.Stop;
    case 'length':
    case 'max_output_tokens':
      return LanguageModelFinishReason.Length;
    case 'content_filter':
      return LanguageModelFinishReason.ContentFilter;
    case 'function_call':
    case 'tool_calls':
      return LanguageModelFinishReason.ToolCalls;
    default:
      return LanguageModelFinishReason.Unknown;
  }
}
