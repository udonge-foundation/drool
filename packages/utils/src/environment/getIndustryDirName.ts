import { getBaseEnv } from '@industry/environment';

/**
 * Directory name for Industry config/data under $HOME.
 *
 * Returns `.industry` for production-tier apps and `.industry-dev` otherwise,
 * based on the base env each app registers via createEnvironment() at
 * startup. Thin accessor over getBaseEnv().industryDirName -- callers that
 * need other base fields should import getBaseEnv from @industry/environment
 * directly.
 */
export function getIndustryDirName(): string {
  return getBaseEnv().industryDirName;
}
