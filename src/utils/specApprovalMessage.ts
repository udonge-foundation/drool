import { TOOL_RESULT_PENDING_MARKER } from '@industry/common/sessionV2';

import type { ExitSpecModeResult } from '@/agent/types';
import type { getI18n } from '@/i18n';

type TFunction = ReturnType<typeof getI18n>['t'];

// Strict parse of the JSON-stringified ExitSpecMode tool result. Anything
// that isn't a JSON object with a boolean `approved` returns null so the
// caller can safely skip emitting an approval notification.
export function parseExitSpecModeResult(
  raw: string | undefined
): ExitSpecModeResult | null {
  if (!raw || raw === TOOL_RESULT_PENDING_MARKER) {
    return null;
  }
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('{')) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.approved !== 'boolean'
    ) {
      return null;
    }
    return parsed as ExitSpecModeResult;
  } catch {
    return null;
  }
}

function lastNonEmptyLine(message: string): string {
  const lines = message.split('\n').map((line) => line.trim());
  return [...lines].reverse().find((line) => line.length > 0) ?? message.trim();
}

function parseUserCommentFromMessage(message: string): string | undefined {
  const match = message.match(/(?:^|\n)\s*User comment:\s*([\s\S]+?)\s*$/);
  const parsedComment = match?.[1]?.trim();
  return parsedComment || undefined;
}

export function getSpecApprovalComment(
  result: ExitSpecModeResult
): string | undefined {
  if (typeof result.userComment === 'string' && result.userComment.trim()) {
    return result.userComment.trim();
  }

  if (
    typeof result.handoff?.userComment === 'string' &&
    result.handoff.userComment.trim()
  ) {
    return result.handoff.userComment.trim();
  }

  if (typeof result.message !== 'string' || result.message.trim() === '') {
    return undefined;
  }

  return parseUserCommentFromMessage(result.message);
}

// Format the user-visible approval line from a parsed result. Returns null
// for rejections. Keep completed approvals to the saved-path line; the full
// approval text still lives in the legacy ToolExecutor dispatch path.
export function buildSpecApprovalMessage(
  result: ExitSpecModeResult,
  t: TFunction
): string | null {
  if (typeof result.filePath !== 'string' || result.filePath.trim() === '') {
    return null;
  }

  if (result.isEdited) {
    if (result.editStatus === 'complete') {
      return lastNonEmptyLine(
        t('common:specModeConfirmation.specEdited', {
          filePath: result.filePath,
        })
      );
    }
    return t('common:specModeConfirmation.specBeingEdited', {
      filePath: result.filePath,
    });
  }

  if (!result.approved) {
    return null;
  }

  const isNewSession = result.handoff?.isNewSession === true;
  const key = isNewSession
    ? 'common:specModeConfirmation.specApprovedNewSession'
    : 'common:specModeConfirmation.specApproved';

  return lastNonEmptyLine(
    t(key, {
      filePath: result.filePath,
    })
  );
}
