import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { UpdateSessionMissionSyncMode } from '@industry/common/api/backend/enums';
import { logInfo, logWarn } from '@industry/logging';
import { getErrorCode } from '@industry/utils/errors';
import {
  MISSION_ARTIFACT_METADATA_FILE_NAMES,
  readMissionArtifactMetadataForSession,
} from '@industry/utils/mission';
import { promisePool } from '@industry/utils/promise';

import { getRuntimeAuthConfig } from '@/environment';
import { getCloudSyncService } from '@/services/CloudSyncService';
import { getSettingsService } from '@/services/SettingsService';
import { setSecureFilePermissions } from '@/utils/filePermissions';
import { getMissionsDir } from '@/utils/getMissionsDir';

import type { Dirent } from 'fs';

const BACKFILL_MARKER_VERSION = 1;
const BACKFILL_MARKER_FILE_NAME = '.mission-metadata-backfill.json';
const BACKFILL_CONCURRENCY = 3;

interface MissionMetadataBackfillMarker {
  version: number;
  synced: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCloudSessionSyncEnabled(): boolean {
  return getSettingsService().getSettings().general?.cloudSessionSync ?? true;
}

function isAirgapEnabled(): boolean {
  try {
    return getRuntimeAuthConfig().airgapEnabled === true;
  } catch {
    return false;
  }
}

function createEmptyMarker(): MissionMetadataBackfillMarker {
  return {
    version: BACKFILL_MARKER_VERSION,
    synced: {},
  };
}

function parseBackfillMarker(value: unknown): MissionMetadataBackfillMarker {
  if (!isRecord(value) || value.version !== BACKFILL_MARKER_VERSION) {
    return createEmptyMarker();
  }
  if (!isRecord(value.synced)) {
    return createEmptyMarker();
  }

  return {
    version: BACKFILL_MARKER_VERSION,
    synced: Object.fromEntries(
      Object.entries(value.synced).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === 'string' && typeof entry[1] === 'string'
      )
    ),
  };
}

async function readBackfillMarker(
  markerPath: string
): Promise<MissionMetadataBackfillMarker> {
  try {
    const content = await fs.readFile(markerPath, 'utf-8');
    return parseBackfillMarker(JSON.parse(content));
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return createEmptyMarker();
    }
    logWarn('Failed to read mission metadata backfill marker', {
      cause: error,
    });
    return createEmptyMarker();
  }
}

async function writeBackfillMarker(
  missionsDir: string,
  markerPath: string,
  marker: MissionMetadataBackfillMarker
): Promise<void> {
  await fs.mkdir(missionsDir, { recursive: true });
  const tempPath = `${markerPath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf-8');
  await setSecureFilePermissions(tempPath);
  await fs.rename(tempPath, markerPath);
}

async function getMissionArtifactFingerprint(
  missionDir: string
): Promise<string | null> {
  const parts = (
    await Promise.all(
      MISSION_ARTIFACT_METADATA_FILE_NAMES.map(async (fileName) => {
        const filePath = path.join(missionDir, fileName);
        try {
          const stat = await fs.stat(filePath);
          if (!stat.isFile()) {
            return null;
          }
          return `${fileName}:${stat.size}:${stat.mtimeMs}`;
        } catch (error) {
          if (getErrorCode(error) === 'ENOENT') {
            return null;
          }
          throw error;
        }
      })
    )
  ).filter((part): part is string => part !== null);

  if (parts.length === 0) {
    return null;
  }

  return createHash('sha256').update(parts.sort().join('|')).digest('hex');
}

async function listMissionSessionIds(missionsDir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(missionsDir, { withFileTypes: true });
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return [];
    }
    logWarn('Failed to list mission metadata backfill directory', {
      cause: error,
    });
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function backfillMissionMetadataToCloud(): Promise<void> {
  if (!isCloudSessionSyncEnabled() || isAirgapEnabled()) {
    return;
  }

  const missionsDir = getMissionsDir();
  const markerPath = path.join(missionsDir, BACKFILL_MARKER_FILE_NAME);
  const marker = await readBackfillMarker(markerPath);
  const sessionIds = await listMissionSessionIds(missionsDir);
  if (sessionIds.length === 0) {
    return;
  }

  let syncedCount = 0;
  const cloudSyncService = getCloudSyncService();
  await promisePool(
    sessionIds.map((sessionId) => async () => {
      try {
        const missionDir = path.join(missionsDir, sessionId);
        const fingerprint = await getMissionArtifactFingerprint(missionDir);
        if (!fingerprint || marker.synced[sessionId] === fingerprint) {
          return;
        }

        const mission = readMissionArtifactMetadataForSession({
          missionsDir,
          sessionId,
        });
        if (!mission) {
          return;
        }

        const didSync = await cloudSyncService.syncMissionMetadata(
          sessionId,
          mission,
          {
            syncMode: UpdateSessionMissionSyncMode.Backfill,
          }
        );
        if (!didSync) {
          return;
        }

        marker.synced[sessionId] = fingerprint;
        syncedCount += 1;
      } catch (error) {
        logWarn('Failed to backfill mission metadata to cloud', {
          cause: error,
          sessionId,
        });
      }
    }),
    BACKFILL_CONCURRENCY,
    { throwErrors: false }
  );

  if (syncedCount === 0) {
    return;
  }

  await writeBackfillMarker(missionsDir, markerPath, marker);
  logInfo('Backfilled mission metadata to cloud', {
    count: syncedCount,
    totalCount: sessionIds.length,
  });
}
