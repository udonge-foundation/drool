/**
 * @industry/updater
 *
 * Shared auto-update functionality for Industry applications (CLI, Daemon, etc.)
 */

export { UpdateErrorCategory, UpdateOutcome, UpdaterStateType } from './enums';
export { cleanupStalePreservedBinaries } from './preservedBinary';
export type {
  PendingUpdateMarker,
  RemoteConfig,
  UpdateInfo,
  UpdaterConfig,
  UpdaterState,
} from './types';
export { Updater } from './Updater';
export { classifyUpdateError } from './utils/errorClassification';
