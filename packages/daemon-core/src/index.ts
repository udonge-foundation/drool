/**
 * @industry/daemon-core
 *
 * Environment-agnostic daemon core implementation.
 * Both apps/daemon (standalone industryd) and apps/cli (drool daemon mode)
 * import from this package and provide their own environment configuration.
 */

export { DaemonCore } from './DaemonCore';

export type { DaemonCoreConfig } from './types';

export type { DaemonConfig, RelayConfig } from './server/types';
