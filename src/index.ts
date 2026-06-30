/**
 * Entry-point dispatcher for Industry CLI.
 *
 * Uses Commander as a lightweight router to handle --version and --help
 * natively, then delegates to self-contained entrypoints via dynamic import.
 *
 * Each subcommand defines its own options in its command.ts file via the
 * makeCommand() industry pattern — options live close to their implementation.
 */
import '@/utils/e2eClock';

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { Command } from 'commander';
import { config as dotenvConfig } from 'dotenv';

import { makeCommand as makeComputerCmd } from '@/entrypoints/computer/command';
import { makeCommand as makeDaemonCmd } from '@/entrypoints/daemon/command';
import { makeCommand as makeExecCmd } from '@/entrypoints/exec/command';
import { makeCommand as makeGitAiCheckpointHookCmd } from '@/entrypoints/git-ai-checkpoint-hook/command';
import { makeCommand as makeMcpCmd } from '@/entrypoints/mcp/command';
import { makeCommand as makePluginCmd } from '@/entrypoints/plugin/command';
import { makeCommand as makePushGitAiNotesCmd } from '@/entrypoints/push-git-ai-notes/command';
import { makeCommand as makeRecordTriageInputCmd } from '@/entrypoints/record-triage-input/command';
import { makeCommand as makeSearchCmd } from '@/entrypoints/search/command';
import { makeCommand as makeTuiCmd } from '@/entrypoints/tui/command';
import { tuiOptions } from '@/entrypoints/tui/constants';
import { makeCommand as makeUpdateCmd } from '@/entrypoints/update/command';
import { makeCommand as makeWikiReadCmd } from '@/entrypoints/wiki-read/command';
import { makeCommand as makeWikiSearchCmd } from '@/entrypoints/wiki-search/command';
import { makeCommand as makeWikiUploadCmd } from '@/entrypoints/wiki-upload/command';
import { exitWithCode } from '@/utils/exitWithCode';

const __dirIndex = dirname(fileURLToPath(import.meta.url));
const program = new Command();
let dispatcherDotenvLoaded = false;

function loadDispatcherDotenv(): void {
  if (dispatcherDotenvLoaded) {
    return;
  }
  dispatcherDotenvLoaded = true;
  dotenvConfig({ path: resolve(__dirIndex, '..', '.env'), quiet: true });
  dotenvConfig({
    path: resolve(__dirIndex, '..', '.env.local'),
    override: true,
    quiet: true,
  });
}

async function ensureWholeProcessSandboxBeforeEntrypoint(): Promise<void> {
  loadDispatcherDotenv();
  await import('@/api/init');
  const { loadWholeProcessSandboxBootstrapSettings } = await import(
    '@/sandbox/wholeProcessSandboxSettings'
  );
  const { ensureWholeProcessSandbox } = await import(
    '@/sandbox/wholeProcessSandbox'
  );
  const sandboxSettings = await loadWholeProcessSandboxBootstrapSettings();
  await ensureWholeProcessSandbox(sandboxSettings);
}

program
  .name('drool')
  .description("Drool - Industry's AI coding agent in your terminal")
  .version(process.env.CLI_VERSION || 'unknown', '-v, --version')
  .enablePositionalOptions()
  .arguments('[prompt...]')
  .helpOption('-h, --help', 'display help for command')
  .addHelpText(
    'after',
    `
Examples:
  drool "review app.tsx"              Start with an initial prompt
  drool                               Start interactive mode (default)
  drool exec "analyze this file"      Run non-interactively (for scripts/automation)
  drool exec -f prompt.txt            Execute from file (non-interactive)
  drool update                        Check for and install updates manually

For more details, see: https://docs.example.com/cli/getting-started/overview`
  );

// Surface TUI options on root program for --help display
for (const opt of tuiOptions) {
  program.addOption(opt);
}

// Root preAction hooks run before every subcommand's action (and before the
// subcommands' own preAction hooks), so whole-process sandbox re-exec is
// guaranteed to happen before any entrypoint code executes.
program.hook('preAction', async () => {
  await ensureWholeProcessSandboxBeforeEntrypoint();
});

// Visible commands
program.addCommand(makeExecCmd());
program.addCommand(makeDaemonCmd());
program.addCommand(makeSearchCmd());
program.addCommand(makeUpdateCmd());
program.addCommand(makeMcpCmd());
program.addCommand(makePluginCmd());
program.addCommand(makeComputerCmd());

// Hidden commands
program.addCommand(makeWikiReadCmd(), { hidden: true });
program.addCommand(makeWikiSearchCmd(), { hidden: true });
program.addCommand(makeWikiUploadCmd(), { hidden: true });
program.addCommand(makePushGitAiNotesCmd(), { hidden: true });
program.addCommand(makeGitAiCheckpointHookCmd(), { hidden: true });
program.addCommand(makeRecordTriageInputCmd(), { hidden: true });

// Default command: TUI (interactive mode + inline prompts)
program.addCommand(makeTuiCmd(), { isDefault: true, hidden: true });

program.exitOverride();

try {
  await program.parseAsync(process.argv);
  // Route the natural-exit path through the shutdown coordinator so pending
  // telemetry/customer-metrics flushes complete and the event loop drains.
  // TUI/exec/daemon either never resolve parseAsync or call exitWithCode
  // themselves; lightweight subcommands fall through to here.
  await exitWithCode(0);
} catch (err) {
  // Commander throws on --version/--help with exitOverride; preserve its exit code.
  if (typeof err === 'object' && err !== null && 'exitCode' in err) {
    process.exit((err as { exitCode?: number }).exitCode ?? 1);
  }
  throw err;
}
