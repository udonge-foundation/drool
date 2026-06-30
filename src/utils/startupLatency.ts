import { Metrics, type MetricLabels } from '@industry/logging';

type StartupLatencyLabels<T> = MetricLabels | ((result: T) => MetricLabels);

function getShellName(): string | undefined {
  const shellPath = process.env.SHELL ?? process.env.ComSpec;
  if (!shellPath) return undefined;
  return shellPath.split(/[\\/]/).filter(Boolean).at(-1);
}

function getBinaryKind(): string {
  const argvEntry = process.argv[1] ?? '';
  if (
    argvEntry.endsWith('/src/index.ts') ||
    argvEntry.endsWith('\\src\\index.ts')
  ) {
    return 'source';
  }
  if (argvEntry.includes('/bundle/') || argvEntry.includes('\\bundle\\')) {
    return 'bundle';
  }
  const execName = process.execPath.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  if (execName === 'drool' || execName === 'drool.exe') {
    return 'compiled';
  }
  return 'unknown';
}

export function getCliRuntimeMetricLabels(): MetricLabels {
  const shell = getShellName();
  return {
    arch: process.arch,
    binaryKind: getBinaryKind(),
    bytecodeEnabled:
      process.env.INDUSTRY_CLI_BYTECODE_ENABLED === 'true' ? 'true' : 'false',
    ...(shell ? { shell } : {}),
  };
}

export function recordStartupLatency(
  metric: string,
  startTime: number,
  labels: MetricLabels = {}
): void {
  Metrics.addToCounter(metric, performance.now() - startTime, {
    ...getCliRuntimeMetricLabels(),
    ...labels,
  });
}

export async function withStartupLatency<T>(
  metric: string,
  operation: () => Promise<T>,
  labels: StartupLatencyLabels<T> = {}
): Promise<T> {
  const startTime = performance.now();
  try {
    const result = await operation();
    const successLabels =
      typeof labels === 'function' ? labels(result) : labels;
    recordStartupLatency(metric, startTime, {
      ...successLabels,
      outcome: 'success',
    });
    return result;
  } catch (error) {
    const errorLabels = typeof labels === 'function' ? {} : labels;
    recordStartupLatency(metric, startTime, {
      ...errorLabels,
      outcome: 'error',
    });
    throw error;
  }
}
