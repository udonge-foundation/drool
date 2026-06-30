import fs from 'node:fs';
import path from 'node:path';

import { ToolExecutionErrorType } from '@industry/common/session';
import { SessionNotificationType } from '@industry/drool-sdk-ext/protocol/drool';
import { logWarn } from '@industry/logging';

import { AgentEvent, agentEventBus } from '@/events/AgentEventBus';
import { getMissionFileService } from '@/services/mission/MissionFileService';
import { getSessionService } from '@/services/SessionService';
import { detectFileType } from '@/tools/executors/client/file-tools/detectFileType';
import { FileType } from '@/tools/executors/client/file-tools/enums';

const MAX_FILE_READ_SIZE = 20 * 1024 * 1024; // 20MB

interface IsPathInsideDirectoryParams {
  targetPath: string;
  directory: string;
}

export function isPathInsideDirectory({
  targetPath,
  directory,
}: IsPathInsideDirectoryParams): boolean {
  try {
    const realTarget = fs.realpathSync(targetPath);
    const realDirectory = fs.realpathSync(directory);

    const relative = path.relative(realDirectory, realTarget);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

interface FetchFileContentParams {
  repoPath: string;
  filePath: string;
}

interface FetchFileContentResult {
  success: boolean;
  content?: string;
  error?: {
    userError: string;
    llmError: string;
    errorType: ToolExecutionErrorType;
  };
}

/**
 * Reads and processes a single file, handling text, images, and PDFs.
 * @param filePath Absolute path to the file.
 * @param rootDirectory Absolute path to the project root for relative path display.
 * @param offset Optional offset for text files (0-based line number).
 * @param limit Optional limit for text files (number of lines to read).
 * @returns ProcessedFileReadResult object.
 */
export async function fetchFileContent({
  repoPath,
  filePath,
}: FetchFileContentParams): Promise<FetchFileContentResult> {
  try {
    const fullPath = path.join(repoPath, filePath);
    if (!fs.existsSync(fullPath)) {
      // Sync check is acceptable before async read
      return {
        success: false,
        error: {
          userError: `File not found`,
          llmError: `File not found`,
          errorType: ToolExecutionErrorType.EnvironmentStateError,
        },
      };
    }
    const stats = await fs.promises.stat(fullPath);
    if (stats.isDirectory()) {
      return {
        success: false,
        error: {
          userError: 'Path is a directory.',
          llmError: `Path is a directory, not a file: ${filePath}`,
          errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        },
      };
    }

    const fileSizeInBytes = stats.size;

    if (fileSizeInBytes > MAX_FILE_READ_SIZE) {
      return {
        success: false,
        error: {
          userError: 'File is too large to read',
          llmError: `File size exceeds the 20MB limit: (MB) ${(fileSizeInBytes / (1024 * 1024)).toFixed(2)}`,
          errorType: ToolExecutionErrorType.ToolInternalError,
        },
      };
    }

    const fileType = await detectFileType(fullPath);
    const relativePathForDisplay = path
      .relative(repoPath, filePath)
      .replace(/\\/g, '/');

    switch (fileType) {
      case FileType.BINARY: {
        return {
          success: false,
          error: {
            userError: 'Cannot view binary files',
            llmError: 'Cannot view binary files',
            errorType: ToolExecutionErrorType.InvalidParameterLLMError,
          },
        };
      }
      case FileType.SVG: {
        const SVG_MAX_SIZE_BYTES = 1 * 1024 * 1024;
        if (stats.size > SVG_MAX_SIZE_BYTES) {
          return {
            success: false,
            error: {
              userError: 'Cannot display content of SVG file larger than 1MB',
              llmError: `Skipped large SVG file (>1MB): ${relativePathForDisplay}`,
              errorType: ToolExecutionErrorType.ToolInternalError,
            },
          };
        }
        const content = await fs.promises.readFile(fullPath, 'utf8');
        return {
          success: true,
          content,
        };
      }
      case FileType.TEXT: {
        const content = await fs.promises.readFile(fullPath, 'utf8');
        return {
          success: true,
          content,
        };
      }
      default: {
        const ext = path.extname(filePath).toLowerCase();
        return {
          success: false,
          error: {
            userError: `Cannot process this file type: ${ext}`,
            llmError: `Cannot process this file type: ${ext}`,
            errorType: ToolExecutionErrorType.ToolInternalError,
          },
        };
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const displayPath = path.relative(repoPath, filePath).replace(/\\/g, '/');
    return {
      success: false,
      error: {
        userError: `Error reading file ${displayPath}: ${errorMessage}`,
        llmError: `Error reading file ${displayPath}: ${errorMessage}`,
        errorType: ToolExecutionErrorType.ToolInternalError,
      },
    };
  }
}

/**
 * Emit mission features notification if session has an active mission.
 * Called after file create/edit operations to keep desktop UI in sync.
 */
export async function emitMissionFeaturesIfApplicable(
  sessionId: string | undefined
): Promise<void> {
  if (!sessionId) return;

  try {
    const missionSessionId =
      getSessionService().getDecompMissionId() ?? sessionId;
    const missionFileService = getMissionFileService(missionSessionId);
    const exists = await missionFileService.missionExists();
    if (!exists) return;

    const featuresFile = await missionFileService.readFeatures();
    if (!featuresFile?.features) return;

    agentEventBus.emit(AgentEvent.ProjectNotification, {
      notification: {
        type: SessionNotificationType.MISSION_FEATURES_CHANGED,
        features: featuresFile.features,
      },
    });
  } catch (error) {
    logWarn(
      '[emitMissionFeaturesIfApplicable] Failed to emit mission features notification',
      { cause: error }
    );
  }
}
