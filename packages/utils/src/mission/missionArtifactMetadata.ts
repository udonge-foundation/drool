import fs from 'fs';
import path from 'path';

import {
  FeatureStatus,
  MissionState,
  ProgressLogEntryType,
} from '@industry/drool-sdk-ext/protocol/drool';
import { logWarn } from '@industry/logging';

import { MISSION_ARTIFACT_METADATA_FILES } from './constants';
import { MissionArtifactReadOperation } from './enums';
import { getMissionActiveElapsedMs } from './missionElapsedTime';

import type {
  MissionArtifactReadError,
  MissionElapsedProgressEntry,
  ReadMissionArtifactMetadataOptions,
} from './types';
import type { IndustryMissionArtifactMetadata } from '@industry/common/session';

function sanitizeDirName(name: string): string | null {
  const sanitized = path.basename(name);
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    return null;
  }
  return sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function emitReadError(
  onReadError: ReadMissionArtifactMetadataOptions['onReadError'],
  error: MissionArtifactReadError
): void {
  onReadError?.(error);
}

function toMissionState(value: unknown): MissionState | null {
  for (const state of Object.values(MissionState)) {
    if (value === state) {
      return state;
    }
  }
  return null;
}

function toProgressLogEntryType(value: unknown): ProgressLogEntryType | null {
  for (const entryType of Object.values(ProgressLogEntryType)) {
    if (value === entryType) {
      return entryType;
    }
  }
  return null;
}

function readMissionJsonFile(
  missionDir: string,
  fileName: string,
  onReadError?: ReadMissionArtifactMetadataOptions['onReadError']
): Record<string, unknown> | null {
  const filePath = path.join(missionDir, fileName);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    emitReadError(onReadError, {
      operation: MissionArtifactReadOperation.MissionJson,
      error,
      fileName,
    });
    logWarn('Failed to read mission JSON artifact metadata', {
      fileName,
      cause: error,
      actionType: MissionArtifactReadOperation.MissionJson,
    });
  }
  return null;
}

function readMissionFeatureCounts(
  missionDir: string,
  onReadError?: ReadMissionArtifactMetadataOptions['onReadError']
): Pick<IndustryMissionArtifactMetadata, 'completedFeatures' | 'totalFeatures'> {
  const fileName = MISSION_ARTIFACT_METADATA_FILES.features;
  const filePath = path.join(missionDir, fileName);
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    const features = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.features)
        ? parsed.features
        : null;

    if (!features) {
      return {};
    }

    return {
      completedFeatures: features.filter(
        (feature) =>
          isRecord(feature) && feature.status === FeatureStatus.Completed
      ).length,
      totalFeatures: features.length,
    };
  } catch (error) {
    emitReadError(onReadError, {
      operation: MissionArtifactReadOperation.MissionJson,
      error,
      fileName,
    });
    logWarn('Failed to read mission feature count metadata', {
      fileName,
      cause: error,
      actionType: MissionArtifactReadOperation.MissionJson,
    });
  }

  return {};
}

export function extractMissionTitleFromMarkdown(
  missionMd: string | null | undefined
): string | null {
  const titleMatch = missionMd?.match(/^#\s+(.+)$/m);
  return titleMatch?.[1]?.trim() ?? null;
}

function readMissionTextFile(
  missionDir: string,
  fileName: string,
  onReadError?: ReadMissionArtifactMetadataOptions['onReadError']
): string | null {
  const filePath = path.join(missionDir, fileName);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch (error) {
    emitReadError(onReadError, {
      operation: MissionArtifactReadOperation.MissionText,
      error,
      fileName,
    });
    logWarn('Failed to read mission text artifact metadata', {
      fileName,
      cause: error,
      actionType: MissionArtifactReadOperation.MissionText,
    });
  }
  return null;
}

function readMissionProgressLog(
  missionDir: string,
  onReadError?: ReadMissionArtifactMetadataOptions['onReadError']
): MissionElapsedProgressEntry[] {
  const fileName = MISSION_ARTIFACT_METADATA_FILES.progressLog;
  const progressLogPath = path.join(missionDir, fileName);
  if (!fs.existsSync(progressLogPath)) {
    return [];
  }

  try {
    const progressLogContent = fs.readFileSync(progressLogPath, 'utf-8');

    return progressLogContent
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isRecord(parsed) || typeof parsed.timestamp !== 'string') {
            return [];
          }
          const entryType = toProgressLogEntryType(parsed.type);
          return entryType === null
            ? []
            : [{ type: entryType, timestamp: parsed.timestamp }];
        } catch (error) {
          emitReadError(onReadError, {
            operation: MissionArtifactReadOperation.MissionProgressLogEntry,
            error,
            fileName,
          });
          logWarn('Failed to read mission progress log entry metadata', {
            fileName,
            cause: error,
            actionType: MissionArtifactReadOperation.MissionProgressLogEntry,
          });
        }
        return [];
      });
  } catch (error) {
    emitReadError(onReadError, {
      operation: MissionArtifactReadOperation.MissionProgressLog,
      error,
      fileName,
    });
    logWarn('Failed to read mission progress log metadata', {
      fileName,
      cause: error,
      actionType: MissionArtifactReadOperation.MissionProgressLog,
    });
  }
  return [];
}

export function readMissionArtifactMetadataForSession({
  missionsDir,
  sessionId,
  onReadError,
}: ReadMissionArtifactMetadataOptions):
  | IndustryMissionArtifactMetadata
  | undefined {
  const safeSessionDirName = sanitizeDirName(sessionId);
  if (safeSessionDirName === null) {
    return undefined;
  }

  const missionDir = path.join(missionsDir, safeSessionDirName);
  if (!fs.existsSync(missionDir)) {
    return undefined;
  }

  const stateFileName = MISSION_ARTIFACT_METADATA_FILES.state;
  const stateFilePath = path.join(missionDir, stateFileName);
  const hasStateFile = fs.existsSync(stateFilePath);
  const stateFile = readMissionJsonFile(missionDir, stateFileName, onReadError);
  const state =
    stateFile === null && !hasStateFile
      ? MissionState.Planning
      : toMissionState(stateFile?.state);
  if (state === null) {
    return undefined;
  }
  const workingDirectory =
    typeof stateFile?.workingDirectory === 'string'
      ? stateFile.workingDirectory
      : readMissionTextFile(
          missionDir,
          MISSION_ARTIFACT_METADATA_FILES.workingDirectory,
          onReadError
        );
  const missionMd = readMissionTextFile(
    missionDir,
    MISSION_ARTIFACT_METADATA_FILES.mission,
    onReadError
  );
  const progressLog = readMissionProgressLog(missionDir, onReadError);
  const featureCounts = readMissionFeatureCounts(missionDir, onReadError);
  const title = extractMissionTitleFromMarkdown(missionMd);
  const createdAt =
    typeof stateFile?.createdAt === 'string' ? stateFile.createdAt : undefined;
  const updatedAt =
    typeof stateFile?.updatedAt === 'string' ? stateFile.updatedAt : undefined;
  const elapsedMs = getMissionActiveElapsedMs({ state, progressLog });

  return {
    state,
    ...(title ? { title } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(elapsedMs !== null ? { elapsedMs } : {}),
    ...featureCounts,
  };
}
