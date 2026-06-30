/**
 * Lightweight bootstrap for non-interactive subcommands.
 *
 * Handles: dotenv, credentials, environment/API init, i18n, platform
 * (certs, stale binary cleanup), auth (token, host identity, feature flags).
 *
 * Used by: plugin, mcp, search, update, computer, wiki-read, wiki-search,
 * wiki-upload, push-git-ai-notes. Heavy entrypoints (TUI, exec, daemon)
 * have their own bootstrap in their respective run.ts files.
 */
import '@/utils/patch-console';

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { config as dotenvConfig } from 'dotenv';

const __dir = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dir, '../../..', '.env'), quiet: true });
dotenvConfig({
  path: resolve(__dir, '../../..', '.env.local'),
  override: true,
  quiet: true,
});

export async function bootstrapLightweight(): Promise<void> {
  const { configureCredentialsStorage } = await import('@industry/runtime/auth');
  const { getEmbeddedKeytar } = await import('@/utils/keytarEmbedded');
  configureCredentialsStorage({ keytarLoader: getEmbeddedKeytar });

  await import('@/api/init');

  const { CliTelemetryClient } = await import('@/utils/cliTelemetryClient');
  try {
    CliTelemetryClient.initializeSync();
  } catch {
    // Non-fatal: telemetry is optional for lightweight commands
  }

  const { initI18n } = await import('@/i18n');
  initI18n();

  const { bootstrapPlatform } = await import('./platform.ts');
  await bootstrapPlatform();

  const { bootstrapAuth } = await import('./auth.ts');
  await bootstrapAuth();
}
