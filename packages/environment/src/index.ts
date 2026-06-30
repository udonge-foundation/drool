// Types
export type {
  IndustryEnvironment,
  IndustryEnvironmentBase,
  EnvironmentInput,
  IndustryEnvType,
  EnvLoader,
  CreateEnvLoaderOptions,
  ResolveEnvOptions,
  EnvironmentVariableName,
} from './types';

// Enums
export { IndustryEnv, DeploymentEnv } from '@industry/common/environment';

// Constants
export { EnvironmentVariable } from './constants';
/** @public */
export { TEST_DEFAULTS } from './constants';

// Industry functions
export {
  createEnvironment,
  parseIndustryEnv,
  parseDeploymentEnv,
  parseIndustryRegion,
  resolveDeploymentEnv,
  getIndustryEnv,
  isProductionTier,
} from './industry';
export type { ResolveDeploymentEnvOptions } from './types';

// Base env seam for shared packages (packages/services, packages/daemon-core,
// packages/drool-core, packages/utils, etc.). Auto-seeded by createEnvironment
// so apps don't need to manually invoke a setter. Shared packages that need
// a derived path (e.g. getIndustryDirName) live in @industry/utils/environment.
export { getBaseEnv, isProductionDeployment } from './base-env';

// Loader pattern
export { createEnvLoader } from './loader';
export { envFields } from './fields';

// Resolution helpers (Edge Runtime compatible -- no process.cwd/process.platform)
export {
  isTestEnvironment,
  resolveEnv,
  resolveEnvAsPositiveInt,
  toString,
} from './resolve-universal';

// Resolution helpers (Node.js only -- uses process.cwd/process.platform)
export { resolveShell, resolveHomeDir } from './resolve';

// Env-string parsers shared between the CLI env loader and the
// bootstrap-before-init patch-console IIFE.
export { parsePositiveIntEnv } from './parsePositiveIntEnv';
