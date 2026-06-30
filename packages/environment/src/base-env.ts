import { DeploymentEnv, IndustryEnv } from '@industry/common/environment';

import { INDUSTRY_ENV_DIRS } from './constants';
import { EnvironmentError } from './errors';
import { isTestEnvironment } from './resolve-universal';

import type { IndustryEnvironmentBase } from './types';

/**
 * Development-shaped fallback used when a shared package reads the base env
 * in a test that hasn't gone through an app composition root. Keeps parity
 * with the pre-refactor behavior of helpers like getIndustryDirName, which
 * silently returned `.industry-dev` for unseeded callers.
 */
const TEST_BASE_ENV: Readonly<IndustryEnvironmentBase> = Object.freeze({
  env: IndustryEnv.Development,
  deploymentEnv: DeploymentEnv.Development,
  apiBaseUrl: 'https://test.api.example.com',
  appBaseUrl: 'https://test.example.com',
  downloadsBucket: 'test-downloads.example.com',
  downloadsPathPrefix: '',
  industryDirName: INDUSTRY_ENV_DIRS[IndustryEnv.Development],
  telemetryIngestBaseUrl: 'https://dev.telemetry.example.com',
  publicDownloadsBaseUrl: 'https://downloads.example.com',
  isProductionTier: false,
});

let baseEnv: Readonly<IndustryEnvironmentBase> | null = null;

/**
 * Register the canonical base environment for this process.
 *
 * Called automatically by createEnvironment, so apps do not need to invoke
 * it directly. Tests that need to seed a specific base env should call
 * createEnvironment({...}) -- which invokes this as a side effect -- rather
 * than calling setBaseEnv themselves.
 *
 * @internal
 */
export function setBaseEnv(env: IndustryEnvironmentBase): void {
  baseEnv = Object.freeze(env);
}

/**
 * True for build-time / static-analysis tooling that imports app modules
 * without running the app's composition root. Currently:
 *   - Next.js `phase-production-build` (backend `next build`)
 *   - next-rest-framework `openapi:validate` / `openapi:generate` (sets
 *     `OPENAPI_VALIDATE=true` via the backend's npm script)
 * These contexts do not touch the filesystem via base-env fields; falling
 * back to the dev default is safe and matches the pre-refactor behavior
 * of helpers like getIndustryDirName().
 */
function isBuildTimeToolingContext(): boolean {
  return (
    process.env.NEXT_PHASE === 'phase-production-build' ||
    process.env.OPENAPI_VALIDATE === 'true'
  );
}

/**
 * Read the canonical base environment for this process.
 *
 * Safe to call from any shared package in the monorepo (packages/services,
 * packages/daemon-core, packages/drool-core, packages/runtime/auth,
 * packages/updater, etc.). Reads any field declared on IndustryEnvironmentBase.
 *
 * - In production, throws if no app composition root has invoked
 *   createEnvironment() yet. Fails fast instead of silently returning a
 *   dev default.
 * - In test environments (NODE_ENV=test or VITEST_WORKER_ID set) and in
 *   build-time tooling contexts (Next.js build phase, next-rest-framework
 *   OpenAPI generation), returns a frozen development default when nothing
 *   has been seeded -- matches the pre-refactor behavior of helpers like
 *   getIndustryDirName().
 */
export function getBaseEnv(): Readonly<IndustryEnvironmentBase> {
  if (baseEnv) return baseEnv;
  if (isTestEnvironment() || isBuildTimeToolingContext()) return TEST_BASE_ENV;
  throw new EnvironmentError(
    'Base environment has not been initialized. Your app composition root must call createEnvironment() before any shared package reads from the base environment.'
  );
}

/**
 * Convenience predicate for shared/backend code that just needs to fork on
 * production vs non-production deployment. Reads from the seeded base env --
 * see {@link getBaseEnv} for the seeding contract.
 *
 * Most code should compare {@link getBaseEnv}().deploymentEnv against
 * {@link DeploymentEnv.Production} directly; this helper exists as a small
 * convenience for callers (e.g. apps/backend/src/lib/gcp/*) that fork on
 * "production" several times in the same file.
 */
export function isProductionDeployment(): boolean {
  return getBaseEnv().deploymentEnv === DeploymentEnv.Production;
}
