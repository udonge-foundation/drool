import fs from 'fs/promises';
import path from 'path';

import { FileOperation } from '@industry/drool-core/tools/utils';
import { FileEditResult } from '@industry/drool-core/tools/utils/types';
import { SandboxOperationType } from '@industry/drool-sdk-ext/protocol/drool';

import { getFileTimestampTracker } from '@/services/FileTimestampTracker';
import { getSandboxService } from '@/services/SandboxService';
import { CustomerMetrics } from '@/telemetry/customer/CustomerMetrics';
import { AttributeName, MetricName } from '@/telemetry/customer/enums';
import { generateUnifiedDiff } from '@/utils/diff-utils';

// macOS screenshots: replace space before AM/PM with non-breaking space
export function normalizeMacScreenshotPath(filePath: string): string {
  return filePath.replace(' PM', '\u202FPM').replace(' AM', '\u202FAM');
}

// Track which files have been read or created in this session
const readFiles = new Set<string>();
const createdFiles = new Set<string>();

type FileGroundTruthKind = 'missing' | 'file' | 'directory';

type FileGroundTruth = {
  absolutePath: string;
  kind: FileGroundTruthKind;
  wasRead: boolean;
  wasCreated: boolean;
};

function hasErrnoCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  );
}

function clearTrackedFileState(filePath: string): void {
  const absolutePath = path.resolve(filePath);
  readFiles.delete(absolutePath);
  createdFiles.delete(absolutePath);
}

export function trackReadFile(filePath: string, toolCallId?: string): void {
  const absolutePath = path.resolve(filePath);
  readFiles.add(absolutePath);

  // Also track timestamp if toolCallId is provided
  if (toolCallId) {
    void getFileTimestampTracker().trackFileRead(absolutePath, toolCallId);
  }

  // Customer telemetry: Track file read
  const fileExtension = path.extname(absolutePath);
  CustomerMetrics.addToCounter(MetricName.CODE_FILES_READ, 1, {
    [AttributeName.FILE_EXTENSION]: fileExtension,
  });
}

function trackCreatedFile(filePath: string, toolCallId?: string): void {
  const absolutePath = path.resolve(filePath);
  createdFiles.add(absolutePath);

  // Also track timestamp if toolCallId is provided
  if (toolCallId) {
    void getFileTimestampTracker().trackFileWrite(
      absolutePath,
      toolCallId,
      'create'
    );
  }
}

function hasFileBeenRead(filePath: string): boolean {
  const absolutePath = path.resolve(filePath);
  return readFiles.has(absolutePath);
}

function hasFileBeenCreated(filePath: string): boolean {
  const absolutePath = path.resolve(filePath);
  return createdFiles.has(absolutePath);
}

export async function resolveFileGroundTruth(
  filePath: string
): Promise<FileGroundTruth> {
  const absolutePath = path.resolve(filePath);
  const wasRead = hasFileBeenRead(absolutePath);
  const wasCreated = hasFileBeenCreated(absolutePath);

  try {
    const stats = await fs.stat(absolutePath);
    return {
      absolutePath,
      kind: stats.isDirectory() ? 'directory' : 'file',
      wasRead,
      wasCreated,
    };
  } catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) {
      if (wasRead || wasCreated) {
        clearTrackedFileState(absolutePath);
      }

      return {
        absolutePath,
        kind: 'missing',
        wasRead,
        wasCreated,
      };
    }

    throw error;
  }
}

export async function validateFileForCreate(
  filePath: string
): Promise<FileEditResult> {
  if (!filePath || typeof filePath !== 'string') {
    return {
      success: false,
      message: `Error creating file: Invalid file path provided (received: ${typeof filePath})`,
    };
  }

  const fileGroundTruth = await resolveFileGroundTruth(filePath);

  if (fileGroundTruth.kind === 'directory') {
    return {
      success: false,
      message: `Error: Cannot create file at "${filePath}" because a directory already exists there.`,
    };
  }

  // Both 'missing' and 'file' are acceptable: Create overwrites existing files.
  return { success: true, message: fileGroundTruth.absolutePath };
}

export async function validateFileForEdit(
  filePath: string,
  toolCallId?: string
): Promise<FileEditResult> {
  if (!filePath || typeof filePath !== 'string') {
    return {
      success: false,
      message: `Error editing file: Invalid file path provided (received: ${typeof filePath})`,
    };
  }

  const fileGroundTruth = await resolveFileGroundTruth(filePath);

  if (fileGroundTruth.kind === 'directory') {
    return {
      success: false,
      message: `Error: Path "${filePath}" is a directory and cannot be edited.`,
    };
  }

  if (fileGroundTruth.kind === 'missing') {
    if (fileGroundTruth.wasRead || fileGroundTruth.wasCreated) {
      return {
        success: false,
        message: `Error: File "${filePath}" does not exist.`,
      };
    }

    return {
      success: false,
      message: `Error: Cannot edit file that has not been read first. Please use the Read tool on "${filePath}" before attempting to edit it.`,
    };
  }

  // Check if file was read or created before editing
  if (!fileGroundTruth.wasRead && !fileGroundTruth.wasCreated) {
    trackReadFile(filePath, toolCallId);
    return { success: true, message: fileGroundTruth.absolutePath };
  }

  // Check if the file has been modified externally since last access
  const hasChanged = await getFileTimestampTracker().hasFileChangedExternally(
    fileGroundTruth.absolutePath
  );
  if (hasChanged) {
    return {
      success: false,
      message: `Error: File "${filePath}" has been modified externally since it was last read. Please use the Read tool to get the latest version before editing.`,
    };
  }

  return { success: true, message: fileGroundTruth.absolutePath };
}

export async function readFileContent(
  filePath: string
): Promise<{ content?: string; error?: string; exists?: boolean }> {
  const fileGroundTruth = await resolveFileGroundTruth(filePath);

  if (fileGroundTruth.kind === 'missing') {
    return {
      error: `Error: File "${filePath}" does not exist.`,
      exists: false,
    };
  }

  if (fileGroundTruth.kind === 'directory') {
    return {
      error: `Error: Path "${filePath}" is a directory.`,
      exists: true,
    };
  }

  try {
    const content = await fs.readFile(fileGroundTruth.absolutePath, 'utf-8');
    return { content, exists: true };
  } catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) {
      clearTrackedFileState(fileGroundTruth.absolutePath);
      return {
        error: `Error: File "${filePath}" does not exist.`,
        exists: false,
      };
    }
    return {
      error: `Error reading file for edit: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

export async function writeFileContent(params: {
  filePath: string;
  content: string;
  toolCallId?: string;
  ensureTrailingNewline?: boolean;
}): Promise<FileEditResult & { oldContent?: string; wasNewFile?: boolean }> {
  const {
    filePath,
    content,
    toolCallId,
    ensureTrailingNewline = false,
  } = params;

  try {
    const fileGroundTruth = await resolveFileGroundTruth(filePath);

    if (fileGroundTruth.kind === 'directory') {
      return {
        success: false,
        message: `Error writing file: Path "${filePath}" is a directory.`,
      };
    }

    const isNewFile = fileGroundTruth.kind === 'missing';
    let oldContent = '';
    if (!isNewFile) {
      oldContent = await fs.readFile(fileGroundTruth.absolutePath, 'utf-8');
    } else {
      // If it's a new file, ensure parent directories exist
      const parentDir = path.dirname(fileGroundTruth.absolutePath);
      try {
        await fs.access(parentDir);
      } catch {
        // Parent directory doesn't exist, create it recursively
        await fs.mkdir(parentDir, { recursive: true });
      }
    }

    // New files should have trailing newline by convention.
    // CreateCliExecutor can also opt into this for overwrite flows.
    let contentToWrite = content;
    if ((isNewFile || ensureTrailingNewline) && !content.endsWith('\n')) {
      contentToWrite = `${content}\n`;
    }

    await fs.writeFile(fileGroundTruth.absolutePath, contentToWrite, 'utf-8');

    // Touch trigger file so embedded VS Code SCM view refreshes.
    // Written inside .git/ so it doesn't appear as an untracked file.
    // Best-effort and not user-requested, so honor the sandbox write policy
    // silently (no prompt): skip when a policy denies writes to .git/.
    const gitDir = path.join(process.cwd(), '.git');
    const triggerPath = path.join(gitDir, '.industry-scm-trigger');
    const sandboxService = getSandboxService();
    const triggerDenied =
      sandboxService.isEnabled() &&
      sandboxService.checkFileAccess(
        triggerPath,
        SandboxOperationType.Write
      ) !== null;
    if (!triggerDenied) {
      fs.access(gitDir).then(
        () =>
          fs
            .writeFile(triggerPath, String(Date.now()), 'utf-8')
            .catch(() => {}),
        () => {}
      );
    }

    // Calculate actual line changes using proper diff algorithm
    const diffLines = generateUnifiedDiff(oldContent, contentToWrite, 0);
    const linesAdded = diffLines.filter((line) => line.type === 'added').length;
    const linesRemoved = diffLines.filter(
      (line) => line.type === 'removed'
    ).length;

    // Track file write operation with timestamp
    if (toolCallId) {
      await getFileTimestampTracker().trackFileWrite(
        fileGroundTruth.absolutePath,
        toolCallId,
        isNewFile ? 'create' : 'edit'
      );
    }

    // Track newly created files
    if (isNewFile) {
      trackCreatedFile(fileGroundTruth.absolutePath, toolCallId);
    }

    // Customer telemetry: Track file modifications
    const fileExtension = path.extname(fileGroundTruth.absolutePath);
    const operation = isNewFile ? FileOperation.Create : FileOperation.Update;

    CustomerMetrics.addToCounter(MetricName.CODE_FILES_MODIFIED, 1, {
      [AttributeName.OPERATION]: operation,
      [AttributeName.FILE_EXTENSION]: fileExtension,
    });

    // Customer telemetry: Track lines modified
    if (linesAdded > 0) {
      CustomerMetrics.addToCounter(MetricName.CODE_LINES_MODIFIED, linesAdded, {
        [AttributeName.OPERATION]: 'added',
        [AttributeName.FILE_EXTENSION]: fileExtension,
      });
    }
    if (linesRemoved > 0) {
      CustomerMetrics.addToCounter(
        MetricName.CODE_LINES_MODIFIED,
        linesRemoved,
        {
          [AttributeName.OPERATION]: 'removed',
          [AttributeName.FILE_EXTENSION]: fileExtension,
        }
      );
    }

    return {
      success: true,
      message: `File ${isNewFile ? 'created' : 'edited'} successfully: ${fileGroundTruth.absolutePath}`,
      wasNewFile: isNewFile,
      // Only expose prior content for overwrites so callers can snapshot it
      // for rewind. No content is retained for fresh creates.
      ...(isNewFile ? {} : { oldContent }),
    };
  } catch (error) {
    return {
      success: false,
      message: `Error writing file: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}
