import { logWarn } from '@industry/logging';

type ReactDevToolsBackend = {
  initialize?: () => void;
  connectToDevTools?: (options?: { host?: string; port?: number }) => void;
};

function isEnabled(): boolean {
  return (
    process.env.DROOL_REACT_DEVTOOLS === '1' ||
    process.env.DROOL_REACT_DEVTOOLS === 'true'
  );
}

export async function startReactDevToolsIfEnabled(): Promise<void> {
  if (!isEnabled() || process.env.INDUSTRY_ENV === 'production') {
    return;
  }

  try {
    const globals = globalThis as unknown as Record<string, unknown>;
    globals.window ??= globalThis;
    globals.self ??= globalThis;

    const backendModule = 'react-devtools-core/backend';
    const backend = (await import(backendModule)) as ReactDevToolsBackend;
    backend.initialize?.();
    backend.connectToDevTools?.({
      host: process.env.DROOL_REACT_DEVTOOLS_HOST || 'localhost',
      port: Number(process.env.DROOL_REACT_DEVTOOLS_PORT || 8097),
    });
  } catch (error) {
    logWarn('[Profiler] Failed to start React DevTools bridge', {
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
