import { execSync } from 'child_process';

import { WindowsPowerShellNotFoundError } from '@/utils/errors';

const WINDOWS_POWERSHELL_CANDIDATES = ['pwsh.exe', 'powershell.exe'] as const;

type WindowsPowerShellExecutable =
  (typeof WINDOWS_POWERSHELL_CANDIDATES)[number];

let cachedWindowsPowerShellExecutable:
  | WindowsPowerShellExecutable
  | null
  | undefined;

function getCandidateOrder(): readonly WindowsPowerShellExecutable[] {
  if (!cachedWindowsPowerShellExecutable) {
    return WINDOWS_POWERSHELL_CANDIDATES;
  }

  return [
    cachedWindowsPowerShellExecutable,
    ...WINDOWS_POWERSHELL_CANDIDATES.filter(
      (candidate) => candidate !== cachedWindowsPowerShellExecutable
    ),
  ];
}

function extractErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error ?? '');
  }

  const nodeError = error as NodeJS.ErrnoException & {
    stderr?: string;
  };

  return [nodeError.message, nodeError.stderr]
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .toLowerCase();
}

function isMissingExecutableError(
  error: unknown,
  executable: WindowsPowerShellExecutable
): boolean {
  const nodeError = error as NodeJS.ErrnoException;

  if (nodeError?.code === 'ENOENT') {
    return true;
  }

  const text = extractErrorText(error);
  if (!text.includes(executable.toLowerCase())) {
    return false;
  }

  return (
    text.includes('not found') ||
    text.includes('is not recognized') ||
    text.includes('enoent')
  );
}

async function tryWindowsPowerShellCandidates<T>(
  candidates: readonly WindowsPowerShellExecutable[],
  fn: (shellExecutable: WindowsPowerShellExecutable) => Promise<T>,
  index: number = 0
): Promise<T> {
  if (index >= candidates.length) {
    cachedWindowsPowerShellExecutable = null;
    throw new WindowsPowerShellNotFoundError();
  }

  const candidate = candidates[index];

  try {
    const result = await fn(candidate);
    cachedWindowsPowerShellExecutable = candidate;
    return result;
  } catch (error) {
    if (!isMissingExecutableError(error, candidate)) {
      throw error;
    }
    return tryWindowsPowerShellCandidates(candidates, fn, index + 1);
  }
}

export async function withWindowsPowerShellFallback<T>(
  fn: (shellExecutable: WindowsPowerShellExecutable) => Promise<T>
): Promise<T> {
  if (cachedWindowsPowerShellExecutable === null) {
    throw new WindowsPowerShellNotFoundError();
  }

  return tryWindowsPowerShellCandidates(getCandidateOrder(), fn);
}

export function withWindowsPowerShellFallbackSync<T>(
  fn: (shellExecutable: WindowsPowerShellExecutable) => T
): T {
  if (cachedWindowsPowerShellExecutable === null) {
    throw new WindowsPowerShellNotFoundError();
  }

  const candidates = getCandidateOrder();

  for (const candidate of candidates) {
    try {
      const result = fn(candidate);
      cachedWindowsPowerShellExecutable = candidate;
      return result;
    } catch (error) {
      if (!isMissingExecutableError(error, candidate)) {
        throw error;
      }
    }
  }

  cachedWindowsPowerShellExecutable = null;
  throw new WindowsPowerShellNotFoundError();
}

export function resolveWindowsPowerShellExecutableSync(): WindowsPowerShellExecutable {
  if (cachedWindowsPowerShellExecutable === null) {
    throw new WindowsPowerShellNotFoundError();
  }

  if (cachedWindowsPowerShellExecutable) {
    return cachedWindowsPowerShellExecutable;
  }

  return withWindowsPowerShellFallbackSync((candidate) => {
    execSync('Write-Output "ok"', {
      shell: candidate,
      stdio: 'ignore',
      windowsHide: true,
    });
    return candidate;
  });
}

export function resetWindowsPowerShellResolverForTests(): void {
  cachedWindowsPowerShellExecutable = undefined;
}
