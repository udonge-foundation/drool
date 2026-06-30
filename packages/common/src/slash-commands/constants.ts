import { SlashCommandCategory, SlashCommandName } from './enums';

import type { SharedSlashCommandMetadata } from './types';

export const ALL_SLASH_COMMAND_NAMES: readonly SlashCommandName[] =
  Object.values(SlashCommandName);

/**
 * The canonical metadata table for every first-party slash command.
 *
 * Typing this as `Record<SlashCommandName, SharedSlashCommandMetadata>`
 * is the parity contract: adding a value to `SlashCommandName` without
 * adding a metadata entry here is a compile error in `@industry/common`
 * itself, and callers can read optional fields like `aliasOf` and
 * `envGated` without any per-call widening.
 */
export const SLASH_COMMAND_METADATA: Record<
  SlashCommandName,
  SharedSlashCommandMetadata
> = {
  [SlashCommandName.AgentEffectivenessReport]: {
    name: SlashCommandName.AgentEffectivenessReport,
    description:
      'Generate an org-level agent effectiveness report from Industry usage, PRs, and work items',
    category: SlashCommandCategory.Tools,
  },
  [SlashCommandName.Automations]: {
    name: SlashCommandName.Automations,
    description: 'Manage local scheduled automations',
    category: SlashCommandCategory.Tools,
  },
  [SlashCommandName.Btw]: {
    name: SlashCommandName.Btw,
    description: 'Ask in Side Chat without polluting the main transcript',
    category: SlashCommandCategory.Session,
  },
  [SlashCommandName.Clear]: {
    name: SlashCommandName.Clear,
    description: 'Alias for /new',
    category: SlashCommandCategory.Session,
    aliasOf: SlashCommandName.New,
  },
  [SlashCommandName.Commands]: {
    name: SlashCommandName.Commands,
    description: 'Manage custom slash commands',
    category: SlashCommandCategory.Config,
  },
  [SlashCommandName.Compress]: {
    name: SlashCommandName.Compress,
    description: 'Compress the current session',
    category: SlashCommandCategory.Session,
  },
  [SlashCommandName.Context]: {
    name: SlashCommandName.Context,
    description: 'Show context window usage breakdown',
    category: SlashCommandCategory.Diagnostics,
  },
  [SlashCommandName.Copy]: {
    name: SlashCommandName.Copy,
    description: 'Copy the last assistant message to clipboard',
    category: SlashCommandCategory.Session,
  },
  [SlashCommandName.Cost]: {
    name: SlashCommandName.Cost,
    description: 'Show token usage and cost details',
    category: SlashCommandCategory.Diagnostics,
  },
  [SlashCommandName.CreateSkill]: {
    name: SlashCommandName.CreateSkill,
    description: 'Create a new skill from the current conversation',
    category: SlashCommandCategory.Tools,
  },
  [SlashCommandName.Cwd]: {
    name: SlashCommandName.Cwd,
    description: 'Change the working directory',
    category: SlashCommandCategory.Config,
  },
  [SlashCommandName.Diagnostics]: {
    name: SlashCommandName.Diagnostics,
    description: 'Open the diagnostics menu',
    category: SlashCommandCategory.Diagnostics,
  },
  [SlashCommandName.Drools]: {
    name: SlashCommandName.Drools,
    description: 'Open the drools menu',
    category: SlashCommandCategory.Config,
  },
  [SlashCommandName.Fast]: {
    name: SlashCommandName.Fast,
    description:
      'Enable fast mode for the current model (/fast off to disable)',
    category: SlashCommandCategory.Config,
  },
  [SlashCommandName.Favorite]: {
    name: SlashCommandName.Favorite,
    description: 'Alias for /pin',
    category: SlashCommandCategory.Session,
    aliasOf: SlashCommandName.Pin,
  },
  [SlashCommandName.Fork]: {
    name: SlashCommandName.Fork,
    description: 'Fork this session into a new independent session',
    category: SlashCommandCategory.Session,
  },
  [SlashCommandName.GitAi]: {
    name: SlashCommandName.GitAi,
    description: 'Manage Git AI integration',
    category: SlashCommandCategory.Tools,
  },
  [SlashCommandName.Help]: {
    name: SlashCommandName.Help,
    description: 'Open help modal with keyboard shortcuts and tips',
    category: SlashCommandCategory.Meta,
  },
  [SlashCommandName.Hooks]: {
    name: SlashCommandName.Hooks,
    description: 'Manage hooks',
    category: SlashCommandCategory.Config,
  },
  [SlashCommandName.Ide]: {
    name: SlashCommandName.Ide,
    description: 'Manage IDE integration',
    category: SlashCommandCategory.Tools,
  },
  [SlashCommandName.InstallSlackApp]: {
    name: SlashCommandName.InstallSlackApp,
    description: 'Install the Industry Slack app',
    category: SlashCommandCategory.Tools,
  },
  [SlashCommandName.Language]: {
    name: SlashCommandName.Language,
    description: 'Choose interface language',
    category: SlashCommandCategory.Config,
  },
  [SlashCommandName.Limits]: {
    name: SlashCommandName.Limits,
    description: 'Show credit rate limits and usage',
    category: SlashCommandCategory.Diagnostics,
  },
  [SlashCommandName.Loop]: {
    name: SlashCommandName.Loop,
    description: 'Configure or run the agent loop',
    category: SlashCommandCategory.Tools,
  },
  [SlashCommandName.Mcp]: {
    name: SlashCommandName.Mcp,
    description: 'Open MCP settings',
    category: SlashCommandCategory.Config,
  },
  [SlashCommandName.Missions]: {
    name: SlashCommandName.Missions,
    description: 'Open the missions picker',
    category: SlashCommandCategory.Tools,
  },
  [SlashCommandName.Model]: {
    name: SlashCommandName.Model,
    description: 'Open model selector',
    category: SlashCommandCategory.Config,
  },
  [SlashCommandName.New]: {
    name: SlashCommandName.New,
    description: 'Start a new session',
    category: SlashCommandCategory.Session,
  },
  [SlashCommandName.Pin]: {
    name: SlashCommandName.Pin,
    description: 'Toggle pin on the current session',
    category: SlashCommandCategory.Session,
  },
  [SlashCommandName.Plugins]: {
    name: SlashCommandName.Plugins,
    description: 'Open plugins settings',
    category: SlashCommandCategory.Config,
  },
  [SlashCommandName.Provider]: {
    name: SlashCommandName.Provider,
    description: 'Configure BYOK or coding subscription providers',
    category: SlashCommandCategory.Meta,
  },
  [SlashCommandName.Quit]: {
    name: SlashCommandName.Quit,
    description: 'Quit the CLI',
    category: SlashCommandCategory.Meta,
  },
  [SlashCommandName.ReadinessFix]: {
    name: SlashCommandName.ReadinessFix,
    description: 'Apply readiness fixes',
    category: SlashCommandCategory.Tools,
  },
  [SlashCommandName.ReadinessReport]: {
    name: SlashCommandName.ReadinessReport,
    description: 'Generate a readiness report',
    category: SlashCommandCategory.Tools,
  },
  [SlashCommandName.Rename]: {
    name: SlashCommandName.Rename,
    description: 'Rename the current session',
    category: SlashCommandCategory.Session,
  },
  [SlashCommandName.Review]: {
    name: SlashCommandName.Review,
    description: 'Run a code review on the current changes',
    category: SlashCommandCategory.Tools,
  },
  [SlashCommandName.RewindConversation]: {
    name: SlashCommandName.RewindConversation,
    description: 'Rewind the conversation to an earlier point',
    category: SlashCommandCategory.Session,
  },
  [SlashCommandName.Sessions]: {
    name: SlashCommandName.Sessions,
    description: 'List recent sessions',
    category: SlashCommandCategory.Navigation,
  },
  [SlashCommandName.Settings]: {
    name: SlashCommandName.Settings,
    description: 'Open settings',
    category: SlashCommandCategory.Navigation,
  },
  [SlashCommandName.SettingsDebug]: {
    name: SlashCommandName.SettingsDebug,
    description: 'Open settings debug menu',
    category: SlashCommandCategory.Diagnostics,
    envGated: 'non-production',
  },
  [SlashCommandName.SetupIncidentResponse]: {
    name: SlashCommandName.SetupIncidentResponse,
    description: 'Set up incident response integration',
    category: SlashCommandCategory.Tools,
  },
  [SlashCommandName.Share]: {
    name: SlashCommandName.Share,
    description: 'Share this session with your organization',
    category: SlashCommandCategory.Session,
  },
  [SlashCommandName.Skills]: {
    name: SlashCommandName.Skills,
    description: 'Open skills settings',
    category: SlashCommandCategory.Config,
  },
  [SlashCommandName.Squad]: {
    name: SlashCommandName.Squad,
    description: 'Open the squad mode overlay',
    category: SlashCommandCategory.Tools,
  },
  [SlashCommandName.Stats]: {
    name: SlashCommandName.Stats,
    description: 'Show your Drool usage statistics',
    category: SlashCommandCategory.Diagnostics,
  },
  [SlashCommandName.Status]: {
    name: SlashCommandName.Status,
    description: 'Show session status',
    category: SlashCommandCategory.Diagnostics,
  },
  [SlashCommandName.Statusline]: {
    name: SlashCommandName.Statusline,
    description: 'Configure the status line',
    category: SlashCommandCategory.Config,
  },
  [SlashCommandName.TerminalSetup]: {
    name: SlashCommandName.TerminalSetup,
    description: 'Configure terminal integration',
    category: SlashCommandCategory.Config,
  },
  [SlashCommandName.Themes]: {
    name: SlashCommandName.Themes,
    description: 'Choose a color theme',
    category: SlashCommandCategory.Config,
  },
};
