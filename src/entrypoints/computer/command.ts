import { Command } from 'commander';

export function makeCommand(): Command {
  const cmd = new Command('computer')
    .description('Manage relay computer registrations')
    .helpOption('-h, --help', 'display help for command')
    .hook('preAction', async () => {
      const { bootstrapLightweight } = await import(
        '@/entrypoints/bootstrap/lightweight'
      );
      await bootstrapLightweight();
    });

  cmd
    .command('register')
    .description('Register this machine as a relay computer')
    .argument('[name]', 'Computer name (defaults to hostname)')
    .option(
      '-y, --yes',
      'Skip interactive prompts (auto-clear stale local config)'
    )
    .action(async (nameArg, opts) => {
      const { runRegister } = await import('./run.ts');
      await runRegister(nameArg, opts);
    });

  cmd
    .command('remove')
    .description('Remove this machine from relay computers')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (opts) => {
      const { runRemove } = await import('./run.ts');
      await runRemove(opts);
    });

  cmd
    .command('list')
    .description('List registered relay computers')
    .action(async () => {
      const { runList } = await import('./run.ts');
      await runList();
    });

  // SSH subcommand — delegates to the existing full ssh command implementation
  cmd
    .command('ssh')
    .description('Open SSH connection to a relay computer')
    .argument('<computer-name>', 'Computer name to connect to')
    .option('--debug', 'Enable debug output')
    .option('--proxy', 'Run as stdio proxy (for ProxyCommand)')
    .option('--port <port>', 'Target port', '22')
    .action(async (computerName, opts) => {
      const { runSsh } = await import('./run.ts');
      await runSsh(computerName, opts);
    });

  return cmd;
}
