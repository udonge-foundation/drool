import { Command } from 'commander';

export function makeCommand(): Command {
  return new Command('wiki-search')
    .description('Search wiki pages')
    .option('--repo-url <url>', 'Repository URL to find wiki for')
    .option('--wiki-run-id <id>', 'Specific wiki run ID')
    .requiredOption('--query <text>', 'Search query')
    .option('--limit <n>', 'Max results (default: 20)', '20')
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
