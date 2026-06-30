import { Command } from 'commander';

export function makeCommand(): Command {
  return new Command('update')
    .description('Check for and install Drool updates')
    .option('-c, --check', 'Only check for updates without installing')
    .option(
      '-v, --version <version>',
      'Update to a specific version (e.g., 1.2.3)'
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
