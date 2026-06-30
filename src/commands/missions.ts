import fs from 'fs/promises';
import path from 'path';

import {
  DecompSessionType,
  FeatureStatus,
  MissionState,
} from '@industry/drool-sdk-ext/protocol/drool';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException, logInfo } from '@industry/logging';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getMissionFileService } from '@/services/mission/MissionFileService';
import { MissionErrorType, MissionMetadata } from '@/services/mission/types';
import { getSessionService } from '@/services/SessionService';
import { getMissionsDir } from '@/utils/getMissionsDir';

/**
 * Get the sessions directory path
 */
function getSessionsDir(): string {
  return path.join(getIndustryHome(), getIndustryDirName(), 'sessions');
}

/**
 * Build an index of all available session transcripts once, so listing many
 * missions does not rescan the sessions tree for every mission.
 */
async function buildTranscriptIndex(): Promise<Set<string>> {
  const sessionsDir = getSessionsDir();
  const transcriptIds = new Set<string>();

  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    const projectDirs = entries.filter(
      (entry) => entry.isDirectory() && entry.name.startsWith('-')
    );

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        transcriptIds.add(entry.name.slice(0, -'.jsonl'.length));
      }
    }

    for (const dir of projectDirs) {
      try {
        const projectEntries = await fs.readdir(
          path.join(sessionsDir, dir.name),
          {
            withFileTypes: true,
          }
        );

        for (const entry of projectEntries) {
          if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            transcriptIds.add(entry.name.slice(0, -'.jsonl'.length));
          }
        }
      } catch {
        // Ignore unreadable project directories and continue indexing others.
      }
    }
  } catch {
    // Sessions directory doesn't exist or can't be read
  }

  return transcriptIds;
}

function sessionTranscriptExists(
  sessionId: string,
  transcriptIds: ReadonlySet<string>
): boolean {
  return transcriptIds.has(sessionId);
}

/**
 * Detect specific error type from a file read error
 */
function detectErrorType(error: unknown): {
  type: MissionErrorType;
  message: string;
} {
  if (error instanceof SyntaxError) {
    return {
      type: MissionErrorType.InvalidJson,
      message: 'Invalid JSON format',
    };
  }

  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError.code === 'EACCES' || nodeError.code === 'EPERM') {
    return {
      type: MissionErrorType.PermissionDenied,
      message: 'Permission denied',
    };
  }

  return {
    type: MissionErrorType.ReadError,
    message: error instanceof Error ? error.message : 'Unknown error',
  };
}

async function readFeatureCounts(missionDir: string): Promise<{
  completedFeatures: number | null;
  totalFeatures: number | null;
}> {
  const featuresFilePath = path.join(missionDir, 'features.json');

  try {
    const featuresContent = await fs.readFile(featuresFilePath, 'utf-8');
    const parsed = JSON.parse(featuresContent);
    const features =
      typeof parsed === 'object' &&
      parsed !== null &&
      'features' in parsed &&
      Array.isArray(parsed.features)
        ? parsed.features
        : null;

    if (!features) {
      return {
        completedFeatures: null,
        totalFeatures: null,
      };
    }

    return {
      completedFeatures: features.filter(
        (feature: { status?: unknown }) =>
          feature.status === FeatureStatus.Completed
      ).length,
      totalFeatures: features.length,
    };
  } catch {
    return {
      completedFeatures: null,
      totalFeatures: null,
    };
  }
}

/**
 * Read mission metadata from a mission directory
 */
async function readMissionMetadata(
  missionsDir: string,
  missionDirName: string,
  transcriptIds: ReadonlySet<string>
): Promise<MissionMetadata> {
  const missionDir = path.join(missionsDir, missionDirName);
  const stateFilePath = path.join(missionDir, 'state.json');

  const metadata: MissionMetadata = {
    baseSessionId: missionDirName,
    state: null,
    title: null,
    workingDirectory: null,
    createdAt: null,
    updatedAt: null,
    completedFeatures: null,
    totalFeatures: null,
    hasError: false,
  };

  // Try to read state.json
  try {
    const stateContent = await fs.readFile(stateFilePath, 'utf-8');
    try {
      const state = JSON.parse(stateContent);
      metadata.state = state.state ?? null;
      metadata.workingDirectory = state.workingDirectory ?? null;
      metadata.createdAt = state.createdAt ? new Date(state.createdAt) : null;
      metadata.updatedAt = state.updatedAt ? new Date(state.updatedAt) : null;
      metadata.completedFeatures =
        typeof state.completedFeatures === 'number'
          ? state.completedFeatures
          : null;
      metadata.totalFeatures =
        typeof state.totalFeatures === 'number' ? state.totalFeatures : null;

      if (
        metadata.completedFeatures === null ||
        metadata.totalFeatures === null
      ) {
        const featureCounts = await readFeatureCounts(missionDir);
        metadata.completedFeatures = featureCounts.completedFeatures;
        metadata.totalFeatures = featureCounts.totalFeatures;
      }
    } catch (parseError) {
      // JSON parse error on state.json - this is a significant error
      const { type, message } = detectErrorType(parseError);
      return {
        ...metadata,
        hasError: true,
        errorType: type,
        errorMessage: `state.json: ${message}`,
        errorPath: stateFilePath,
      };
    }
  } catch (readError) {
    const nodeError = readError as NodeJS.ErrnoException;
    // Only flag permission errors as actual errors; ENOENT is expected for new missions
    if (nodeError.code === 'EACCES' || nodeError.code === 'EPERM') {
      const { type, message } = detectErrorType(readError);
      return {
        ...metadata,
        hasError: true,
        errorType: type,
        errorMessage: `state.json: ${message}`,
        errorPath: stateFilePath,
      };
    }
    if (nodeError.code === 'ENOENT') {
      metadata.state = MissionState.Planning;
    }
  }

  metadata.title =
    await getMissionFileService(missionDirName).readMissionTitle();

  // Check if session transcript exists (required to resume)
  const transcriptExists = sessionTranscriptExists(
    missionDirName,
    transcriptIds
  );
  if (!transcriptExists) {
    return {
      ...metadata,
      hasError: true,
      errorType: MissionErrorType.MissingTranscript,
      errorMessage: 'Session transcript not found (cannot resume)',
      errorPath: path.join(getSessionsDir(), `${missionDirName}.jsonl`),
    };
  }

  return metadata;
}

/**
 * List all missions from the missions directory
 */
async function listMissions(): Promise<MissionMetadata[]> {
  const missionsDir = getMissionsDir();

  try {
    // Check if missions directory exists
    await fs.access(missionsDir);
  } catch {
    // Directory doesn't exist - no missions
    return [];
  }

  try {
    const entries = await fs.readdir(missionsDir, { withFileTypes: true });
    const missionDirs = entries.filter((entry) => entry.isDirectory());
    const transcriptIds = await buildTranscriptIndex();

    // Read metadata for all missions in parallel
    const metadataPromises = missionDirs.map((dir) =>
      readMissionMetadata(missionsDir, dir.name, transcriptIds)
    );

    const missions = await Promise.all(metadataPromises);

    // Sort by updatedAt descending (newest first), with nulls at the end
    return missions.sort((a, b) => {
      const aTime = a.updatedAt?.getTime() ?? a.createdAt?.getTime() ?? 0;
      const bTime = b.updatedAt?.getTime() ?? b.createdAt?.getTime() ?? 0;
      return bTime - aTime;
    });
  } catch (error) {
    logException(error, 'Error listing missions');
    return [];
  }
}

// eslint-disable-next-line industry/constants-file-organization
export const missionsCommand: SlashCommand = {
  name: 'missions',
  description: 'Enter, manage and resume missions; ms',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage, showMissionsPicker } = context;

    try {
      const missions = await listMissions();

      logInfo('Missions retrieved', {
        totalCount: missions.length,
        errorCount: missions.filter((m) => m.hasError).length,
      });

      // Determine current mission for the unified menu
      const sessionService = getSessionService();
      const isInMission =
        sessionService.getDecompSessionType() ===
        DecompSessionType.Orchestrator;
      const currentMissionId = isInMission
        ? (sessionService.getDecompMissionId() ??
          sessionService.getCurrentSessionId())
        : null;

      // Show the missions picker UI (including for empty state)
      // The picker handles empty state with an in-picker message for consistent UX
      if (showMissionsPicker) {
        showMissionsPicker(missions, { currentMissionId });
        return { handled: true };
      }

      // Fallback if showMissionsPicker is not available
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.missionsPickerNotAvailable'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );

      return { handled: true };
    } catch (error) {
      logException(error, 'Error loading missions');
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.errorLoadingMissions'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }
  },
};
