import { logException } from '@industry/logging';
import { isSentryEnabled, setSentryAdapter } from '@industry/logging/sentry';

import packageJson from '../package.json';
import { getTerminalInfo } from '@/utils/terminalInfo';

const PROXY_ENV_KEYS = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'no_proxy',
  'NO_PROXY',
];

/**
 * Drop whitespace-only proxy env vars before handing control to Sentry.
 *
 * Locked-down corporate Windows machines frequently push policies that set
 * `HTTPS_PROXY=" "` (or similar). Sentry's HTTP transport feeds that string
 * straight into `new URL(...)`, which throws synchronously inside the dynamic
 * `Sentry.init()` chain and surfaces as an unhandled promise rejection. In
 * daemon mode that rejection trips `handleCriticalError` and exits the process
 * with code 1 a few milliseconds after the WebSocket binds.
 */
function sanitizeProxyEnv(): void {
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value.trim() === '') {
      delete process.env[key];
    }
  }
}

/**
 * Cached reference to the lazily-imported `@sentry/node` module.
 * `null` means Sentry is disabled and was never imported.
 */
let _sentryModule: typeof import('@sentry/node') | null = null;

/**
 * Returns the loaded `@sentry/node` module, or a lightweight no-op proxy
 * when Sentry is disabled. Call sites can safely invoke `getSentry().setTag()`
 * etc. without checking whether Sentry was imported.
 */
export function getSentry(): Pick<
  typeof import('@sentry/node'),
  'setTag' | 'addBreadcrumb' | 'captureException' | 'captureMessage'
> {
  if (_sentryModule) return _sentryModule;

  // Return a no-op stub so callers never crash when Sentry is not loaded.
  return {
    setTag: () => {},
    addBreadcrumb: () => {},
    captureException: () => '',
    captureMessage: () => '',
  };
}

/**
 * Initialize Sentry for error tracking.
 *
 * When Sentry is enabled, this dynamically imports `@sentry/node` (avoiding
 * the ~131 MB barrel import on startup when disabled) and runs `Sentry.init()`.
 * When disabled, `@sentry/node` is never imported.
 */
export async function initSentry(): Promise<void> {
  if (!isSentryEnabled()) return;

  sanitizeProxyEnv();

  try {
    const Sentry = await import('@sentry/node');
    _sentryModule = Sentry;

    Sentry.init({
      dsn: 'https://91034003099b711f41abe709be6767c8@o4508485941854208.ingest.us.sentry.io/4509731857039361',
      environment: process.env.INDUSTRY_ENV ?? 'local',
      sendDefaultPii: true,
      enabled: true,
      integrations: [
        Sentry.nodeContextIntegration(),
        Sentry.localVariablesIntegration(),
        Sentry.contextLinesIntegration(),
      ],

      beforeSend(event) {
        event.tags = {
          ...event.tags,
          cliVersion: packageJson.version,
        };
        event.extra = {
          ...event.extra,
          argv: process.argv,
        };
        return event;
      },
    });

    setSentryAdapter(Sentry);

    const termInfo = getTerminalInfo();
    if (termInfo.name) Sentry.setTag('terminal', termInfo.name);
    if (termInfo.version) Sentry.setTag('terminalVersion', termInfo.version);
  } catch (error) {
    // Sentry.init can throw synchronously when proxy env is malformed (see
    // sanitizeProxyEnv) and the dynamic import itself can fail in unusual
    // environments. Failing to initialize Sentry must never crash the host;
    // in daemon mode an unhandled rejection here exits the process and breaks
    // every desktop bootstrap on the affected machine.
    _sentryModule = null;
    logException(error, '[sentry] init failed; continuing without Sentry');
  }
}
