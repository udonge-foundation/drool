/**
 * Capabilities barrel: the `createXCapability` factories and their dep types.
 * Never re-exports a `*RequestHandler` or other heavy dep, so it stays
 * statically importable by a terminal-less core; handlers are pulled only via
 * each capability's `load()` thunk.
 */
export { createDroolCapability } from './drool/capability';
export { createManagementCapability } from './management/capability';
export { createRelayCapability } from './relay/capability';
export { createSettingsCapability } from './settings/capability';
export { createTerminalCapability } from './terminal/capability';

export type {
  DroolCapability,
  DroolCapabilityDeps,
  DroolCapabilityHostDeps,
} from './drool/types';
export type {
  ManagementCapabilityDeps,
  ManagementCapabilityHostDeps,
} from './management/types';
export type {
  RelayCapabilityDeps,
  RelayCapabilityHostDeps,
} from './relay/types';
export type { SettingsCapabilityDeps } from './settings/types';
export type { TerminalCapabilityDeps } from './terminal/types';
