import type { StartupProcessContext } from '@/utils/types';

const DROOL_EXEC_RUN_TYPE = 'DROOL_EXEC_RUN_TYPE';

function getArgValue(argv: string[], flagNames: string[]): string | undefined {
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];

    for (const flagName of flagNames) {
      if (arg === flagName) {
        return argv[index + 1];
      }

      if (arg.startsWith(`${flagName}=`)) {
        return arg.slice(flagName.length + 1);
      }
    }
  }

  return undefined;
}

function getSubcommand(argv: string[]): string | undefined {
  return argv.slice(2).find((arg) => !arg.startsWith('-'));
}

function sanitizeRunType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  const slug = normalized
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || undefined;
}

export function classifyStartupProcess(
  argv: string[] = process.argv,
  isInteractiveTty: boolean = process.stdout.isTTY === true,
  env: NodeJS.ProcessEnv = process.env
): StartupProcessContext {
  const subcommand = getSubcommand(argv);
  const inputFormat = getArgValue(argv, ['--input-format']);
  const outputFormat = getArgValue(argv, ['--output-format', '-o']);
  const callingSessionIdPresent = argv.includes('--calling-session-id');
  const isStreamJsonRpcWorker =
    inputFormat === 'stream-jsonrpc' || outputFormat === 'stream-jsonrpc';
  const isDroolExec = subcommand === 'exec';
  const droolExecRunType = isDroolExec
    ? sanitizeRunType(env[DROOL_EXEC_RUN_TYPE])
    : undefined;
  const isDroolWorkerProcess = isStreamJsonRpcWorker || callingSessionIdPresent;

  return {
    subcommand,
    isDroolExec,
    inputFormat,
    outputFormat,
    droolExecRunType,
    isStreamJsonRpcWorker,
    callingSessionIdPresent,
    isInteractiveTty,
    isDroolWorkerProcess,
  };
}
