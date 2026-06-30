import { Command } from 'commander';

export function makeCommand(): Command {
  return new Command('wiki-read')
    .description('Read wiki pages')
    .option('--repo-url <url>', 'Repository URL to find wiki for')
    .option('--wiki-run-id <id>', 'Specific wiki run ID')
    .option('--page <pageId>', 'Specific page to display')
    .option('--json', 'Output as JSON')
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
