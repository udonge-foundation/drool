import type { SnapshotSettings } from '@/services/snapshots/types';

export const DEFAULT_SNAPSHOT_SETTINGS: SnapshotSettings = {
  enabled: true,
  storageLimitMB: 100,
  retentionDays: 30,
  minBoundariesPerSession: 5,
};
