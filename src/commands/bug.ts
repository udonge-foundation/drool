import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException, logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { buildBugReportZip } from '@industry/utils/bugReport';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import { scrubSecrets } from '@industry/utils/secretScrubber';
import { sanitizePathToDirectoryName } from '@industry/utils/sessionPaths';

import {
  SlashCommand,
  CommandContext,
  CommandResult,
  BugReportFile,
} from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import { getSquadSessionTagMetadata } from '@/services/squad/sessionTags';
import {
  getActiveSquad,
  getSquadState,
} from '@/services/squad/SquadStateService';
import type { SquadState } from '@/services/squad/types';
import type { SessionMetadata } from '@/services/types';
import { CliTelemetryClient } from '@/utils/cliTelemetryClient';

import type { CustomModel } from '@industry/common/settings';

const MAX_ZIP_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB (leaving buffer for base64 + JSON overhead)
const COMPRESSION_RATIO_ESTIMATE = 5;
const RAW_SIZE_BUDGET = MAX_ZIP_SIZE_BYTES * COMPRESSION_RATIO_ESTIMATE;
const FALLBACK_LOG_LINES = 100;
const LOG_WINDOW_PREROLL_MS = 5 * 60 * 1000;
const LOG_SIGNAL_CONTEXT_LINES = 8;
const LOG_SESSION_COVERAGE_CONTEXT_LINES = 4;
const LOG_SCORE_THRESHOLD = 45;
const BUG_REPORT_USER_MESSAGE_FALLBACK_MAX_BYTES = 64 * 1024;
const TIMESTAMP_REGEX = /\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\]/;
const HIGH_SIGNAL_KEYWORDS = [
  'error',
  'exception',
  'fatal',
  'failed',
  'timeout',
  'timed out',
  'disconnect',
  'invalid',
];
const WARNING_KEYWORDS = ['warn', 'warning'];
const CONFIG_SIGNAL_KEYWORDS = [
  'byok',
  'provider',
  'model',
  'reasoning',
  'api key',
  'auth',
  'credential',
  'session settings',
  'inherit',
  'override',
  'setting',
];
const MISSION_SIGNAL_KEYWORDS = [
  'mission',
  'worker',
  'validator',
  'validation',
  'orchestrator',
  'handoff',
  'retry',
  'spawn',
];
const MISSION_ARTIFACT_FILES = [
  { name: 'state.json', trimmable: false },
  { name: 'features.json', trimmable: false },
  { name: 'model-settings.json', trimmable: false },
  { name: 'AGENTS.md', trimmable: false },
  { name: 'validation-contract.md', trimmable: false },
  { name: 'validation-state.json', trimmable: false },
  { name: 'services.yaml', trimmable: false },
  { name: 'init.sh', trimmable: false },
  { name: 'canonical-artifact-layout.json', trimmable: false },
  { name: 'progress_log.jsonl', trimmable: true },
] as const;
const OPTIONAL_FILE_DROP_PRIORITIES: Record<string, number> = {
  'squad-state.json': 10,
  'init.sh': 11,
  'services.yaml': 12,
  'AGENTS.md': 13,
  'validation-contract.md': 14,
  'validation-state.json': 15,
  'canonical-artifact-layout.json': 16,
  'model-settings.json': 30,
  'features.json': 40,
  'state.json': 50,
  'byok-config.json': 55,
};

const BYOK_CONFIG_FILE_NAME = 'byok-config.json';
const REDACTED_API_KEY_PLACEHOLDER = '[REDACTED]';

type BugReportSessionContext = {
  sessionId: string;
  sessionFilePath: string;
  sessionSettingsPath: string | null;
  startTime: Date;
  endTime: Date;
};

type BugReportLogSelectionContext = {
  missionId?: string;
  relatedSessionIds: string[];
};

type BugReportTimeWindow = {
  startTime: Date;
  endTime: Date;
};

type CollapsibleLogEntry = {
  line: string;
  timestamp?: string;
};

type BugReportFileDescriptor = {
  name: string;
  filePath: string;
  trimmable: boolean;
};

/**
 * Resolve the squad state for the current session.
 * Prefers the session's squad tag; falls back to the active squad if available.
 */
export async function resolveSquadStateForBugReport(): Promise<SquadState | null> {
  const sessionService = getSessionService();
  const sessionTags = sessionService.getCurrentSessionTags();
  const squadMetadata = getSquadSessionTagMetadata(sessionTags);

  if (squadMetadata) {
    // Session is part of a squad; fetch that squad's state
    return getSquadState(squadMetadata.squadId);
  }

  // Fall back to active squad (orchestrator sessions)
  return getActiveSquad();
}

function parseLogTimestamp(line: string): Date | null {
  const timestampMatch = line.match(TIMESTAMP_REGEX);
  if (!timestampMatch) {
    return null;
  }

  const parsed = new Date(timestampMatch[1]);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getSessionPathsForMetadata(
  session: Pick<SessionMetadata, 'id' | 'cwd'>
): {
  sessionFilePath: string;
  sessionSettingsPath: string;
} {
  const sessionsDir = path.join(
    getIndustryHome(),
    getIndustryDirName(),
    'sessions'
  );
  const sessionDir = session.cwd
    ? path.join(sessionsDir, sanitizePathToDirectoryName(session.cwd))
    : sessionsDir;

  return {
    sessionFilePath: path.join(sessionDir, `${session.id}.jsonl`),
    sessionSettingsPath: path.join(sessionDir, `${session.id}.settings.json`),
  };
}

function getMissionArtifactFileMetadata(
  missionId: string
): BugReportFileDescriptor[] {
  const missionDir = path.join(
    getIndustryHome(),
    getIndustryDirName(),
    'missions',
    missionId
  );

  return MISSION_ARTIFACT_FILES.map((file) => ({
    ...file,
    filePath: path.join(missionDir, file.name),
  }));
}

function isLowSignalHeartbeatLine(line: string): boolean {
  if (!line.includes('heartbeat')) {
    return false;
  }

  if (
    HIGH_SIGNAL_KEYWORDS.some((keyword) => line.includes(keyword)) ||
    WARNING_KEYWORDS.some((keyword) => line.includes(keyword))
  ) {
    return false;
  }

  return true;
}

function buildCollapsedRange(
  count: number,
  label: string,
  firstTimestamp?: string,
  lastTimestamp?: string
): string {
  if (firstTimestamp && lastTimestamp && firstTimestamp !== lastTimestamp) {
    return `[collapsed ${count} ${label} lines from ${firstTimestamp} to ${lastTimestamp}]`;
  }

  if (firstTimestamp) {
    return `[collapsed ${count} ${label} lines at ${firstTimestamp}]`;
  }

  return `[collapsed ${count} ${label} lines]`;
}

export function getOptionalFileDropPriority(
  fileName: string,
  sessionId: string
): number {
  if (fileName.endsWith('.settings.json')) {
    return fileName === `${sessionId}.settings.json` ? 60 : 20;
  }
  if (fileName === 'user-message.txt') return Number.MAX_SAFE_INTEGER;
  return OPTIONAL_FILE_DROP_PRIORITIES[fileName] ?? 70;
}

export function collapseLowSignalLogNoise(lines: string[]): string[] {
  const collapsed: string[] = [];
  let heartbeatGroup: CollapsibleLogEntry[] = [];
  let repeatedEntry: CollapsibleLogEntry | null = null;
  let repeatedKey: string | null = null;
  let repeatedCount = 0;
  let repeatedLastTimestamp: string | undefined;

  const flushHeartbeatGroup = () => {
    if (heartbeatGroup.length === 0) {
      return;
    }

    if (heartbeatGroup.length === 1) {
      collapsed.push(heartbeatGroup[0].line);
    } else {
      collapsed.push(
        buildCollapsedRange(
          heartbeatGroup.length,
          'heartbeat',
          heartbeatGroup[0].timestamp,
          heartbeatGroup.at(-1)?.timestamp
        )
      );
    }

    heartbeatGroup = [];
  };

  const flushRepeatedEntry = () => {
    if (!repeatedEntry) {
      return;
    }

    if (repeatedCount === 1) {
      collapsed.push(repeatedEntry.line);
    } else {
      collapsed.push(
        `${buildCollapsedRange(
          repeatedCount,
          'repeated log',
          repeatedEntry.timestamp,
          repeatedLastTimestamp ?? repeatedEntry.timestamp
        )} ${repeatedEntry.line}`
      );
    }

    repeatedEntry = null;
    repeatedKey = null;
    repeatedCount = 0;
    repeatedLastTimestamp = undefined;
  };

  for (const line of lines) {
    const timestamp = line.match(TIMESTAMP_REGEX)?.[1];
    const lineLower = line.toLowerCase();
    const currentRepeatedKey = line.replace(TIMESTAMP_REGEX, '').trim();

    if (isLowSignalHeartbeatLine(lineLower)) {
      flushRepeatedEntry();
      heartbeatGroup.push({ line, timestamp });
      continue;
    }

    flushHeartbeatGroup();

    if (repeatedEntry !== null && repeatedKey === currentRepeatedKey) {
      repeatedCount += 1;
      repeatedLastTimestamp = timestamp;
      continue;
    }

    flushRepeatedEntry();
    repeatedEntry = { line, timestamp };
    repeatedKey = currentRepeatedKey;
    repeatedCount = 1;
    repeatedLastTimestamp = timestamp;
  }

  flushHeartbeatGroup();
  flushRepeatedEntry();

  return collapsed;
}

function scoreBugReportLogLine(
  line: string,
  selectionContext: BugReportLogSelectionContext
): number {
  const lineLower = line.toLowerCase();
  let score = 0;

  if (HIGH_SIGNAL_KEYWORDS.some((keyword) => lineLower.includes(keyword))) {
    score += 100;
  }
  if (WARNING_KEYWORDS.some((keyword) => lineLower.includes(keyword))) {
    score += 40;
  }
  if (CONFIG_SIGNAL_KEYWORDS.some((keyword) => lineLower.includes(keyword))) {
    score += 55;
  }
  if (MISSION_SIGNAL_KEYWORDS.some((keyword) => lineLower.includes(keyword))) {
    score += 25;
  }
  if (selectionContext.missionId && line.includes(selectionContext.missionId)) {
    score += 70;
  }
  if (
    selectionContext.relatedSessionIds.some((sessionId) =>
      line.includes(sessionId)
    )
  ) {
    score += 65;
  }
  if (isLowSignalHeartbeatLine(lineLower)) {
    score -= 80;
  }

  return score;
}

function addRangeToSelection(
  selectedIndexes: Set<number>,
  index: number,
  radius: number,
  totalLines: number
): void {
  const start = Math.max(0, index - radius);
  const end = Math.min(totalLines - 1, index + radius);
  for (let current = start; current <= end; current += 1) {
    selectedIndexes.add(current);
  }
}

export function selectRelevantLogLines(
  lines: string[],
  selectionContext: BugReportLogSelectionContext
): string[] {
  if (lines.length === 0) {
    return [];
  }

  const normalizedLines = collapseLowSignalLogNoise(lines);
  const selectedIndexes = new Set<number>();
  const lineMatchesBySessionId = new Map<string, number[]>();

  normalizedLines.forEach((line, index) => {
    const score = scoreBugReportLogLine(line, selectionContext);
    if (score >= LOG_SCORE_THRESHOLD) {
      addRangeToSelection(
        selectedIndexes,
        index,
        LOG_SIGNAL_CONTEXT_LINES,
        normalizedLines.length
      );
    }

    for (const sessionId of selectionContext.relatedSessionIds) {
      if (!line.includes(sessionId)) {
        continue;
      }

      const existing = lineMatchesBySessionId.get(sessionId) ?? [];
      existing.push(index);
      lineMatchesBySessionId.set(sessionId, existing);
    }
  });

  for (const sessionId of selectionContext.relatedSessionIds) {
    const indexes = lineMatchesBySessionId.get(sessionId);
    if (!indexes || indexes.length === 0) {
      continue;
    }

    const hasCoverage = indexes.some((index) => selectedIndexes.has(index));
    if (hasCoverage) {
      continue;
    }

    addRangeToSelection(
      selectedIndexes,
      indexes[0],
      LOG_SESSION_COVERAGE_CONTEXT_LINES,
      normalizedLines.length
    );

    const lastIndex = indexes.at(-1);
    if (lastIndex !== undefined && lastIndex !== indexes[0]) {
      addRangeToSelection(
        selectedIndexes,
        lastIndex,
        LOG_SESSION_COVERAGE_CONTEXT_LINES,
        normalizedLines.length
      );
    }
  }

  const tailStart = Math.max(0, normalizedLines.length - FALLBACK_LOG_LINES);
  for (let index = tailStart; index < normalizedLines.length; index += 1) {
    selectedIndexes.add(index);
  }

  if (selectedIndexes.size === 0) {
    return normalizedLines.slice(-FALLBACK_LOG_LINES);
  }

  return normalizedLines.filter((_, index) => selectedIndexes.has(index));
}

/**
 * Get session start time from session file by reading only the first line.
 */
async function getSessionStartTime(sessionFilePath: string): Promise<Date> {
  try {
    if (!fs.existsSync(sessionFilePath)) {
      return new Date();
    }

    const fileStream = fs.createReadStream(sessionFilePath, {
      encoding: 'utf-8',
    });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let firstLine: string | null = null;
    try {
      const iterator = rl[Symbol.asyncIterator]();
      const { value = null } = await iterator.next();
      firstLine = value;
    } finally {
      rl.close();
      fileStream.destroy();
    }

    if (!firstLine) {
      const stats = fs.statSync(sessionFilePath);
      return stats.birthtime || stats.ctime;
    }

    // Try first line for session_start event
    try {
      const firstEvent = JSON.parse(firstLine);
      if (firstEvent.type === 'session_start' && firstEvent.timestamp) {
        return new Date(firstEvent.timestamp);
      }
      if (firstEvent.timestamp) {
        return new Date(firstEvent.timestamp);
      }
    } catch (_e) {
      // Ignore parse errors, try fallback
    }

    // Fallback to file stats
    const stats = fs.statSync(sessionFilePath);
    return stats.birthtime || stats.ctime;
  } catch (_error) {
    // Ultimate fallback
    return new Date();
  }
}

function getSessionEndTime(
  sessionFilePath: string,
  fallbackEndTime?: Date
): Date {
  try {
    if (!fs.existsSync(sessionFilePath)) {
      return fallbackEndTime ?? new Date();
    }

    const stats = fs.statSync(sessionFilePath);
    return stats.mtime || stats.ctime || fallbackEndTime || new Date();
  } catch {
    return fallbackEndTime ?? new Date();
  }
}

function appendBugReportFileIfExists(
  files: BugReportFile[],
  descriptor: BugReportFileDescriptor
): void {
  if (!fs.existsSync(descriptor.filePath)) {
    return;
  }

  files.push({
    name: descriptor.name,
    content: fs.readFileSync(descriptor.filePath, 'utf-8'),
    trimmable: descriptor.trimmable,
  });
}

export async function getBugReportRelatedSessions(
  sessionId: string,
  sessionFilePath: string,
  sessionSettingsPath: string | null
): Promise<{
  missionId?: string;
  relatedSessions: BugReportSessionContext[];
}> {
  const sessionService = getSessionService() as ReturnType<
    typeof getSessionService
  > & {
    getDecompMissionId?: () => string | undefined;
    getCurrentSessionCwd?: () => string | undefined;
    getAllSessions?: (options?: {
      currentCwd?: string;
      fetchOutsideCWD?: boolean;
      maxOtherSessions?: number;
    }) => Promise<SessionMetadata[]>;
  };
  const missionId = sessionService.getDecompMissionId?.();
  const currentSessionCwd = sessionService.getCurrentSessionCwd?.();
  const relatedSessionMetadata = new Map<
    string,
    {
      sessionFilePath: string;
      sessionSettingsPath: string | null;
      fallbackEndTime?: Date;
    }
  >();

  relatedSessionMetadata.set(sessionId, {
    sessionFilePath,
    sessionSettingsPath,
  });

  if (missionId && sessionService.getAllSessions) {
    try {
      const sessions = await sessionService.getAllSessions({
        currentCwd: currentSessionCwd,
        fetchOutsideCWD: true,
      });

      for (const session of sessions) {
        const belongsToMission =
          session.id === missionId || session.decompMissionId === missionId;
        if (!belongsToMission) {
          continue;
        }

        const paths = getSessionPathsForMetadata(session);
        relatedSessionMetadata.set(session.id, {
          sessionFilePath: paths.sessionFilePath,
          sessionSettingsPath: paths.sessionSettingsPath,
          fallbackEndTime: session.modifiedTime,
        });
      }
    } catch (error) {
      logWarn('[bug] Failed to resolve related mission sessions', {
        cause: error,
      });
    }
  }

  const relatedSessions = await Promise.all(
    Array.from(relatedSessionMetadata.entries()).map(
      async ([relatedSessionId, metadata]) => ({
        sessionId: relatedSessionId,
        sessionFilePath: metadata.sessionFilePath,
        sessionSettingsPath: metadata.sessionSettingsPath,
        startTime: await getSessionStartTime(metadata.sessionFilePath),
        endTime: getSessionEndTime(
          metadata.sessionFilePath,
          metadata.fallbackEndTime
        ),
      })
    )
  );

  return { missionId, relatedSessions };
}

function getBugReportTimeWindow(
  relatedSessions: BugReportSessionContext[]
): BugReportTimeWindow {
  const startTimeMs = Math.min(
    ...relatedSessions.map((session) => session.startTime.getTime())
  );
  const endTimeMs = Math.max(
    ...relatedSessions.map((session) => session.endTime.getTime())
  );

  return {
    startTime: new Date(startTimeMs - LOG_WINDOW_PREROLL_MS),
    endTime: new Date(endTimeMs),
  };
}

/**
 * Filter log file by a mission/session time window and keep the highest-signal
 * slices, plus a compact recent tail.
 * Only reads the tail of the file (up to RAW_SIZE_BUDGET bytes) to bound
 * memory usage regardless of total file size.
 */
async function filterLogsByTimeWindow(
  logFilePath: string,
  timeWindow: BugReportTimeWindow,
  selectionContext: BugReportLogSelectionContext
): Promise<string | null> {
  try {
    if (!fs.existsSync(logFilePath)) {
      return null;
    }

    const filteredLines: string[] = [];
    let shouldIncludeUntimestampedLine = false;

    // Only read the tail of large files to cap memory usage
    const fileSize = fs.statSync(logFilePath).size;
    const start = Math.max(0, fileSize - RAW_SIZE_BUDGET);
    const fileStream = fs.createReadStream(logFilePath, {
      encoding: 'utf-8',
      start,
      end: fileSize - 1,
    });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let isFirstLine = start > 0;
    try {
      for await (const line of rl) {
        // Skip the first line when reading from an offset -- it's likely a partial line
        if (isFirstLine) {
          isFirstLine = false;
          continue;
        }

        if (!line.trim()) {
          continue;
        }

        const logTime = parseLogTimestamp(line);
        if (logTime) {
          shouldIncludeUntimestampedLine =
            logTime >= timeWindow.startTime && logTime <= timeWindow.endTime;

          if (shouldIncludeUntimestampedLine) {
            filteredLines.push(line);
          }
        } else if (shouldIncludeUntimestampedLine) {
          filteredLines.push(line);
        }
      }
    } finally {
      rl.close();
      fileStream.destroy();
    }

    if (filteredLines.length === 0) {
      return `[No logs found in selected time window (${timeWindow.startTime.toISOString()} to ${timeWindow.endTime.toISOString()})]`;
    }

    const selectedLines = selectRelevantLogLines(
      filteredLines,
      selectionContext
    );

    if (selectedLines.length === 0) {
      return null;
    }

    return selectedLines.join('\n');
  } catch (_error) {
    return null;
  }
}

/**
 * Trim content to fit within maxBytes by keeping the tail (most recent lines).
 */
export function trimToTail(content: string, maxBytes: number): string {
  const contentBytes = Buffer.byteLength(content, 'utf-8');
  if (contentBytes <= maxBytes) return content;

  const lines = content.split('\n');
  const keptLines: string[] = [];
  let currentBytes = 0;
  // Reserve space for the marker line
  const markerReserve = 80;
  const availableBytes = Math.max(0, maxBytes - markerReserve);

  for (let i = lines.length - 1; i >= 0; i--) {
    const lineBytes = Buffer.byteLength(`${lines[i]}\n`, 'utf-8');
    if (currentBytes + lineBytes > availableBytes) break;
    keptLines.unshift(lines[i]);
    currentBytes += lineBytes;
  }

  const trimmedLineCount = lines.length - keptLines.length;
  if (trimmedLineCount === 0) return content;

  return `[TRIMMED: removed ${trimmedLineCount} lines to fit size limit]\n${keptLines.join('\n')}`;
}

export function getBudgetRatio(
  fileName: string,
  includesSessionFile: boolean
): number {
  if (includesSessionFile) {
    if (fileName === 'drool-log.log' || fileName === 'industryd.log') {
      return 0.5;
    }
    if (fileName === 'console.log') return 0.2;
    return 0.3; // session jsonl
  }
  if (fileName === 'drool-log.log' || fileName === 'industryd.log') {
    return 0.8;
  }
  return 0.2; // console.log
}

function isSessionTranscriptFile(fileName: string): boolean {
  return fileName.endsWith('.jsonl') && fileName !== 'progress_log.jsonl';
}

/**
 * Trim trimmable files to fit within the given raw byte budget.
 * Budget weights are normalized across the trimmable files present.
 * Unused budget from small files redistributes proportionally.
 */
export function trimFilesToBudget(
  files: BugReportFile[],
  budgetBytes: number
): void {
  let reservedBytes = 0;
  for (const file of files) {
    if (!file.trimmable) {
      reservedBytes += Buffer.byteLength(file.content, 'utf-8');
    }
  }

  const trimmableBudget = Math.max(0, budgetBytes - reservedBytes);
  const trimmableFiles = files.filter((f) => f.trimmable);
  if (trimmableFiles.length === 0) return;

  const includesSessionFile = trimmableFiles.some((f) =>
    isSessionTranscriptFile(f.name)
  );
  const totalWeight = trimmableFiles.reduce(
    (sum, file) => sum + getBudgetRatio(file.name, includesSessionFile),
    0
  );

  // First pass: calculate initial allocations and reclaim unused budget
  const allocations = new Map<string, number>();
  let totalUnusedBudget = 0;
  let totalRatioOfOversize = 0;

  for (const file of trimmableFiles) {
    const ratio = getBudgetRatio(file.name, includesSessionFile);
    const allocation =
      totalWeight > 0 ? (trimmableBudget * ratio) / totalWeight : 0;
    const fileSize = Buffer.byteLength(file.content, 'utf-8');

    if (fileSize <= allocation) {
      allocations.set(file.name, fileSize);
      totalUnusedBudget += allocation - fileSize;
    } else {
      allocations.set(file.name, allocation);
      totalRatioOfOversize += ratio;
    }
  }

  // Second pass: redistribute unused budget proportionally to oversize files
  if (totalUnusedBudget > 0 && totalRatioOfOversize > 0) {
    for (const file of trimmableFiles) {
      const fileSize = Buffer.byteLength(file.content, 'utf-8');
      const currentAllocation = allocations.get(file.name) ?? 0;
      if (fileSize > currentAllocation) {
        const ratio = getBudgetRatio(file.name, includesSessionFile);
        const extraBudget = totalUnusedBudget * (ratio / totalRatioOfOversize);
        allocations.set(file.name, currentAllocation + extraBudget);
      }
    }
  }

  // Apply trimming
  for (const file of trimmableFiles) {
    const maxBytes = allocations.get(file.name) ?? 0;
    const originalSize = Buffer.byteLength(file.content, 'utf-8');
    if (originalSize > maxBytes) {
      file.content = trimToTail(file.content, maxBytes);
      logInfo('[bug] Trimmed file to fit budget', {
        fileName: file.name,
        originalSize,
        sizeBytes: Buffer.byteLength(file.content, 'utf-8'),
        size: maxBytes,
      });
    }
  }
}

/**
 * Scrub secrets from all bug report files except user-message.txt.
 * Settings files are always small so scrubbing is safe; trimmable files
 * should be trimmed first to avoid running expensive regex on huge content.
 */
export function scrubFilesContent(files: BugReportFile[]): void {
  for (const file of files) {
    if (file.name !== 'user-message.txt') {
      file.content = scrubSecrets(file.content);
    }
  }
}

/**
 * Build the JSON content for the BYOK config file included in bug reports.
 * Uses the fully resolved custom models from the settings hierarchy (org,
 * runtime, folder, project, user) so the config reflects exactly what the
 * CLI uses at runtime, even when multiple levels contribute entries.
 *
 * Only the `apiKey` field is redacted -- every other BYOK field is preserved
 * because it's useful for debugging configuration issues. `extraHeaders` and
 * `extraArgs` may still contain user-provided secrets; those are cleaned up
 * by the downstream scrubSecrets() pass on all bug report files.
 */
export function buildRedactedByokConfigContent(
  customModels: CustomModel[] | undefined
): string | null {
  if (!customModels || customModels.length === 0) {
    return null;
  }

  const redactedModels = customModels.map((model) => ({
    ...model,
    apiKey: REDACTED_API_KEY_PLACEHOLDER,
  }));

  return JSON.stringify({ customModels: redactedModels }, null, 2);
}

/**
 * Collect all bug report file contents into a structured list.
 * Returns raw (unscrubbed) content for trimmable files -- callers must
 * trim first, then call scrubFilesContent() before zipping.
 */
function collectBugReportFiles(
  sessionId: string,
  sessionFilePath: string,
  sessionSettingsPath: string | null,
  filteredDroolLogs: string | null,
  filteredIndustrydLogs: string | null,
  filteredConsoleLogs: string | null,
  userComment: string | undefined,
  isInternalOrg: boolean | undefined,
  clientLogs?: string,
  squadState?: SquadState | null,
  relatedSessions?: BugReportSessionContext[],
  missionId?: string,
  customModels?: CustomModel[]
): BugReportFile[] {
  const files: BugReportFile[] = [];

  if (userComment?.trim()) {
    files.push({
      name: 'user-message.txt',
      content: userComment,
      trimmable: false,
    });
  }

  const sessionSettingsFiles = new Map<string, string>();
  if (sessionSettingsPath) {
    sessionSettingsFiles.set(sessionId, sessionSettingsPath);
  }
  for (const relatedSession of relatedSessions ?? []) {
    if (relatedSession.sessionSettingsPath) {
      sessionSettingsFiles.set(
        relatedSession.sessionId,
        relatedSession.sessionSettingsPath
      );
    }
  }

  for (const [settingsSessionId, settingsPath] of sessionSettingsFiles) {
    appendBugReportFileIfExists(files, {
      name: `${settingsSessionId}.settings.json`,
      filePath: settingsPath,
      trimmable: false,
    });
  }

  const byokConfigContent = buildRedactedByokConfigContent(customModels);
  if (byokConfigContent) {
    files.push({
      name: BYOK_CONFIG_FILE_NAME,
      content: byokConfigContent,
      trimmable: false,
    });
  }

  const includeSessionFile =
    process.env.INDUSTRY_ENV === 'development' || isInternalOrg;

  // Include squad state with same privacy rule as session transcript
  if (includeSessionFile && squadState) {
    files.push({
      name: 'squad-state.json',
      content: JSON.stringify(squadState, null, 2),
      trimmable: false,
    });
  }

  if (includeSessionFile && fs.existsSync(sessionFilePath)) {
    appendBugReportFileIfExists(files, {
      name: `${sessionId}.jsonl`,
      filePath: sessionFilePath,
      trimmable: true,
    });
  }

  if (missionId) {
    for (const missionFile of getMissionArtifactFileMetadata(missionId)) {
      appendBugReportFileIfExists(files, missionFile);
    }
  }

  if (filteredDroolLogs) {
    files.push({
      name: 'drool-log.log',
      content: filteredDroolLogs,
      trimmable: true,
    });
  }

  if (filteredIndustrydLogs) {
    files.push({
      name: 'industryd.log',
      content: filteredIndustrydLogs,
      trimmable: true,
    });
  }

  if (filteredConsoleLogs) {
    files.push({
      name: 'console.log',
      content: filteredConsoleLogs,
      trimmable: true,
    });
  }

  if (clientLogs?.trim()) {
    files.push({
      name: 'browser-console.log',
      content: clientLogs,
      trimmable: true,
    });
  }

  // Best-effort: include desktop startup logs if readable (small file, max 20 entries)
  try {
    const industryHome = getIndustryHome();
    const desktopStartupsPath = path.join(
      industryHome,
      getIndustryDirName(),
      'logs',
      'desktop-startups.log'
    );
    if (fs.existsSync(desktopStartupsPath)) {
      const startupContent = fs.readFileSync(desktopStartupsPath, 'utf-8');
      if (startupContent.trim()) {
        files.push({
          name: 'desktop-startups.log',
          content: startupContent,
          trimmable: false,
        });
      }
    }
  } catch {
    // Non-fatal: skip desktop startup logs if unreadable
  }

  return files;
}

/**
 * Build a zip buffer from a list of files.
 */
function buildZipFromFiles(files: BugReportFile[]): Buffer {
  const zipData = buildBugReportZip(files);
  return Buffer.from(zipData.buffer, zipData.byteOffset, zipData.byteLength);
}

async function ensureZipWithinLimit(
  files: BugReportFile[],
  sessionId: string
): Promise<Buffer> {
  let candidateFiles = [...files];
  let zipBuffer = await buildZipFromFiles(candidateFiles);

  if (zipBuffer.length <= MAX_ZIP_SIZE_BYTES) {
    return zipBuffer;
  }

  const droppableFiles = [...candidateFiles]
    .filter((file) => file.name !== 'user-message.txt')
    .sort(
      (left, right) =>
        getOptionalFileDropPriority(left.name, sessionId) -
        getOptionalFileDropPriority(right.name, sessionId)
    );

  for (const fileToDrop of droppableFiles) {
    candidateFiles = candidateFiles.filter((file) => file !== fileToDrop);
    logWarn('[bug] Zip still exceeds limit, dropping optional file', {
      fileName: fileToDrop.name,
      sizeBytes: zipBuffer.length,
    });

    zipBuffer = await buildZipFromFiles(candidateFiles);
    if (zipBuffer.length <= MAX_ZIP_SIZE_BYTES) {
      return zipBuffer;
    }
  }

  const userMessageFile = files.find(
    (file) => file.name === 'user-message.txt'
  );
  if (userMessageFile) {
    zipBuffer = await buildZipFromFiles([
      {
        ...userMessageFile,
        content: trimToTail(
          userMessageFile.content,
          BUG_REPORT_USER_MESSAGE_FALLBACK_MAX_BYTES
        ),
      },
    ]);
  }

  return zipBuffer;
}

/**
 * Create a zip buffer from bug report files, trimming content if needed to stay within size limits.
 * Order: collect raw -> trim to budget -> scrub secrets -> zip.
 * This ensures scrubSecrets() never processes more than ~20MB of content.
 */
export async function createZipBuffer(
  sessionId: string,
  sessionFilePath: string,
  sessionSettingsPath: string | null,
  droolLogPath: string,
  consoleLogPath: string,
  industrydLogPath?: string,
  userComment?: string,
  isInternalOrg?: boolean,
  clientLogs?: string,
  squadState?: SquadState | null,
  relatedSessions?: BugReportSessionContext[],
  missionId?: string
): Promise<Buffer> {
  const effectiveRelatedSessions =
    relatedSessions && relatedSessions.length > 0
      ? relatedSessions
      : [
          {
            sessionId,
            sessionFilePath,
            sessionSettingsPath,
            startTime: await getSessionStartTime(sessionFilePath),
            endTime: getSessionEndTime(sessionFilePath),
          },
        ];
  const timeWindow = getBugReportTimeWindow(effectiveRelatedSessions);
  const selectionContext: BugReportLogSelectionContext = {
    missionId,
    relatedSessionIds: effectiveRelatedSessions.map(
      (relatedSession) => relatedSession.sessionId
    ),
  };

  const [filteredDroolLogs, filteredConsoleLogs, filteredIndustrydLogs] =
    await Promise.all([
      filterLogsByTimeWindow(droolLogPath, timeWindow, selectionContext),
      filterLogsByTimeWindow(consoleLogPath, timeWindow, selectionContext),
      industrydLogPath
        ? filterLogsByTimeWindow(industrydLogPath, timeWindow, selectionContext)
        : Promise.resolve(null),
    ]);

  // Capture the fully-resolved BYOK config (after merging across org,
  // runtime, folder, project, and user hierarchy levels) so the bug report
  // reflects the models Drool actually loaded. Failures here are non-fatal.
  let customModels: CustomModel[] | undefined;
  try {
    customModels = getSettingsService().getCustomModels();
  } catch (error) {
    logWarn('[bug] Failed to resolve BYOK custom models for bug report', {
      cause: error,
    });
  }

  const files = collectBugReportFiles(
    sessionId,
    sessionFilePath,
    sessionSettingsPath,
    filteredDroolLogs,
    filteredIndustrydLogs,
    filteredConsoleLogs,
    userComment,
    isInternalOrg,
    clientLogs,
    squadState,
    effectiveRelatedSessions,
    missionId,
    customModels
  );

  // Trim first (cheap) so scrubSecrets never processes huge content
  trimFilesToBudget(files, RAW_SIZE_BUDGET);

  // Scrub secrets only on already-trimmed content
  scrubFilesContent(files);

  let zipBuffer = await buildZipFromFiles(files);

  // Safety net: if zip still exceeds limit, trim more aggressively
  if (zipBuffer.length > MAX_ZIP_SIZE_BYTES) {
    logWarn(
      '[bug] Zip exceeds limit after initial trim, retrying with halved budget',
      { sizeBytes: zipBuffer.length }
    );
    trimFilesToBudget(files, RAW_SIZE_BUDGET / 2);
    zipBuffer = await buildZipFromFiles(files);
  }

  // Last resort: drop all trimmable files, send only essential metadata
  if (zipBuffer.length > MAX_ZIP_SIZE_BYTES) {
    logWarn('[bug] Zip still exceeds limit, dropping trimmable files', {
      sizeBytes: zipBuffer.length,
    });
    const essentialFiles = files.filter((f) => !f.trimmable);
    zipBuffer = await ensureZipWithinLimit(essentialFiles, sessionId);
  }

  if (zipBuffer.length > MAX_ZIP_SIZE_BYTES) {
    throw new MetaError('Bug report data is too large after reduction', {
      value: {
        sizeBytes: zipBuffer.length,
        maxSizeBytes: MAX_ZIP_SIZE_BYTES,
      },
    });
  }

  return zipBuffer;
}

// eslint-disable-next-line industry/constants-file-organization
export const bugCommand: SlashCommand = {
  name: 'bug',
  description:
    'Create a bug report by uploading session data and logs to Industry',

  execute: async (
    args: string[],
    context: CommandContext,
    rawArgs?: string
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage, submitBugReport } = context;

    // Prefer rawArgs to avoid shell-quote operator stringification
    const comment = (rawArgs ?? args.join(' ')).trim();
    if (!comment) {
      return {
        handled: true,
        shouldRunAgent: false,
        insertText: '/bug ',
      };
    }

    try {
      // Check for active session first (needed by both daemon and local paths)
      const sessionService = getSessionService();
      const currentSessionId = sessionService.getCurrentSessionId();

      if (!currentSessionId) {
        addEphemeralSystemMessage(
          getI18n().t('commands:slashMessages.noActiveSession'),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        return { handled: true, shouldRunAgent: false };
      }

      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.creatingBugReport'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );

      // In daemon mode, delegate to the daemon via stream-jsonrpc.
      // If the daemon call fails (disconnected, IPC unavailable, request
      // errors) fall back to running the local bug-report submit path so the
      // user still gets a report instead of a generic failure.
      let daemonFailed = false;
      if (submitBugReport) {
        try {
          await CliTelemetryClient.getInstance().forceFlush();
        } catch (flushError) {
          logException(
            flushError,
            '[bug] Failed to flush logs before JSONRPC request'
          );
        }

        try {
          const result = await submitBugReport(comment);

          addEphemeralSystemMessage(
            getI18n().t('commands:slashMessages.bugReportSuccess', {
              id: result.bugReportId,
            }),
            {
              messageType: MessageType.SystemNotification,
              visibility: MessageVisibility.UserOnly,
            }
          );

          return { handled: true, shouldRunAgent: false };
        } catch (daemonError) {
          daemonFailed = true;
          logException(
            daemonError,
            '[bug] Daemon submit failed, falling back to local submit'
          );
        }
      }

      // Local submit path -- either no daemon adapter is wired, or the
      // daemon path failed above. The shared submitBugReport helper handles
      // log flushing, zipping, and uploading.
      const sessionFilePath = sessionService.getSessionTranscriptPath();
      if (!sessionFilePath) {
        addEphemeralSystemMessage(
          getI18n().t('commands:slashMessages.sessionFileNotFound'),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        return { handled: true, shouldRunAgent: false };
      }

      // Dynamic import avoids a module-load-time circular dependency with
      // submitBugReport.ts (which imports helpers from this file).
      const { submitBugReport: localSubmitBugReport } = await import(
        '@/commands/bug/submitBugReport'
      );
      const result = await localSubmitBugReport(comment);

      if (daemonFailed) {
        logInfo('[bug] Local fallback succeeded', {
          bugReportId: result.bugReportId,
        });
      }

      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.bugReportSuccess', {
          id: result.bugReportId,
        }),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );

      return { handled: true, shouldRunAgent: false };
    } catch (error) {
      logException(error, '[bug] Failed to create bug report');

      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.bugReportFailed'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );

      return { handled: true, shouldRunAgent: false };
    }
  },
};
