import { HookExecutionStatus } from '@/hooks/enums';
import type { HistoryMessage } from '@/hooks/types';
import { isDroolGitAiCheckpointHookCommand } from '@/utils/gitAiHookCommand';

type HookMessageFields = Pick<
  HistoryMessage,
  'hookCommands' | 'hookEventName' | 'hookStatus' | 'hookResults'
>;

export function getGitAiCheckpointHookLabel(): string {
  return 'Git AI checkpoint';
}

/**
 * Whether a hook batch should render in its collapsed form in the Ctrl+O
 * detailed transcript. The Git AI checkpoint hook is hidden entirely from chat
 * (see {@link shouldHideHookMessageFromChatView}); in the transcript it is shown
 * but collapsed to a single header line rather than its full output.
 */
export function shouldCollapseHookInTranscript(
  commands: ReadonlyArray<{ command: string }>
): boolean {
  return (
    commands.length > 0 &&
    commands.every((cmd) => isDroolGitAiCheckpointHookCommand(cmd.command))
  );
}

function shouldHideHookCommandFromChatView(
  command: string,
  status: HookExecutionStatus | undefined,
  result: { exitCode: number; suppressOutput?: boolean } | undefined
): boolean {
  if (result && result.suppressOutput && result.exitCode === 0) {
    return true;
  }
  if (!isDroolGitAiCheckpointHookCommand(command)) {
    return false;
  }
  if (result) {
    return result.exitCode === 0;
  }
  // No result yet: hide while pending/executing, but keep a hook that errored
  // before producing a result so the failure stays visible in chat.
  return status !== HookExecutionStatus.Error;
}

/**
 * "Hide from chat, keep in transcript" capability.
 *
 * Hooks are hidden from the live chat view (but still rendered in the Ctrl+O
 * detailed transcript) when either:
 *   - The hook command is a built-in noisy hook (e.g. the Git AI checkpoint
 *     hook, which runs after every file edit).
 *   - The hook returned `suppressOutput: true` in its JSON output and exited 0.
 *     This is the user-facing opt-in for silencing successful hook runs in the
 *     TUI (matches the Claude Code `suppressOutput` semantics).
 *
 * A message is hidden only when every command in its batch is hideable, so a
 * failed hook or any non-suppressed user hook keeps the whole row visible.
 */
export function shouldHideHookMessageFromChatView(
  message: HookMessageFields
): boolean {
  const commands = message.hookCommands ?? [];
  return (
    commands.length > 0 &&
    commands.every((cmd, index) =>
      shouldHideHookCommandFromChatView(
        cmd.command,
        message.hookStatus,
        message.hookResults?.[index]
      )
    )
  );
}

/**
 * Filter individually-hideable hooks out of a partially-visible batch for the
 * live chat view. When some hooks in a batch are hideable (e.g. successful
 * suppressOutput hooks) but others are not (e.g. a failing sibling), the batch
 * itself stays visible per {@link shouldHideHookMessageFromChatView}. The
 * hideable hooks should still drop out of the rendered batch so the user only
 * sees the hooks that actually need their attention. The detailed transcript
 * (Ctrl+O) keeps everything.
 */
export function getVisibleHookIndicesForChatView(
  message: HookMessageFields
): number[] {
  const commands = message.hookCommands ?? [];
  const visible: number[] = [];
  for (let index = 0; index < commands.length; index += 1) {
    const cmd = commands[index]!;
    if (
      !shouldHideHookCommandFromChatView(
        cmd.command,
        message.hookStatus,
        message.hookResults?.[index]
      )
    ) {
      visible.push(index);
    }
  }
  return visible;
}
