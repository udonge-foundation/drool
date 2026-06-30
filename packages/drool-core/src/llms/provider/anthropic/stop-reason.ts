import { LanguageModelFinishReason } from '../../../streaming/enums';

export function mapAnthropicFinishReason(
  finishReason: string | null | undefined
): LanguageModelFinishReason {
  switch (finishReason) {
    case 'end_turn':
    case 'stop_sequence':
      return LanguageModelFinishReason.Stop;
    case 'pause_turn':
      return LanguageModelFinishReason.PauseTurn;
    case 'model_context_window_exceeded':
      return LanguageModelFinishReason.ModelContextWindowExceeded;
    case 'tool_use':
      return LanguageModelFinishReason.ToolCalls;
    case 'max_tokens':
      return LanguageModelFinishReason.Length;
    case 'refusal':
      return LanguageModelFinishReason.ContentFilter;
    default:
      return LanguageModelFinishReason.Unknown;
  }
}
