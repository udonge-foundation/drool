import { Command } from 'commander';

export function makeCommand(): Command {
  return new Command('git-ai-checkpoint-hook')
    .description('Run git-ai checkpoint hook with daemon self-healing')
    .requiredOption('--git-ai-bin <path>', 'Path to git-ai binary')
    .hook('preAction', async () => {
      const { CliTelemetryClient } = await import('@/utils/cliTelemetryClient');
      try {
        CliTelemetryClient.initializeSync();
      } catch (error) {
        // Telemetry is optional for git-ai hooks. The log sink is not
        // configured yet, so route to stderr to avoid corrupting the hook's
        // stdout passthrough.
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[git-ai] telemetry initialization failed: ${message}\n`
        );
      }
    })
    .action(async (options) => {
      const { run } = await import('./run.ts');
      await run(options);
    });
}
