import { SlashCommandName } from '@industry/common/slash-commands';

import { agentEffectivenessReportCommand } from '@/commands/agent-effectiveness-report';
import { automationsCommand } from '@/commands/automations';
import { btwCommand } from '@/commands/btw';
import { clearCommand } from '@/commands/clear';
import { commandsManagerCommand } from '@/commands/commands-manager';
import { compactCommand } from '@/commands/compact';
import { contextCommand } from '@/commands/context';
import { copyCommand } from '@/commands/copy';
import { costCommand } from '@/commands/cost';
import { createSkillCommand } from '@/commands/create-skill';
import { cwdCommand } from '@/commands/cwd';
import { diagnosticsCommand } from '@/commands/diagnostics';
import { droolsCommand } from '@/commands/drools';
import { fastCommand } from '@/commands/fast';
import { favoriteCommand, pinCommand } from '@/commands/favorite';
import { forkCommand } from '@/commands/fork';
import { gitAiCommand } from '@/commands/git-ai';
import { helpCommand } from '@/commands/help';
import { hooksCommand } from '@/commands/hooks';
import { ideCommand } from '@/commands/ide';
import { installSlackAppCommand } from '@/commands/install-slack-app';
import { languageCommand } from '@/commands/language';
import { limitsCommand } from '@/commands/limits';
import { providerCommand } from '@/commands/loginCommand';
import { loopCommand } from '@/commands/loop';
import { mcpCommand } from '@/commands/mcp/mcp';
import { missionsCommand } from '@/commands/missions';
import { modelCommand } from '@/commands/model';
import { newCommand } from '@/commands/new';
import { pluginsCommand } from '@/commands/plugins';
import { quitCommand } from '@/commands/quit';
import { readinessFixCommand } from '@/commands/readiness-fix';
import { readinessReportCommand } from '@/commands/readiness-report';
import { renameCommand } from '@/commands/rename';
import { reviewCommand } from '@/commands/review';
import { rewindCommand } from '@/commands/rewind';
import { sessionsCommand } from '@/commands/sessions';
import { settingsCommand } from '@/commands/settings';
import { settingsDebugCommand } from '@/commands/settings-debug';
import { setupIncidentResponseCommand } from '@/commands/setup-incident-response';
import { shareCommand } from '@/commands/share';
import { skillsCommand } from '@/commands/skills';
import { squadCommand } from '@/commands/squad';
import { statsCommand } from '@/commands/stats';
import { statusCommand } from '@/commands/status';
import { statuslineCommand } from '@/commands/statusline';
import { terminalSetupCommand } from '@/commands/terminal-setup';
import { themeCommand } from '@/commands/theme';
import type { SlashCommand } from '@/commands/types';

/**
 * Exhaustive map of every first-party slash command keyed by the shared
 * `SlashCommandName` enum from `@industry/common/slash-commands`.
 *
 * The `satisfies Record<SlashCommandName, SlashCommand>` clause is the
 * parity contract on the CLI side: adding a value to `SlashCommandName`
 * without registering a handler here is a compile error.
 *
 * The runtime invariant that each entry's `.name` matches its key is
 * enforced by `builtins.invariants.test.ts` — this module deliberately has
 * no side effects so that test can import it without triggering full CLI
 * bootstrap.
 *
 * Exposed as a function (rather than a top-level `const`) so the table can
 * live in a regular module without violating
 * `industry/constants-file-organization`; downstream callers should treat
 * the returned record as effectively static (computed once at import).
 */
const BUILTIN_COMMANDS = {
  // Settings / navigation
  [SlashCommandName.AgentEffectivenessReport]: agentEffectivenessReportCommand,
  [SlashCommandName.Automations]: automationsCommand(),
  [SlashCommandName.Btw]: btwCommand,
  [SlashCommandName.Clear]: clearCommand,
  [SlashCommandName.Copy]: copyCommand,
  [SlashCommandName.Cost]: costCommand,
  [SlashCommandName.Cwd]: cwdCommand,
  [SlashCommandName.Diagnostics]: diagnosticsCommand,
  [SlashCommandName.Drools]: droolsCommand,

  // Fast / skills cluster
  [SlashCommandName.Fast]: fastCommand,
  [SlashCommandName.Skills]: skillsCommand,
  [SlashCommandName.CreateSkill]: createSkillCommand,

  // Help / tools / integrations
  [SlashCommandName.Help]: helpCommand,
  [SlashCommandName.Ide]: ideCommand,
  [SlashCommandName.InstallSlackApp]: installSlackAppCommand,
  [SlashCommandName.SetupIncidentResponse]: setupIncidentResponseCommand,
  [SlashCommandName.Review]: reviewCommand,
  [SlashCommandName.Hooks]: hooksCommand,

  // Locale / limits / auth
  [SlashCommandName.Language]: languageCommand,
  [SlashCommandName.Limits]: limitsCommand,
  [SlashCommandName.Loop]: loopCommand,
  [SlashCommandName.Plugins]: pluginsCommand,
  [SlashCommandName.Mcp]: mcpCommand,
  [SlashCommandName.Missions]: missionsCommand,
  [SlashCommandName.Model]: modelCommand,
  [SlashCommandName.Compress]: compactCommand,
  [SlashCommandName.Context]: contextCommand,
  [SlashCommandName.New]: newCommand,
  [SlashCommandName.Favorite]: favoriteCommand,
  [SlashCommandName.Pin]: pinCommand,
  [SlashCommandName.Fork]: forkCommand,
  [SlashCommandName.Provider]: providerCommand,
  [SlashCommandName.Rename]: renameCommand,
  [SlashCommandName.Quit]: quitCommand,
  [SlashCommandName.ReadinessReport]: readinessReportCommand,
  [SlashCommandName.ReadinessFix]: readinessFixCommand,
  [SlashCommandName.RewindConversation]: rewindCommand,
  [SlashCommandName.Sessions]: sessionsCommand,
  [SlashCommandName.Share]: shareCommand,
  [SlashCommandName.Settings]: settingsCommand,
  [SlashCommandName.Stats]: statsCommand,
  [SlashCommandName.SettingsDebug]: settingsDebugCommand,
  [SlashCommandName.Status]: statusCommand,
  [SlashCommandName.Statusline]: statuslineCommand,
  [SlashCommandName.Squad]: squadCommand,
  [SlashCommandName.TerminalSetup]: terminalSetupCommand,
  [SlashCommandName.Themes]: themeCommand,
  [SlashCommandName.GitAi]: gitAiCommand,
  [SlashCommandName.Commands]: commandsManagerCommand(),
} as const satisfies Record<SlashCommandName, SlashCommand>;

export function getBuiltinCommands(): Record<SlashCommandName, SlashCommand> {
  return BUILTIN_COMMANDS;
}
