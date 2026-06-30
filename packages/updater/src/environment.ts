const INDUSTRY_DROOL_BINARY_ENV_KEY = 'INDUSTRY_DROOL_BINARY' as const;

export function isBaselineBuild(): boolean {
  return process.env.IS_BASELINE === 'true';
}

export function getRestartChildEnvironment(): NodeJS.ProcessEnv {
  const childEnv = { ...process.env };
  delete childEnv[INDUSTRY_DROOL_BINARY_ENV_KEY];
  return childEnv;
}

export function getIndustryDroolBinaryOverride(): string | undefined {
  return process.env[INDUSTRY_DROOL_BINARY_ENV_KEY];
}

export function setIndustryDroolBinaryOverride(binaryPath: string): void {
  process.env[INDUSTRY_DROOL_BINARY_ENV_KEY] = binaryPath;
}
