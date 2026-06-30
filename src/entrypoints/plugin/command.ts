import { Command, Option } from 'commander';

const scopeOption = new Option(
  '-s, --scope <scope>',
  'Installation scope'
).choices(['user', 'project']);

export function makeCommand(): Command {
  const pluginCmd = new Command('plugin')
    .description('Manage plugins')
    .helpOption('-h, --help', 'display help for command')
    .hook('preAction', async () => {
      const { bootstrapLightweight } = await import(
        '@/entrypoints/bootstrap/lightweight'
      );
      await bootstrapLightweight();
    });

  const marketplaceCmd = pluginCmd
    .command('marketplace')
    .description('Manage plugin marketplaces')
    .helpOption('-h, --help', 'display help for command');

  marketplaceCmd
    .command('add')
    .description('Add a marketplace repository')
    .argument('<url>', 'Git URL of the marketplace repository')
    .action(async (url) => {
      const { runMarketplaceAdd } = await import('./marketplace.ts');
      await runMarketplaceAdd(url);
    });

  marketplaceCmd
    .command('remove')
    .description('Remove a marketplace')
    .argument('<name>', 'Name of the marketplace to remove')
    .action(async (name) => {
      const { runMarketplaceRemove } = await import('./marketplace.ts');
      await runMarketplaceRemove(name);
    });

  marketplaceCmd
    .command('list')
    .description('List registered marketplaces')
    .action(async () => {
      const { runMarketplaceList } = await import('./marketplace.ts');
      await runMarketplaceList();
    });

  marketplaceCmd
    .command('update')
    .description('Update marketplace(s)')
    .argument('[name]', 'Name of the marketplace to update (all if omitted)')
    .action(async (name) => {
      const { runMarketplaceUpdate } = await import('./marketplace.ts');
      await runMarketplaceUpdate(name);
    });

  pluginCmd
    .command('install')
    .alias('i')
    .description('Install a plugin')
    .argument(
      '<plugin>',
      'Plugin to install (format: plugin@marketplace, e.g., security-engineer@industry-plugins)'
    )
    .addOption(scopeOption)
    .action(async (plugin, options) => {
      const { runInstall } = await import('./run.ts');
      await runInstall(plugin, options);
    });

  pluginCmd
    .command('uninstall')
    .alias('remove')
    .description('Uninstall a plugin')
    .argument(
      '<plugin>',
      'Plugin ID to uninstall (e.g., security-engineer@industry-plugins)'
    )
    .addOption(scopeOption)
    .action(async (plugin, options) => {
      const { runUninstall } = await import('./run.ts');
      await runUninstall(plugin, options);
    });

  pluginCmd
    .command('update')
    .description('Update plugins')
    .argument('[plugin]', 'Plugin ID to update (all plugins if omitted)')
    .addOption(scopeOption)
    .action(async (plugin, options) => {
      const { runUpdate } = await import('./run.ts');
      await runUpdate(plugin, options);
    });

  pluginCmd
    .command('list')
    .description('List installed plugins')
    .addOption(scopeOption)
    .action(async (options) => {
      const { runList } = await import('./run.ts');
      await runList(options);
    });

  return pluginCmd;
}
