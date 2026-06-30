import { Command, Option } from 'commander';

import { DAEMON_LISTEN_MODE_VALUES } from '@/entrypoints/daemon/constants';
import { DaemonListenMode } from '@/entrypoints/daemon/enums';

export function makeCommand(): Command {
  return new Command('daemon')
    .description('Run the Industry daemon server')
    .addOption(
      new Option('-p, --port <number>', 'TCP port to listen on').argParser(
        parseInt
      )
    )
    .addOption(
      new Option('--host <address>', 'Host address to bind to').default(
        '127.0.0.1'
      )
    )
    .addOption(
      new Option('--unix <path>', 'Unix socket path (alternative to TCP)')
    )
    .addOption(new Option('-d, --debug', 'Enable debug logging').default(false))
    .addOption(
      new Option('--listen <transport>', 'Daemon transport to listen on')
        .choices(DAEMON_LISTEN_MODE_VALUES)
        .default(DaemonListenMode.WebSocket)
    )
    .addOption(
      new Option(
        '--enable-child-ipc',
        'Enable inherited IPC channels for daemon-spawned drool processes'
      ).default(false)
    )
    .addOption(
      new Option(
        '--drool-path <path>',
        'Path to drool executable for spawning sessions'
      )
    )
    .addOption(
      new Option(
        '--liveness-fd <fd>',
        'Monitor parent process liveness via inherited pipe'
      ).argParser((v: string) => Number.parseInt(v, 10))
    )
    .addOption(
      new Option('--parent-pid <pid>', 'Monitor parent process').argParser(
        (v: string) => Number.parseInt(v, 10)
      )
    )
    .addOption(
      new Option('--remote-access', 'Allow remote access').default(false)
    )
    .addOption(
      new Option(
        '--settings <path>',
        'Path to runtime settings file merged for this process only'
      )
    )
    .action(async (options, command: Command) => {
      // Forward root --settings if not specified on daemon directly
      if (!options.settings) {
        const rootSettings = command.parent?.opts()?.settings;
        if (rootSettings) options.settings = rootSettings;
      }
      if (typeof options.settings === 'string' && options.settings.trim()) {
        process.env.INDUSTRY_RUNTIME_SETTINGS_PATH = options.settings;
      }
      const { run } = await import('./run.ts');
      await run(options);
    });
}
