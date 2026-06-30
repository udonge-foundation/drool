import { ExecSummarySubtype, ExecSummaryType } from '@/exec/enums';
import type { ExecRunResult, ExecSummary, ExecUsage } from '@/exec/types';

export function buildExecSummaryFromResult(
  result: ExecRunResult,
  durationMs: number,
  usage: ExecUsage
): ExecSummary {
  return {
    type: ExecSummaryType.Result,
    subtype: result.isError
      ? ExecSummarySubtype.Failure
      : ExecSummarySubtype.Success,
    is_error: result.isError,
    duration_ms: durationMs,
    num_turns: result.numTurns,
    result: result.finalText,
    session_id: result.sessionId,
    usage,
  };
}

export function buildExecFailureSummary(
  sessionId: string,
  durationMs: number,
  usage: ExecUsage,
  numTurns = 0,
  resultText = ''
): ExecSummary {
  return {
    type: ExecSummaryType.Result,
    subtype: ExecSummarySubtype.Failure,
    is_error: true,
    duration_ms: durationMs,
    num_turns: numTurns,
    result: resultText,
    session_id: sessionId,
    usage,
  };
}
