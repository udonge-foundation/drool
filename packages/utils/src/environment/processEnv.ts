export function getProcessEnvironmentVariable(
  name: string
): string | undefined {
  // eslint-disable-next-line industry/no-direct-process-env -- low-level process.env accessor
  return process.env[name];
}

export function setProcessEnvironmentVariable(
  name: string,
  value: string | undefined
): void {
  if (value === undefined) {
    // eslint-disable-next-line industry/no-direct-process-env -- low-level process.env accessor
    delete process.env[name];
    return;
  }

  // eslint-disable-next-line industry/no-direct-process-env -- low-level process.env accessor
  process.env[name] = value;
}

export function getProcessEnvironment(): NodeJS.ProcessEnv {
  // eslint-disable-next-line industry/no-direct-process-env -- low-level process.env accessor
  return process.env;
}
