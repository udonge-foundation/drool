export function isAbortError(error: unknown): boolean {
  let name: string | undefined;
  let message = '';

  if (typeof error === 'object' && error !== null) {
    const e = error as { name?: unknown; message?: unknown };
    name = typeof e.name === 'string' ? e.name : undefined;
    if (typeof e.message === 'string') {
      message = e.message;
    } else if (e.message != null) {
      message = String(e.message);
    }
  }

  const lower = message.toLowerCase();
  return (
    name === 'AbortError' ||
    name === 'APIUserAbortError' ||
    lower.includes('aborted') ||
    lower.includes('request was aborted')
  );
}
