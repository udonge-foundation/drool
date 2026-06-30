import {
  SoundFocusMode,
  SubagentSoundBehavior,
  SubagentSoundMode,
} from '@industry/common/settings';

/**
 * Pure focus-mode gate. Returns whether a sound should play given the
 * configured `SoundFocusMode` and the caller-provided focus state.
 *
 * Platform-specific focus detection (e.g. `document.hasFocus()` in the
 * browser, `getTerminalFocusState()` in the CLI) is the caller's job —
 * this helper only encodes the enum-to-behavior mapping so it can be
 * shared across platforms.
 *
 * The `default` arm exists only to satisfy the `default-case` lint rule
 * via the exhaustiveness pattern; corrupted values are coerced back to
 * a valid enum at preference-read time, so this branch is unreachable.
 */
export function shouldPlayInFocusMode(
  mode: SoundFocusMode,
  isFocused: boolean
): boolean {
  switch (mode) {
    case SoundFocusMode.Always:
      return true;
    case SoundFocusMode.Focused:
      return isFocused;
    case SoundFocusMode.Unfocused:
      return !isFocused;
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

interface ResolveSubagentBehaviorParams {
  sessionId: string;
  parentMap: ReadonlyMap<string, string>;
  mode: SubagentSoundMode;
}

/**
 * Translates the configured `SubagentSoundMode` into a concrete behavior
 * for the session that just transitioned. Top-level sessions (those
 * without an entry in `parentMap`) always return Play — the subagent
 * toggle only ever silences child sessions.
 */
export function resolveSubagentBehavior({
  sessionId,
  parentMap,
  mode,
}: ResolveSubagentBehaviorParams): SubagentSoundBehavior {
  const isSubagent = parentMap.has(sessionId);
  if (!isSubagent) return SubagentSoundBehavior.Play;

  switch (mode) {
    case SubagentSoundMode.Off:
      return SubagentSoundBehavior.Skip;
    case SubagentSoundMode.Quiet:
      return SubagentSoundBehavior.Quiet;
    case SubagentSoundMode.Inherit:
      return SubagentSoundBehavior.Play;
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}
