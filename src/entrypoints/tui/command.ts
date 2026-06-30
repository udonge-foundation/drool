import { Command } from 'commander';

export function makeCommand(): Command {
  return new Command('tui')
    .description('Start interactive mode (default)')
    .argument('[prompt...]', 'Inline prompt to start the session with')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (promptParts, _options, command) => {
      const rootOpts = command.parent?.opts() ?? {};
      const { run } = await import('./run.ts');
      await run(promptParts, rootOpts);
    });
}
