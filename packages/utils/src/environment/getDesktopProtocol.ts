import { IndustryEnv, getBaseEnv } from '@industry/environment';

const DESKTOP_PROTOCOL_PRODUCTION = 'industry-desktop';
const DESKTOP_PROTOCOL_DEV = 'industry-desktop-dev';

/**
 * Deep-link / OAuth redirect protocol for the Industry desktop app.
 *
 * Returns `industry-desktop` for production-tier builds (includes staging and
 * preprod, which share the production protocol) and `industry-desktop-dev`
 * otherwise.
 *
 * Keyed off `env.env` (IndustryEnv), not `deploymentEnv`, because staging/
 * preprod desktop builds ship with INDUSTRY_ENV=production and match the
 * production protocol at the OS level.
 *
 * Callers may pass an explicit override (used by backend callback routes
 * that inspect the incoming request's origin); otherwise the current
 * process's base env is consulted.
 */
export function getDesktopProtocol(industryEnv?: string): string {
  const effective = industryEnv ?? getBaseEnv().env;
  return effective === IndustryEnv.Production
    ? DESKTOP_PROTOCOL_PRODUCTION
    : DESKTOP_PROTOCOL_DEV;
}
