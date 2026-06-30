import { Command, Option } from 'commander';

export function makeCommand(): Command {
  return new Command('search')
    .alias('find')
    .description(
      'Search across local sessions (messages, documents, tool results)'
    )
    .argument('<query>', 'Query text (substring + typo-tolerant)')
    .addOption(
      new Option(
        '--kind <kind>',
        'Filter by kind: message_text|document|tool_use|tool_result|all'
      ).default('all')
    )
    .addOption(
      new Option('--limit-sessions <n>', 'Max sessions to return')
        .default('20')
        .argParser((v: string) => parseInt(v, 10))
    )
    .addOption(
      new Option('--limit-hits <n>', 'Max matches per kind per session')
        .default('3')
        .argParser((v: string) => parseInt(v, 10))
    )
    .addOption(
      new Option(
        '--context-chars <n>',
        'Characters of context around the match'
      )
        .default('80')
        .argParser((v: string) => parseInt(v, 10))
    )
    .addOption(new Option('--json', 'Output JSON'))
    .addOption(new Option('--reindex', 'Drop cache and rebuild index'))
    .hook('preAction', async () => {
      const { bootstrapLightweight } = await import(
        '@/entrypoints/bootstrap/lightweight'
      );
      await bootstrapLightweight();
    })
    .action(async (query, opts) => {
      const { run } = await import('./run.ts');
      await run(query, opts);
    });
}
