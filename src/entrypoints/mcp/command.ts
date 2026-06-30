import { Command } from 'commander';

function parseRepeatedOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function makeCommand(): Command {
  const mcpCmd = new Command('mcp')
    .description('Manage MCP servers')
    .helpOption('-h, --help', 'display help for command')
    .hook('preAction', async () => {
      const { bootstrapLightweight } = await import(
        '@/entrypoints/bootstrap/lightweight'
      );
      await bootstrapLightweight();
    });

  mcpCmd
    .command('add')
    .description('Add a new MCP server')
    .argument('<name>', 'Name of the MCP server')
    .argument(
      '<urlOrCommand...>',
      'URL for http/sse servers or command for stdio servers'
    )
    .option(
      '--type <type>',
      'Server type: "http" (streamable), "sse" (remote SSE), or "stdio" (local)',
      'stdio'
    )
    .option(
      '--env <KEY=VALUE>',
      'Environment variable for stdio servers (can be used multiple times)',
      parseRepeatedOption,
      []
    )
    .option(
      '--header <KEY: VALUE>',
      'HTTP header for remote servers (can be used multiple times)',
      parseRepeatedOption,
      []
    )
    .option('--no-oauth', 'Disable OAuth for header/API-key remote servers')
    .action(async (name, urlOrCommandParts, options) => {
      const { runAdd } = await import('./run.ts');
      await runAdd(name, urlOrCommandParts, options);
    });

  mcpCmd
    .command('remove')
    .description('Remove an MCP server')
    .argument('[name]', 'Name of the MCP server to remove')
    .action(async (name) => {
      const { runRemove } = await import('./run.ts');
      await runRemove(name);
    });

  mcpCmd
    .command('list')
    .description(
      'List configured MCP servers with connection and authentication status'
    )
    .action(async () => {
      const { runList } = await import('./run.ts');
      await runList();
    });

  const permissionsCmd = mcpCmd
    .command('permissions')
    .description('Manage persistent MCP tool permissions')
    .helpOption('-h, --help', 'display help for command');

  permissionsCmd
    .command('list')
    .description('List all persistent MCP permissions')
    .action(async () => {
      const { runListPermissions } = await import('./run.ts');
      await runListPermissions();
    });

  permissionsCmd
    .command('revoke')
    .description(
      'Revoke MCP tool or server permission (revoking a server also revokes all per-tool permissions for that server)'
    )
    .argument('<server>', 'Server name (e.g., "linear")')
    .argument('[tool]', 'Optional tool name (e.g., "list_issues")')
    .action(async (server, tool) => {
      const { runRevokePermission } = await import('./run.ts');
      await runRevokePermission(server, tool);
    });

  permissionsCmd
    .command('clear')
    .description('Clear all persistent MCP permissions')
    .option('--confirm', 'Confirm clearing all permissions')
    .action(async (options: { confirm?: boolean }) => {
      const { runClearPermissions } = await import('./run.ts');
      await runClearPermissions(options.confirm ?? false);
    });

  return mcpCmd;
}
