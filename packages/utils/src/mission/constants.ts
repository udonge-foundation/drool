export const MISSION_ELAPSED_TIMER_INTERVAL_MS = 1000;

export const MISSION_ARTIFACT_METADATA_FILES = {
  state: 'state.json',
  workingDirectory: 'working_directory.txt',
  mission: 'mission.md',
  features: 'features.json',
  progressLog: 'progress_log.jsonl',
} as const;

export const MISSION_ARTIFACT_METADATA_FILE_NAMES = [
  MISSION_ARTIFACT_METADATA_FILES.state,
  MISSION_ARTIFACT_METADATA_FILES.workingDirectory,
  MISSION_ARTIFACT_METADATA_FILES.mission,
  MISSION_ARTIFACT_METADATA_FILES.features,
  MISSION_ARTIFACT_METADATA_FILES.progressLog,
] as const;
