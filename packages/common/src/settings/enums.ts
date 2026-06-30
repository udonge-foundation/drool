export enum DiffMode {
  Github = 'github',
  Unified = 'unified',
}

/**
 * Persisted impact level for an MCP tool/server approval. Mirrors RiskLevel
 * with an added 'none' for tools the resolver classifies as harmless. Kept as
 * a dedicated enum (rather than extending RiskLevel) so callers that switch
 * exhaustively on RiskLevel don't have to handle a new variant.
 */
export enum McpImpactLevel {
  None = 'none',
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

export enum BuiltInThemeName {
  /**
   * Sentinel value meaning "match the terminal's background appearance at
   * startup". Resolved by the CLI's ThemeEngine to IndustryLight or
   * IndustryDark based on OSC 11 detection. Treated as the default for new
   * users so first-run sessions on light terminals get a readable TUI.
   */
  Auto = 'auto',
  IndustryDark = 'industry-dark',
  IndustryLight = 'industry-light',
}

export enum SoundFocusMode {
  Always = 'always',
  Focused = 'focused',
  Unfocused = 'unfocused',
}

/**
 * Built-in sound identifiers shared between the CLI and the desktop/web
 * frontend. These string values are persisted in user settings, so adding
 * a new variant must be backwards compatible. Prefer keeping kebab-case
 * names that match the bundled WAV file basenames.
 */
export enum BuiltInSound {
  FX_OK01 = 'fx-ok01',
  FX_ACK01 = 'fx-ack01',
}

export enum TodoDisplayMode {
  Inline = 'inline',
  Pinned = 'pinned',
}

export enum CommandSource {
  Workspace = 'workspace',
  Global = 'global',
}

export enum SubagentSoundMode {
  Off = 'off',
  Quiet = 'quiet',
  Inherit = 'inherit',
}

/**
 * Autonomy level applied to subagents spawned by the Task tool (Subagents V2).
 * Mirrors `AutonomyLevel` (off/low/medium/high) with an added `Inherit`, which
 * falls back to the parent session's autonomy level. Defaults to `Inherit`
 * when unset. Kept as a dedicated enum (rather than extending `AutonomyLevel`)
 * for the same reasons as `McpImpactLevel` vs `RiskLevel`: enum types cannot be
 * spread/extended, and this file may not import. The shared values are kept in
 * sync with `AutonomyLevel` by a compile-time guard in `settings/schema.ts`.
 */
export enum SubagentAutonomyLevel {
  Off = 'off',
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Inherit = 'inherit',
}

/**
 * Result of resolving a session's subagent gating: should we play
 * normally, play the soft fallback chime, or skip the sound entirely?
 *
 * Lives alongside `SubagentSoundMode` so the gating helpers in
 * `soundGating.ts` can be reused by any platform (CLI, web, desktop).
 */
export enum SubagentSoundBehavior {
  Play = 'play',
  Quiet = 'quiet',
  Skip = 'skip',
}
