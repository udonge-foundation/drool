import { Command } from 'commander';

export function makeCommand(): Command {
  return new Command('push-git-ai-notes')
    .description('Push git-ai authorship notes to Industry backend')
    .hook('preAction', async () => {
      const { bootstrapLightweight } = await import(
        '@/entrypoints/bootstrap/lightweight'
      );
      await bootstrapLightweight();
    })
    .action(async () => {
      const { run } = await import('./run.ts');
      await run();
    });
}
