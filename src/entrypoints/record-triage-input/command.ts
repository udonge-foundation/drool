import { Command } from 'commander';

export function makeCommand(): Command {
  return new Command('record-triage-input')
    .description(
      'Report consumed-message count for a triage run (Software Industry SIGNAL metric)'
    )
    .requiredOption('--automation-id <id>', 'Triage automation id')
    .requiredOption('--run-id <id>', 'Unique id for this triage run')
    .requiredOption('--messages-consumed <n>', 'Raw messages consumed')
    .option(
      '--occurred-at <ms>',
      'Run timestamp in epoch milliseconds (default: now)'
    )
    .hook('preAction', async () => {
      const { bootstrapLightweight } = await import(
        '@/entrypoints/bootstrap/lightweight'
      );
      await bootstrapLightweight();
    })
    .action(async (options) => {
      const { run } = await import('./run.ts');
      await run(options);
    });
}
