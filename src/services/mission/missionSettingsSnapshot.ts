import type { MissionModelSettings } from '@industry/common/settings';

export function resolveMissionSettingsSnapshot(
  baseSettings: Required<MissionModelSettings>,
  currentSettings?: MissionModelSettings | null
): Required<MissionModelSettings> {
  return {
    ...baseSettings,
    ...(currentSettings ?? {}),
  };
}
