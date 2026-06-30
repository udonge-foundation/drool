/**
 * Canonical identifier for every first-party slash command shared between
 * the CLI (`apps/cli/src/commands`) and the frontend
 * (`packages/frontend/src/features/sessions/hooks/useSlashCommands.ts`).
 *
 * Adding a value here forces:
 *  1. CLI: a registration in `BUILTIN_COMMANDS` (Record<SlashCommandName, _>)
 *  2. Frontend: a resolution in the hook's resolution map (Record<SlashCommandName, _>)
 *
 * Custom slash commands (loaded via `customCommandsLoader` and skills) keep
 * free-form `name: string` and intentionally do NOT participate here.
 *
 * `ALL_SLASH_COMMAND_NAMES` and `SLASH_COMMAND_METADATA` live alongside this
 * enum in `./constants` — see `index.ts` for the package's public surface.
 */
export enum SlashCommandName {
  AgentEffectivenessReport = 'agent-effectiveness-report',
  Automations = 'automations',
  Btw = 'btw',
  Clear = 'clear',
  Commands = 'commands',
  Compress = 'compress',
  Context = 'context',
  Copy = 'copy',
  Cost = 'cost',
  CreateSkill = 'create-skill',
  Cwd = 'cwd',
  Diagnostics = 'diagnostics',
  Drools = 'drools',
  Fast = 'fast',
  Favorite = 'favorite',
  Fork = 'fork',
  GitAi = 'git-ai',
  Help = 'help',
  Hooks = 'hooks',
  Ide = 'ide',
  InstallSlackApp = 'install-slack-app',
  Language = 'language',
  Limits = 'limits',
  Loop = 'loop',
  Mcp = 'mcp',
  Missions = 'missions',
  Model = 'model',
  New = 'new',
  Pin = 'pin',
  Plugins = 'plugins',
  Provider = 'provider',
  Quit = 'quit',
  ReadinessFix = 'readiness-fix',
  ReadinessReport = 'readiness-report',
  Rename = 'rename',
  Review = 'review',
  RewindConversation = 'rewind-conversation',
  Sessions = 'sessions',
  Settings = 'settings',
  SettingsDebug = 'settings-debug',
  SetupIncidentResponse = 'setup-incident-response',
  Share = 'share',
  Skills = 'skills',
  Squad = 'squad',
  Stats = 'stats',
  Status = 'status',
  Statusline = 'statusline',
  TerminalSetup = 'terminal-setup',
  Themes = 'themes',
}

/** Broad grouping used for picker ordering and reasoning about coverage. */
export enum SlashCommandCategory {
  Navigation = 'navigation',
  Session = 'session',
  Tools = 'tools',
  Config = 'config',
  Diagnostics = 'diagnostics',
  Meta = 'meta',
}
