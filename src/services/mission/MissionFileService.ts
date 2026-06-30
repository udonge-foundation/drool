import { readFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';

import { v4 as uuidv4 } from 'uuid';

import {
  FeatureStatus,
  ProgressLogEntryType,
  MissionState,
  SessionNotificationType,
} from '@industry/drool-sdk-ext/protocol/drool';
import { SkillLocation } from '@industry/drool-sdk-ext/protocol/settings';
import { logInfo, logWarn, Metric, Metrics } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { loadSkillFile } from '@industry/utils/frontmatter';
import {
  extractMissionTitleFromMarkdown,
  readMissionArtifactMetadataForSession,
} from '@industry/utils/mission';

import { AgentEvent, agentEventBus } from '@/events/AgentEventBus';
import { getCloudSyncService } from '@/services/CloudSyncService';
import { MAX_FEATURE_ATTEMPTS } from '@/services/mission/constants';
import {
  getEffectiveMaxFeatureAttempts,
  getFeatureAttemptCount,
} from '@/services/mission/retryBudget';
import { HandoffEntrySchema } from '@/services/mission/schemas';
import {
  ArtifactLayoutMarker,
  Feature,
  FeaturesFile,
  Handoff,
  HandoffEntry,
  ProgressLogEntry,
  MissionStateFile,
  WorkerCompletedEntry,
  WorkerFailedEntry,
  WorkerPausedEntry,
  WorkerStartedEntry,
} from '@/services/mission/types';
import { getSettingsService } from '@/services/SettingsService';
import { VALIDATION_SKILL_NAMES } from '@/skills/builtin/constants';
import {
  getMissionFailureCategoryFromReasonCode,
  getMissionFailureReasonCode,
} from '@/telemetry/customer/missionMetrics';
import { SHUTDOWN_HOOK_PRIORITY } from '@/utils/constants';
import { getUserIndustryDir } from '@/utils/industryPaths';
import { setSecureFilePermissions } from '@/utils/filePermissions';
import { getShutdownCoordinator } from '@/utils/shutdownCoordinator';
import { sanitizeSkillName } from '@/utils/skills/paths';

import type {
  CustomModel,
  MissionModelSettings,
} from '@industry/common/settings';

function sanitizeFilenameSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function isoToFilename(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const SKILL_PROMPT_FILE = 'SKILL.md';
const CANONICAL_MISSION_ARTIFACT_LAYOUT_VERSION = 2;
// The first mission-file write schedules a single metadata read+sync this many
// ms later; further writes during that window fold into it. This caps the
// synchronous artifact read (which re-parses the whole progress log) to roughly
// once per window instead of running it on the daemon event loop for every write.
const MISSION_METADATA_SYNC_COALESCE_MS = 1000;
const MISSION_METADATA_SYNC_SHUTDOWN_HOOK_NAME = 'mission-metadata-sync-flush';
const MISSION_ARTIFACT_MARKER_FILES = [
  'mission.md',
  'features.json',
  'progress_log.jsonl',
  'AGENTS.md',
] as const;
const LEGACY_INDUSTRY_DIR_NAME = '.industry';
const LEGACY_RUNTIME_ARTIFACT_PATHS = [
  'services.yaml',
  'init.sh',
  'library',
  'validation',
] as const;

type SkillMatch = {
  skillDirPath: string;
  relativeDir: string;
};

type CanonicalArtifactLayoutResult =
  | {
      status: 'canonical' | 'skipped';
      importedPaths: string[];
      ambiguousSkillNames: string[];
    }
  | {
      status: 'hydrated';
      importedPaths: string[];
      ambiguousSkillNames: string[];
      markedCanonical: boolean;
    };

async function findSkillDirectories(
  baseDir: string,
  visited: Set<string> = new Set()
): Promise<string[]> {
  let realPath: string;
  try {
    realPath = await fs.realpath(baseDir);
  } catch {
    return [];
  }

  if (visited.has(realPath)) {
    return [];
  }
  visited.add(realPath);

  let entries: Array<{
    name: string;
    isDirectory: () => boolean;
    isSymbolicLink: () => boolean;
  }>;
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map(async (entry) => {
        const dirPath = path.join(baseDir, entry.name);
        if (await fileExists(path.join(dirPath, SKILL_PROMPT_FILE))) {
          return [dirPath];
        }
        return findSkillDirectories(dirPath, visited);
      })
  );

  return nested.flat();
}

/**
 * Service for managing mission files in ~/.industry(-dev)/missions/{baseSessionId}/
 *
 * File layout:
 * - state.json       - Mission state (system-managed)
 * - features.json    - Feature list (orchestrator-authored)
 * - progress_log.jsonl - Append-only structured log (JSONL)
 * - AGENTS.md        - Mission-specific guidance
 */
export class MissionFileService {
  private baseSessionId: string;

  private missionDir: string;

  private progressLogCache: {
    size: number;
    mtimeMs: number;
    offset: number;
    remainder: string;
    entries: ProgressLogEntry[];
    derivedWorkerStates: Record<
      string,
      { startedAt: string; completedAt?: string; exitCode?: number }
    >;
    activeWorkerSessionId?: string;
  } | null = null;

  private missionMetadataSyncTimer: NodeJS.Timeout | null = null;

  constructor(baseSessionId: string) {
    this.baseSessionId = baseSessionId;
    this.missionDir = path.join(
      getUserIndustryDir(),
      'missions',
      this.baseSessionId
    );
  }

  /**
   * Get the mission directory path
   */
  getMissionDir(): string {
    return this.missionDir;
  }

  private isCloudSessionSyncEnabled(): boolean {
    return getSettingsService().getSettings().general?.cloudSessionSync ?? true;
  }

  syncMissionMetadataToCloud(): void {
    if (!this.isCloudSessionSyncEnabled()) {
      return;
    }

    // Coalesce bursts of writes into one deferred read+sync. The metadata read
    // is synchronous and re-parses the entire progress log, so running it inline
    // on every write would block the daemon event loop and scale poorly with
    // progress-log size.
    if (this.missionMetadataSyncTimer) {
      return;
    }
    this.missionMetadataSyncTimer = setTimeout(() => {
      this.missionMetadataSyncTimer = null;
      void this.flushMissionMetadataToCloud();
    }, MISSION_METADATA_SYNC_COALESCE_MS);
    this.missionMetadataSyncTimer.unref();
  }

  async flushPendingMissionMetadataSyncToCloud(): Promise<void> {
    if (!this.missionMetadataSyncTimer) {
      return;
    }

    clearTimeout(this.missionMetadataSyncTimer);
    this.missionMetadataSyncTimer = null;
    await this.flushMissionMetadataToCloud();
  }

  private async flushMissionMetadataToCloud(): Promise<void> {
    if (!this.isCloudSessionSyncEnabled()) {
      return;
    }

    const mission = readMissionArtifactMetadataForSession({
      missionsDir: path.dirname(this.missionDir),
      sessionId: this.baseSessionId,
    });
    if (!mission) {
      return;
    }

    await getCloudSyncService().syncMissionMetadata(
      this.baseSessionId,
      mission
    );
  }

  /**
   * Initialize the mission directory structure
   */
  async initializeMissionDir(): Promise<void> {
    await fs.mkdir(this.missionDir, { recursive: true });
  }

  /**
   * Check if a mission exists
   */
  async missionExists(): Promise<boolean> {
    try {
      await fs.access(this.missionDir);
      return true;
    } catch {
      return false;
    }
  }

  private get artifactLayoutMarkerPath(): string {
    return path.join(this.missionDir, 'canonical-artifact-layout.json');
  }

  async readCanonicalArtifactLayoutMarker(): Promise<ArtifactLayoutMarker | null> {
    try {
      const content = await fs.readFile(this.artifactLayoutMarkerPath, 'utf-8');
      return JSON.parse(content) as ArtifactLayoutMarker;
    } catch {
      return null;
    }
  }

  private async writeArtifactLayoutMarker(
    marker: ArtifactLayoutMarker
  ): Promise<void> {
    await fs.writeFile(
      this.artifactLayoutMarkerPath,
      JSON.stringify(marker, null, 2)
    );
  }

  async getPendingCanonicalArtifactLayoutNotice(): Promise<ArtifactLayoutMarker | null> {
    const marker = await this.readCanonicalArtifactLayoutMarker();
    if (!marker || marker.canonicalNoticeShownAt) {
      return null;
    }
    return marker;
  }

  async markCanonicalArtifactLayoutNoticeShown(
    shownAt = new Date().toISOString()
  ): Promise<void> {
    const marker = await this.readCanonicalArtifactLayoutMarker();
    if (!marker || marker.canonicalNoticeShownAt) {
      return;
    }

    await this.writeArtifactLayoutMarker({
      ...marker,
      canonicalNoticeShownAt: shownAt,
    });
  }

  async ensureCanonicalArtifactLayout(): Promise<CanonicalArtifactLayoutResult> {
    const state = await this.readState();
    const marker = await this.readCanonicalArtifactLayoutMarker();
    if (
      state?.artifactLayoutVersion ===
        CANONICAL_MISSION_ARTIFACT_LAYOUT_VERSION ||
      marker?.version === CANONICAL_MISSION_ARTIFACT_LAYOUT_VERSION
    ) {
      if (
        state &&
        state.artifactLayoutVersion !==
          CANONICAL_MISSION_ARTIFACT_LAYOUT_VERSION
      ) {
        await this.updateState({
          artifactLayoutVersion: CANONICAL_MISSION_ARTIFACT_LAYOUT_VERSION,
          legacyArtifactsHydratedAt: marker?.hydratedAt,
        });
      }
      return {
        status: 'canonical',
        importedPaths: [],
        ambiguousSkillNames: [],
      };
    }

    const featuresFile = await this.readFeatures();
    if (!featuresFile) {
      return {
        status: 'skipped',
        importedPaths: [],
        ambiguousSkillNames: [],
      };
    }

    const workingDirectory =
      state?.workingDirectory ?? (await this.readWorkingDirectory());
    if (!workingDirectory) {
      return {
        status: 'skipped',
        importedPaths: [],
        ambiguousSkillNames: [],
      };
    }

    const legacyIndustryDir = path.join(
      workingDirectory,
      LEGACY_INDUSTRY_DIR_NAME
    );
    if (!(await fileExists(legacyIndustryDir))) {
      return {
        status: 'skipped',
        importedPaths: [],
        ambiguousSkillNames: [],
      };
    }

    const referencedSkillNames = [
      ...new Set(
        featuresFile.features
          .map((feature) => sanitizeSkillName(feature.skillName))
          .filter(Boolean)
      ),
    ];

    const runtimeArtifactPresence = await Promise.all(
      LEGACY_RUNTIME_ARTIFACT_PATHS.map(async (relativePath) =>
        fileExists(path.join(legacyIndustryDir, relativePath))
      )
    );
    const hasRuntimeArtifactEvidence = runtimeArtifactPresence.some(Boolean);
    const hasPriorHydrationMarker = marker !== null;

    if (!hasRuntimeArtifactEvidence && !hasPriorHydrationMarker) {
      return {
        status: 'skipped',
        importedPaths: [],
        ambiguousSkillNames: [],
      };
    }

    const legacySkillMatches = await this.findLegacySkillMatches(
      path.join(legacyIndustryDir, 'skills'),
      referencedSkillNames
    );

    const importedPaths: string[] = [];
    for (const relativePath of LEGACY_RUNTIME_ARTIFACT_PATHS) {
      const copied = await this.copyLegacyArtifactIfMissing({
        sourcePath: path.join(legacyIndustryDir, relativePath),
        destinationPath: path.join(this.missionDir, relativePath),
        logicalPath: relativePath,
      });
      importedPaths.push(...copied);
    }

    const ambiguousSkillNames: string[] = [];
    for (const skillName of referencedSkillNames) {
      if (await this.hasMissionScopedSkill(skillName)) {
        continue;
      }

      const matches = legacySkillMatches.get(skillName) ?? [];
      if (matches.length === 0) {
        continue;
      }
      if (matches.length > 1) {
        ambiguousSkillNames.push(skillName);
        logWarn('[MissionFileService] Legacy mission skill is ambiguous', {
          baseSessionId: this.baseSessionId,
          name: skillName,
          paths: matches.map((match) => match.skillDirPath),
        });
        continue;
      }

      const [match] = matches;
      const copied = await this.copyLegacyArtifactIfMissing({
        sourcePath: match.skillDirPath,
        destinationPath: path.join(
          this.missionDir,
          'skills',
          match.relativeDir
        ),
        logicalPath: path.join('skills', match.relativeDir),
      });
      importedPaths.push(...copied);
    }

    let markedCanonical = false;
    const hydratedAt = marker?.hydratedAt ?? new Date().toISOString();
    const nextMarker: ArtifactLayoutMarker = {
      version:
        ambiguousSkillNames.length === 0
          ? CANONICAL_MISSION_ARTIFACT_LAYOUT_VERSION
          : undefined,
      hydratedAt,
      importedPaths: [
        ...new Set([...(marker?.importedPaths ?? []), ...importedPaths]),
      ],
      ambiguousSkillNames,
      canonicalNoticeShownAt: marker?.canonicalNoticeShownAt,
    };
    await this.writeArtifactLayoutMarker(nextMarker);

    if (ambiguousSkillNames.length === 0) {
      if (state) {
        await this.updateState({
          artifactLayoutVersion: CANONICAL_MISSION_ARTIFACT_LAYOUT_VERSION,
          legacyArtifactsHydratedAt: hydratedAt,
        });
      }
      markedCanonical = true;
    }

    logInfo('[MissionFileService] Checked legacy mission artifact layout', {
      baseSessionId: this.baseSessionId,
      cwd: workingDirectory,
      paths: importedPaths,
      skillNames: ambiguousSkillNames,
    });

    return {
      status: 'hydrated',
      importedPaths,
      ambiguousSkillNames,
      markedCanonical,
    };
  }

  private async findLegacySkillMatches(
    legacySkillsDir: string,
    referencedSkillNames: string[]
  ): Promise<Map<string, SkillMatch[]>> {
    if (
      referencedSkillNames.length === 0 ||
      !(await fileExists(legacySkillsDir))
    ) {
      return new Map();
    }

    const referencedSkillNamesSet = new Set(referencedSkillNames);
    const matches = new Map<string, SkillMatch[]>();
    const skillDirPaths = await findSkillDirectories(legacySkillsDir);
    for (const skillDirPath of skillDirPaths) {
      const skill = await loadSkillFile(
        path.join(skillDirPath, SKILL_PROMPT_FILE),
        SkillLocation.Project
      );
      if (!skill) {
        continue;
      }

      const normalizedName = sanitizeSkillName(skill.metadata.name);
      if (!referencedSkillNamesSet.has(normalizedName)) {
        continue;
      }

      const relativeDir = path.relative(legacySkillsDir, skillDirPath);
      if (
        relativeDir.startsWith('..') ||
        path.isAbsolute(relativeDir) ||
        relativeDir === ''
      ) {
        continue;
      }

      const current = matches.get(normalizedName) ?? [];
      current.push({ skillDirPath, relativeDir });
      matches.set(normalizedName, current);
    }

    return matches;
  }

  private async hasMissionScopedSkill(skillName: string): Promise<boolean> {
    const missionSkillsDir = path.join(this.missionDir, 'skills');
    if (!(await fileExists(missionSkillsDir))) {
      return false;
    }

    const skillDirPaths = await findSkillDirectories(missionSkillsDir);
    for (const skillDirPath of skillDirPaths) {
      const skill = await loadSkillFile(
        path.join(skillDirPath, SKILL_PROMPT_FILE),
        SkillLocation.Project
      );
      if (!skill) {
        continue;
      }
      if (sanitizeSkillName(skill.metadata.name) === skillName) {
        return true;
      }
    }

    return false;
  }

  private async copyLegacyArtifactIfMissing(params: {
    sourcePath: string;
    destinationPath: string;
    logicalPath: string;
  }): Promise<string[]> {
    if (!(await fileExists(params.sourcePath))) {
      return [];
    }

    const sourceStat = await fs.stat(params.sourcePath);
    if (sourceStat.isDirectory()) {
      return this.copyDirectoryContentsIfMissing(
        params.sourcePath,
        params.destinationPath,
        params.logicalPath
      );
    }

    const copied = await this.copyFileIfMissing(
      params.sourcePath,
      params.destinationPath
    );
    return copied ? [params.logicalPath] : [];
  }

  private async copyDirectoryContentsIfMissing(
    sourceDir: string,
    destinationDir: string,
    logicalDir: string
  ): Promise<string[]> {
    await fs.mkdir(destinationDir, { recursive: true });

    const copiedPaths: string[] = [];
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name);
      const destinationPath = path.join(destinationDir, entry.name);
      const logicalPath = path.join(logicalDir, entry.name);

      if (entry.isDirectory()) {
        copiedPaths.push(
          ...(await this.copyDirectoryContentsIfMissing(
            sourcePath,
            destinationPath,
            logicalPath
          ))
        );
        continue;
      }

      if (entry.isSymbolicLink()) {
        const stat = await fs.stat(sourcePath);
        if (stat.isDirectory()) {
          copiedPaths.push(
            ...(await this.copyDirectoryContentsIfMissing(
              sourcePath,
              destinationPath,
              logicalPath
            ))
          );
        } else if (await this.copyFileIfMissing(sourcePath, destinationPath)) {
          copiedPaths.push(logicalPath);
        }
        continue;
      }

      if (await this.copyFileIfMissing(sourcePath, destinationPath)) {
        copiedPaths.push(logicalPath);
      }
    }

    return copiedPaths;
  }

  private async copyFileIfMissing(
    sourcePath: string,
    destinationPath: string
  ): Promise<boolean> {
    if (await fileExists(destinationPath)) {
      return false;
    }

    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
    const sourceStat = await fs.stat(sourcePath);
    await fs.chmod(destinationPath, sourceStat.mode);
    return true;
  }

  // ============ state.json ============

  private get stateFilePath(): string {
    return path.join(this.missionDir, 'state.json');
  }

  /**
   * Read the mission state file
   */
  async readState(): Promise<MissionStateFile | null> {
    try {
      const content = await fs.readFile(this.stateFilePath, 'utf-8');
      return JSON.parse(content) as MissionStateFile;
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode !== 'ENOENT') {
        logWarn('[MissionFileService] Failed to read state.json', {
          baseSessionId: this.baseSessionId,
          filePath: this.stateFilePath,
          cause: error,
        });
      }
      return null;
    }
  }

  async readStateOrThrow(): Promise<MissionStateFile | null> {
    const content = await fs.readFile(this.stateFilePath, 'utf-8');
    return JSON.parse(content) as MissionStateFile;
  }

  /**
   * Write the mission state file (system-managed only)
   */
  async writeState(state: MissionStateFile): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await fs.writeFile(this.stateFilePath, JSON.stringify(state, null, 2));
    this.syncMissionMetadataToCloud();
  }

  /**
   * Create initial mission state
   */
  async createInitialState(
    workingDirectory: string,
    initialState: MissionState = MissionState.Initializing
  ): Promise<MissionStateFile> {
    const now = new Date().toISOString();
    const state: MissionStateFile = {
      missionId: `mis_${uuidv4().slice(0, 8)}`,
      state: initialState,
      workingDirectory,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeState(state);
    return state;
  }

  async ensurePlanningState(workingDirectory: string): Promise<void> {
    await this.initializeMissionDir();
    if (await this.readState()) {
      return;
    }
    await this.writeWorkingDirectory(workingDirectory);
    await this.createInitialState(workingDirectory, MissionState.Planning);
  }

  async hasMissionArtifacts(): Promise<boolean> {
    const markerChecks = await Promise.all(
      MISSION_ARTIFACT_MARKER_FILES.map((name) =>
        fileExists(path.join(this.missionDir, name))
      )
    );
    if (markerChecks.some(Boolean)) {
      return true;
    }

    if (!(await this.missionExists())) {
      return false;
    }

    const state = await this.readState();
    return state === null || state.state !== MissionState.Planning;
  }

  /**
   * Update mission state
   */
  async updateState(
    updates: Partial<Omit<MissionStateFile, 'missionId' | 'createdAt'>>
  ): Promise<MissionStateFile> {
    const current = await this.readState();
    if (!current) {
      throw new MetaError('Mission state not found for', {
        baseSessionId: this.baseSessionId,
      });
    }
    const updated = { ...current, ...updates };
    await this.writeState(updated);

    // Emit notification if state changed
    if (updates.state !== undefined) {
      agentEventBus.emit(AgentEvent.ProjectNotification, {
        notification: {
          type: SessionNotificationType.MISSION_STATE_CHANGED,
          state: updated.state,
          updatedAt: updated.updatedAt,
        },
      });
    }

    return updated;
  }

  // ============ features.json ============

  private get featuresFilePath(): string {
    return path.join(this.missionDir, 'features.json');
  }

  /**
   * Normalize a feature to ensure system-managed fields have defaults.
   *
   * `milestone` is canonicalised to a string at this read boundary so every
   * downstream comparison (`f.milestone === milestone`), template
   * interpolation, and the `z.string()`-typed MilestoneValidationTriggered
   * progress-log entry all see the same shape. The mission-artifact write
   * guard accepts numeric `milestone` by coercing only for validation (not
   * rewriting the on-disk content), so older files on disk can still contain
   * numbers — we normalise here so callers never have to care.
   */
  private static normalizeFeature(feature: Partial<Feature>): Feature {
    const rawMilestone = feature.milestone;
    const normalizedMilestone =
      typeof rawMilestone === 'number' || typeof rawMilestone === 'boolean'
        ? String(rawMilestone)
        : typeof rawMilestone === 'string'
          ? rawMilestone
          : undefined;

    return {
      id: feature.id || '',
      description: feature.description || '',
      skillName: feature.skillName || '',
      preconditions: Array.isArray(feature.preconditions)
        ? feature.preconditions
        : [],
      expectedBehavior: Array.isArray(feature.expectedBehavior)
        ? feature.expectedBehavior
        : typeof feature.expectedBehavior === 'string'
          ? [feature.expectedBehavior]
          : [],
      fulfills: Array.isArray(feature.fulfills)
        ? (feature.fulfills as string[])
        : undefined,
      milestone: normalizedMilestone,
      // System-managed fields with defaults
      status: feature.status || FeatureStatus.Pending,
      workerSessionIds: feature.workerSessionIds || [],
      currentWorkerSessionId: feature.currentWorkerSessionId ?? null,
      completedWorkerSessionId: feature.completedWorkerSessionId ?? null,
    };
  }

  /**
   * Read the features file
   */
  async readFeatures(): Promise<FeaturesFile | null> {
    try {
      const content = await fs.readFile(this.featuresFilePath, 'utf-8');
      return this.parseFeaturesContent(content);
    } catch (error) {
      this.handleReadFeaturesError(error);
      return null;
    }
  }

  readFeaturesSync(): FeaturesFile | null {
    try {
      const content = readFileSync(this.featuresFilePath, 'utf-8');
      return this.parseFeaturesContent(content);
    } catch (error) {
      this.handleReadFeaturesError(error);
      return null;
    }
  }

  private parseFeaturesContent(content: string): FeaturesFile | null {
    const parsed = JSON.parse(content) as
      | { features: Partial<Feature>[] }
      | Partial<Feature>[];
    // Handle both { features: [...] } wrapper and bare array formats
    const features = Array.isArray(parsed) ? parsed : parsed.features;
    if (!Array.isArray(features)) {
      logWarn('[MissionFileService] Invalid features.json schema', {
        baseSessionId: this.baseSessionId,
        filePath: this.featuresFilePath,
      });
      return null;
    }
    return {
      features: features.map((f) => MissionFileService.normalizeFeature(f)),
    };
  }

  private handleReadFeaturesError(error: unknown): void {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode !== 'ENOENT') {
      logWarn('[MissionFileService] Failed to read features.json', {
        baseSessionId: this.baseSessionId,
        filePath: this.featuresFilePath,
        cause: error,
      });
    }
  }

  async readFeaturesOrThrow(): Promise<FeaturesFile | null> {
    const content = await fs.readFile(this.featuresFilePath, 'utf-8');
    const parsed = JSON.parse(content) as
      | { features: Partial<Feature>[] }
      | Partial<Feature>[];
    const features = Array.isArray(parsed) ? parsed : parsed.features;
    if (!Array.isArray(features)) {
      throw new Error(
        'Invalid features.json: expected { "features": [...] } or a bare array'
      );
    }
    return {
      features: features.map((f) => MissionFileService.normalizeFeature(f)),
    };
  }

  /**
   * Write the features file
   */
  async writeFeatures(features: FeaturesFile): Promise<void> {
    await fs.writeFile(
      this.featuresFilePath,
      JSON.stringify(features, null, 2)
    );
    this.syncMissionMetadataToCloud();

    // Emit notification
    agentEventBus.emit(AgentEvent.ProjectNotification, {
      notification: {
        type: SessionNotificationType.MISSION_FEATURES_CHANGED,
        features: features.features,
      },
    });
  }

  /**
   * Get a specific feature by ID
   */
  async getFeature(featureId: string): Promise<Feature | null> {
    const featuresFile = await this.readFeatures();
    if (!featuresFile) return null;
    return featuresFile.features.find((f) => f.id === featureId) ?? null;
  }

  getFeatureForWorkerSessionSync(workerSessionId: string): Feature | null {
    const featuresFile = this.readFeaturesSync();
    if (!featuresFile) return null;
    return (
      featuresFile.features.find(
        (f) =>
          f.currentWorkerSessionId === workerSessionId ||
          (f.workerSessionIds ?? []).includes(workerSessionId)
      ) ?? null
    );
  }

  async getInProgressFeature(): Promise<Feature | null> {
    const featuresFile = await this.readFeatures();
    if (!featuresFile) return null;
    return (
      featuresFile.features.find(
        (f) => f.status === FeatureStatus.InProgress
      ) ?? null
    );
  }

  getInProgressFeatureSync(): Feature | null {
    const featuresFile = this.readFeaturesSync();
    if (!featuresFile) return null;
    return (
      featuresFile.features.find(
        (f) => f.status === FeatureStatus.InProgress
      ) ?? null
    );
  }

  /**
   * Update a specific feature
   */
  async updateFeature(
    featureId: string,
    updates: Partial<Feature>
  ): Promise<Feature | null> {
    const featuresFile = await this.readFeatures();
    if (!featuresFile) return null;

    const featureIndex = featuresFile.features.findIndex(
      (f) => f.id === featureId
    );
    if (featureIndex === -1) return null;

    featuresFile.features[featureIndex] = {
      ...featuresFile.features[featureIndex],
      ...updates,
    };
    await this.writeFeatures(featuresFile);
    return featuresFile.features[featureIndex];
  }

  /**
   * Get the next pending feature (first pending feature in array order)
   * Features are ordered by position in features.json (first = next to run)
   */
  async getNextPendingFeature(): Promise<Feature | null> {
    const featuresFile = await this.readFeatures();
    if (!featuresFile) return null;

    return (
      featuresFile.features.find((f) => f.status === FeatureStatus.Pending) ??
      null
    );
  }

  /**
   * Grant additional worker-attempt budget to any pending feature that has
   * exhausted its current budget. Called when the user resumes a mission that
   * was paused because a feature kept failing, so the feature is allowed to run
   * again instead of immediately re-pausing. Cancelled features are skipped
   * (only Pending features are considered). Returns the ids that were bumped.
   */
  async grantRetryBudgetForExhaustedFeatures(): Promise<string[]> {
    const [featuresFile, state] = await Promise.all([
      this.readFeatures(),
      this.readState(),
    ]);
    if (!featuresFile || !state) {
      return [];
    }

    const exhaustedPending = featuresFile.features.filter(
      (f) =>
        f.status === FeatureStatus.Pending &&
        getFeatureAttemptCount(f) >= getEffectiveMaxFeatureAttempts(f.id, state)
    );
    if (exhaustedPending.length === 0) {
      return [];
    }

    const bonus = { ...(state.featureRetryBudgetBonus ?? {}) };
    for (const feature of exhaustedPending) {
      bonus[feature.id] = (bonus[feature.id] ?? 0) + MAX_FEATURE_ATTEMPTS;
    }

    await this.updateState({ featureRetryBudgetBonus: bonus });

    return exhaustedPending.map((f) => f.id);
  }

  /**
   * Check if all features are completed
   */
  async areAllFeaturesCompleted(): Promise<boolean> {
    const featuresFile = await this.readFeatures();
    if (!featuresFile) return false;
    return featuresFile.features.every(
      (f) =>
        f.status === FeatureStatus.Completed ||
        f.status === FeatureStatus.Cancelled
    );
  }

  /**
   * Add a new feature to the end of features.json
   */
  async addFeature(feature: Feature): Promise<void> {
    const featuresFile = await this.readFeatures();
    if (!featuresFile) {
      await this.writeFeatures({ features: [feature] });
      return;
    }
    featuresFile.features.push(feature);
    await this.writeFeatures(featuresFile);
  }

  /**
   * Insert a feature at the top of features.json (index 0)
   * Used for urgent/blocking features that should run next
   */
  async insertFeatureAtTop(feature: Feature): Promise<void> {
    const featuresFile = await this.readFeatures();
    if (!featuresFile) {
      await this.writeFeatures({ features: [feature] });
      return;
    }
    featuresFile.features.unshift(feature);
    await this.writeFeatures(featuresFile);
  }

  /**
   * Move a feature to the bottom of features.json
   * Used when a feature is completed to keep completed features at the end
   */
  async moveFeatureToBottom(featureId: string): Promise<void> {
    const featuresFile = await this.readFeatures();
    if (!featuresFile) return;

    const featureIndex = featuresFile.features.findIndex(
      (f) => f.id === featureId
    );
    if (featureIndex === -1) return;

    const [feature] = featuresFile.features.splice(featureIndex, 1);
    featuresFile.features.push(feature);
    await this.writeFeatures(featuresFile);
  }

  /**
   * Move "stranded" completed/cancelled features to the bottom of features.json.
   *
   * The bottom of features.json typically has a contiguous block of done
   * (completed/cancelled) features, ordered earliest-to-latest. When the
   * orchestrator marks a feature as completed/cancelled outside the normal
   * worker flow, it may end up above active features ("stranded").
   *
   * This method:
   * 1. Identifies the existing done-tail (contiguous done block at the end).
   * 2. Finds stranded done features above the tail.
   * 3. Removes them and appends them after the existing tail, preserving
   *    their relative order.
   */
  async moveStrandedDoneFeaturesToBottom(): Promise<void> {
    const featuresFile = await this.readFeatures();
    if (!featuresFile || featuresFile.features.length === 0) return;

    const isDone = (f: Feature): boolean =>
      f.status === FeatureStatus.Completed ||
      f.status === FeatureStatus.Cancelled;

    const features = featuresFile.features;

    // Walk from the bottom to find the boundary of the existing done-tail
    let tailStart = features.length;
    while (tailStart > 0 && isDone(features[tailStart - 1])) {
      tailStart--;
    }

    // Everything above tailStart that is done is "stranded"
    const stranded: Feature[] = [];
    const remaining: Feature[] = [];
    for (let i = 0; i < tailStart; i++) {
      if (isDone(features[i])) {
        stranded.push(features[i]);
      } else {
        remaining.push(features[i]);
      }
    }

    if (stranded.length === 0) return;

    // Reconstruct: active features + existing done tail + newly appended stranded
    const doneTail = features.slice(tailStart);
    featuresFile.features = [...remaining, ...doneTail, ...stranded];
    await this.writeFeatures(featuresFile);
  }

  // ============ Milestone Methods ============

  /**
   * Get all features belonging to a specific milestone
   */
  async getMilestoneFeatures(milestone: string): Promise<Feature[]> {
    const featuresFile = await this.readFeatures();
    if (!featuresFile) return [];
    return featuresFile.features.filter((f) => f.milestone === milestone);
  }

  /**
   * Get all unique milestones in the mission
   */
  async getAllMilestones(): Promise<string[]> {
    const featuresFile = await this.readFeatures();
    if (!featuresFile) return [];
    const milestones = new Set<string>();
    for (const feature of featuresFile.features) {
      if (feature.milestone) {
        milestones.add(feature.milestone);
      }
    }
    return Array.from(milestones);
  }

  /**
   * Check if all implementation features in a milestone are completed.
   * Implementation features are those that are NOT validation workers.
   */
  async isMilestoneImplementationComplete(milestone: string): Promise<boolean> {
    const features = await this.getMilestoneFeatures(milestone);
    if (features.length === 0) return false;

    const implementationFeatures = features.filter(
      (f) => !VALIDATION_SKILL_NAMES.includes(f.skillName)
    );

    if (implementationFeatures.length === 0) return false;

    return implementationFeatures.every(
      (f) =>
        f.status === FeatureStatus.Completed ||
        f.status === FeatureStatus.Cancelled
    );
  }

  /**
   * Check if validation-planner has already been triggered for a milestone.
   * Derived from progress_log.jsonl: a validation trigger entry already exists.
   */
  async hasValidationPlannerRun(milestone: string): Promise<boolean> {
    const progressLog = await this.readProgressLog();
    return progressLog.some(
      (entry) =>
        entry.type === ProgressLogEntryType.MilestoneValidationTriggered &&
        entry.milestone === milestone
    );
  }

  // ============ progress_log.jsonl ============

  private get progressLogPath(): string {
    return path.join(this.missionDir, 'progress_log.jsonl');
  }

  private static updateDerivedWorkerStatesFromProgressEntry(
    entry: ProgressLogEntry,
    derivedWorkerStates: Record<
      string,
      { startedAt: string; completedAt?: string; exitCode?: number }
    >,
    activeWorkerSessionId: string | undefined
  ): string | undefined {
    if (entry.type === ProgressLogEntryType.WorkerStarted) {
      const { workerSessionId, timestamp } = entry;

      if (activeWorkerSessionId) {
        const prev = derivedWorkerStates[activeWorkerSessionId];
        if (prev && !prev.completedAt) {
          derivedWorkerStates[activeWorkerSessionId] = {
            ...prev,
            completedAt: timestamp,
          };
        }
      }

      const existing = derivedWorkerStates[workerSessionId];
      derivedWorkerStates[workerSessionId] = {
        ...existing,
        startedAt:
          typeof existing?.startedAt === 'string'
            ? existing.startedAt
            : timestamp,
      };

      return workerSessionId;
    }

    if (entry.type === ProgressLogEntryType.WorkerCompleted) {
      const { workerSessionId, timestamp, exitCode } = entry;
      const existing = derivedWorkerStates[workerSessionId];
      derivedWorkerStates[workerSessionId] = {
        startedAt: existing?.startedAt ?? timestamp,
        completedAt: timestamp,
        exitCode,
      };

      return activeWorkerSessionId === workerSessionId
        ? undefined
        : activeWorkerSessionId;
    }

    if (entry.type === ProgressLogEntryType.WorkerFailed) {
      const { workerSessionId, timestamp, exitCode } = entry;
      if (workerSessionId) {
        const existing = derivedWorkerStates[workerSessionId];
        derivedWorkerStates[workerSessionId] = {
          startedAt: existing?.startedAt ?? timestamp,
          completedAt: timestamp,
          exitCode,
        };
        return activeWorkerSessionId === workerSessionId
          ? undefined
          : activeWorkerSessionId;
      }
    }

    return activeWorkerSessionId;
  }

  private async readProgressLogIncrementalOrThrow(): Promise<{
    progressLog: ProgressLogEntry[];
    derivedWorkerStates: Record<
      string,
      { startedAt: string; completedAt?: string; exitCode?: number }
    >;
  }> {
    let stat: { size: number; mtimeMs: number };
    try {
      const s = await fs.stat(this.progressLogPath);
      stat = { size: s.size, mtimeMs: s.mtimeMs };
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode === 'ENOENT') {
        this.progressLogCache = null;
        return { progressLog: [], derivedWorkerStates: {} };
      }
      throw error;
    }

    // Fast path: unchanged file
    if (
      this.progressLogCache &&
      this.progressLogCache.size === stat.size &&
      this.progressLogCache.mtimeMs === stat.mtimeMs
    ) {
      return {
        progressLog: this.progressLogCache.entries,
        derivedWorkerStates: this.progressLogCache.derivedWorkerStates,
      };
    }

    const cache = this.progressLogCache;
    const shouldReset =
      !cache ||
      stat.size < cache.offset ||
      (stat.size === cache.size && stat.mtimeMs !== cache.mtimeMs);

    if (shouldReset) {
      const content = await fs.readFile(this.progressLogPath, 'utf-8');
      const lines = content
        .trim()
        .split('\n')
        .filter((line) => line.trim());
      const entries = lines.map((line) => JSON.parse(line) as ProgressLogEntry);

      const derivedWorkerStates: Record<
        string,
        { startedAt: string; completedAt?: string; exitCode?: number }
      > = {};
      let activeWorkerSessionId: string | undefined;
      for (const entry of entries) {
        activeWorkerSessionId =
          MissionFileService.updateDerivedWorkerStatesFromProgressEntry(
            entry,
            derivedWorkerStates,
            activeWorkerSessionId
          );
      }

      this.progressLogCache = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        offset: stat.size,
        remainder: '',
        entries,
        derivedWorkerStates,
        activeWorkerSessionId,
      };

      return { progressLog: entries, derivedWorkerStates };
    }

    // Incremental append-only update
    const handle = await fs.open(this.progressLogPath, 'r');
    try {
      const start = cache.offset;
      const length = stat.size - start;

      if (length <= 0) {
        this.progressLogCache = {
          ...cache,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          offset: stat.size,
        };
        return {
          progressLog: this.progressLogCache.entries,
          derivedWorkerStates: this.progressLogCache.derivedWorkerStates,
        };
      }

      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);

      const chunkText = buffer.toString('utf-8');
      const text = cache.remainder + chunkText;
      const parts = text.split('\n');
      const remainder = parts.pop() ?? '';
      const completeLines = parts.map((l) => l.trim()).filter(Boolean);

      const newEntries = completeLines.map(
        (line) => JSON.parse(line) as ProgressLogEntry
      );

      // IMPORTANT: Do not mutate cached arrays/objects in place.
      // Mission Control views rely on referential changes (useMemo deps) to
      // recompute derived UI state when new progress entries arrive.
      const entries = [...cache.entries, ...newEntries];
      const derivedWorkerStates = { ...cache.derivedWorkerStates };

      let activeWorkerSessionId = cache.activeWorkerSessionId;
      for (const entry of newEntries) {
        activeWorkerSessionId =
          MissionFileService.updateDerivedWorkerStatesFromProgressEntry(
            entry,
            derivedWorkerStates,
            activeWorkerSessionId
          );
      }

      this.progressLogCache = {
        ...cache,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        offset: stat.size,
        remainder,
        entries,
        derivedWorkerStates,
        activeWorkerSessionId,
      };

      return { progressLog: entries, derivedWorkerStates };
    } finally {
      await handle.close();
    }
  }

  /**
   * Read all progress log entries
   */
  async readProgressLog(): Promise<ProgressLogEntry[]> {
    try {
      const { progressLog } = await this.readProgressLogIncrementalOrThrow();
      return progressLog;
    } catch {
      return [];
    }
  }

  /**
   * Read all progress log entries, throwing on error (for detailed error handling)
   * Returns empty array if file doesn't exist, but throws on parse/permission errors
   */
  async readProgressLogOrThrow(): Promise<ProgressLogEntry[]> {
    const { progressLog } = await this.readProgressLogIncrementalOrThrow();
    return progressLog;
  }

  /**
   * Read progress log plus derived workerStates (cached + incrementally updated).
   */
  async readProgressLogWithDerivedWorkerStatesOrThrow(): Promise<{
    progressLog: ProgressLogEntry[];
    derivedWorkerStates: Record<
      string,
      { startedAt: string; completedAt?: string; exitCode?: number }
    >;
  }> {
    return this.readProgressLogIncrementalOrThrow();
  }

  /**
   * Read progress log as raw string (for agents to read)
   */
  async readProgressLogRaw(): Promise<string> {
    try {
      return await fs.readFile(this.progressLogPath, 'utf-8');
    } catch {
      return '';
    }
  }

  /**
   * Append an entry to the progress log (JSONL format)
   */
  async appendProgressLog(entry: ProgressLogEntry): Promise<void> {
    const entryWithTimestamp = {
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    } as ProgressLogEntry;
    const logLine = `${JSON.stringify(entryWithTimestamp)}\n`;

    try {
      await fs.appendFile(this.progressLogPath, logLine);
    } catch {
      // If file doesn't exist, create it
      await fs.writeFile(this.progressLogPath, logLine);
    }
    this.syncMissionMetadataToCloud();

    // Emit full progress log notification
    const progressLog = await this.readProgressLog();
    agentEventBus.emit(AgentEvent.ProjectNotification, {
      notification: {
        type: SessionNotificationType.MISSION_PROGRESS_ENTRY,
        progressLog,
      },
    });

    // Emit specific worker notifications for easier desktop handling
    if (
      entryWithTimestamp.type === ProgressLogEntryType.WorkerStarted &&
      'workerSessionId' in entryWithTimestamp
    ) {
      agentEventBus.emit(AgentEvent.ProjectNotification, {
        notification: {
          type: SessionNotificationType.MISSION_WORKER_STARTED,
          workerSessionId: entryWithTimestamp.workerSessionId,
        },
      });
    } else if (
      entryWithTimestamp.type === ProgressLogEntryType.WorkerCompleted &&
      'workerSessionId' in entryWithTimestamp &&
      'exitCode' in entryWithTimestamp
    ) {
      agentEventBus.emit(AgentEvent.ProjectNotification, {
        notification: {
          type: SessionNotificationType.MISSION_WORKER_COMPLETED,
          workerSessionId: entryWithTimestamp.workerSessionId,
          exitCode: entryWithTimestamp.exitCode,
        },
      });
    }

    // Derive feature counts from features.json
    const featuresFile = await this.readFeatures();
    const allFeatures = featuresFile?.features ?? [];
    const totalFeatures = allFeatures.length;
    const completedFeatures = allFeatures.filter(
      (f) => f.status === FeatureStatus.Completed
    ).length;
    const missionProgressLabels = {
      ...(totalFeatures > 0
        ? { missionCompletedFeatures: completedFeatures }
        : {}),
      ...(totalFeatures > 0 ? { missionTotalFeatures: totalFeatures } : {}),
    };

    if (entryWithTimestamp.type === ProgressLogEntryType.MissionPaused) {
      Metrics.addToCounter(
        Metric.MISSION_PAUSED_COUNT,
        1,
        missionProgressLabels
      );
    }

    if (entryWithTimestamp.type === ProgressLogEntryType.MissionResumed) {
      Metrics.addToCounter(
        Metric.MISSION_RESUMED_COUNT,
        1,
        missionProgressLabels
      );
    }

    if (entryWithTimestamp.type === ProgressLogEntryType.WorkerFailed) {
      const failureReasonCode = getMissionFailureReasonCode(
        entryWithTimestamp.reason
      );
      const failureCategory =
        getMissionFailureCategoryFromReasonCode(failureReasonCode);
      Metrics.addToCounter(Metric.MISSION_WORKER_FAILED_COUNT, 1, {
        ...missionProgressLabels,
        missionFailureReason: failureReasonCode,
        missionFailureCategory: failureCategory,
        ...(entryWithTimestamp.workerSessionId
          ? { missionWorkerSessionId: entryWithTimestamp.workerSessionId }
          : {}),
      });
    }
  }

  /**
   * Get the session ID of an interrupted/paused worker.
   * Used to determine which worker to resume after orchestrator pause.
   * Returns null if no worker is currently paused/in-progress.
   *
   * Priority:
   * 1. Most recent WorkerPaused entry that hasn't completed/failed
   * 2. Most recent WorkerStarted that hasn't completed/failed (backward compat)
   */
  async getInterruptedWorkerSessionId(): Promise<string | null> {
    const progressLog = await this.readProgressLog();

    // Type guards for entry types with workerSessionId
    const isWorkerCompletedEntry = (
      entry: ProgressLogEntry
    ): entry is WorkerCompletedEntry =>
      entry.type === ProgressLogEntryType.WorkerCompleted;

    const isWorkerFailedEntry = (
      entry: ProgressLogEntry
    ): entry is WorkerFailedEntry =>
      entry.type === ProgressLogEntryType.WorkerFailed;

    const isWorkerPausedEntry = (
      entry: ProgressLogEntry
    ): entry is WorkerPausedEntry =>
      entry.type === ProgressLogEntryType.WorkerPaused;

    const isWorkerStartedEntry = (
      entry: ProgressLogEntry
    ): entry is WorkerStartedEntry =>
      entry.type === ProgressLogEntryType.WorkerStarted;

    // Track workers that have completed or failed
    const completedWorkers = new Set<string>();

    progressLog.forEach((entry) => {
      if (isWorkerCompletedEntry(entry) && entry.workerSessionId) {
        completedWorkers.add(entry.workerSessionId);
      } else if (isWorkerFailedEntry(entry) && entry.workerSessionId) {
        completedWorkers.add(entry.workerSessionId);
      }
    });

    // Find most recent paused worker that hasn't completed
    const pausedEntry = progressLog.findLast(
      (entry): entry is WorkerPausedEntry =>
        isWorkerPausedEntry(entry) &&
        Boolean(entry.workerSessionId) &&
        !completedWorkers.has(entry.workerSessionId)
    );

    if (pausedEntry) {
      return pausedEntry.workerSessionId;
    }

    // Fallback: find most recent started worker that hasn't completed/failed
    // (for backward compatibility with missions paused before WorkerPaused was added)
    const startedEntry = progressLog.findLast(
      (entry): entry is WorkerStartedEntry =>
        isWorkerStartedEntry(entry) &&
        Boolean(entry.workerSessionId) &&
        !completedWorkers.has(entry.workerSessionId)
    );

    if (startedEntry) {
      return startedEntry.workerSessionId;
    }

    return null;
  }

  // ============ handoffs.jsonl ============

  private get handoffsPath(): string {
    return path.join(this.missionDir, 'handoffs.jsonl');
  }

  /**
   * Append a handoff entry to handoffs.jsonl (searchable with jq)
   */
  async appendHandoff(entry: {
    workerSessionId: string;
    featureId: string;
    milestone?: string;
    commitId?: string;
    repoPath?: string;
    handoffFile?: string;
    handoff: Handoff;
  }): Promise<void> {
    const entryWithTimestamp = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    const logLine = `${JSON.stringify(entryWithTimestamp)}\n`;

    try {
      await fs.appendFile(this.handoffsPath, logLine);
    } catch {
      await fs.writeFile(this.handoffsPath, logLine);
    }
  }

  /**
   * Read all handoff entries from handoffs.jsonl
   */
  async readHandoffs(): Promise<HandoffEntry[]> {
    try {
      const content = await fs.readFile(this.handoffsPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      return lines.map((line) => HandoffEntrySchema.parse(JSON.parse(line)));
    } catch {
      return [];
    }
  }

  async ensureWorkerHandoffJson(params: {
    timestamp: string;
    workerSessionId: string;
    featureId: string;
    milestone?: string;
    commitId?: string;
    repoPath?: string;
    successState?: string;
    returnToOrchestrator?: boolean;
    handoff: Handoff;
    preferredFilePath?: string;
  }): Promise<string> {
    // Store per-worker handoffs inside the mission directory so they travel with mission state.
    const dir = path.join(this.missionDir, 'handoffs');
    await fs.mkdir(dir, { recursive: true });

    const defaultFileName = `${isoToFilename(params.timestamp)}__${sanitizeFilenameSegment(params.featureId)}__${sanitizeFilenameSegment(params.workerSessionId)}.json`;
    const preferred = params.preferredFilePath;
    const filePath =
      preferred &&
      path.isAbsolute(preferred) &&
      path.normalize(preferred).startsWith(`${dir}${path.sep}`)
        ? preferred
        : path.join(dir, defaultFileName);

    if (await fileExists(filePath)) {
      return filePath;
    }

    const payload = {
      timestamp: params.timestamp,
      workerSessionId: params.workerSessionId,
      featureId: params.featureId,
      milestone: params.milestone,
      commitId: params.commitId,
      repoPath: params.repoPath,
      successState: params.successState,
      returnToOrchestrator: params.returnToOrchestrator,
      handoff: params.handoff,
    };

    await fs.writeFile(
      filePath,
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf-8'
    );
    return filePath;
  }

  /**
   * Get the handoff directory path
   */
  private get handoffsDirPath(): string {
    return path.join(this.missionDir, 'handoffs');
  }

  /**
   * Read a worker's handoff from the correct source.
   *
   * Priority order:
   * 1. Per-worker JSON file in {missionDir}/handoffs/ (preferred, newer format)
   * 2. WorkerCompleted entry in progress_log.jsonl (always written)
   *
   * @param workerSessionId The worker session ID to find the handoff for
   * @returns The handoff if found, null otherwise
   */
  async readWorkerHandoff(workerSessionId: string): Promise<Handoff | null> {
    // First try to find per-worker JSON file in handoffs/ directory
    try {
      const handoffsDir = this.handoffsDirPath;
      const files = await fs.readdir(handoffsDir);

      // Find all files containing the workerSessionId (filename includes the session ID)
      // Filenames are formatted as: {timestamp}__{featureId}__{workerSessionId}.json
      // where timestamp is ISO formatted (e.g., 2026-01-27T12-34-56-789Z)
      // Sort descending to get most recent first (deterministic selection)
      const matchingFiles = files
        .filter(
          (file) => file.endsWith('.json') && file.includes(workerSessionId)
        )
        .sort((a, b) => b.localeCompare(a)); // Descending order - most recent first

      const matchingFile = matchingFiles[0];

      if (matchingFile) {
        const filePath = path.join(handoffsDir, matchingFile);
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content) as {
          workerSessionId: string;
          handoff: Handoff;
        };
        if (parsed.workerSessionId === workerSessionId && parsed.handoff) {
          return parsed.handoff;
        }
      }
    } catch {
      // Directory doesn't exist or can't be read - continue to fallback
    }

    // Fall back to extracting from progress_log.jsonl
    try {
      const progressLog = await this.readProgressLog();
      // Find the WorkerCompleted entry for this worker (most recent if multiple)
      const completedEntries = progressLog.filter(
        (entry): entry is ProgressLogEntry & { handoff?: Handoff } =>
          entry.type === ProgressLogEntryType.WorkerCompleted &&
          'workerSessionId' in entry &&
          entry.workerSessionId === workerSessionId
      );

      // Return the most recent handoff (last entry)
      const lastEntry = completedEntries[completedEntries.length - 1];
      if (lastEntry?.handoff) {
        return lastEntry.handoff;
      }
    } catch {
      // Progress log doesn't exist or can't be read
    }

    return null;
  }

  // ============ worker-transcripts.jsonl ============

  private get transcriptsPath(): string {
    return path.join(this.missionDir, 'worker-transcripts.jsonl');
  }

  /**
   * Append a transcript skeleton entry to worker-transcripts.jsonl
   * Used by scrutiny validator to verify worker claims against actual tool usage
   */
  async appendTranscriptSkeleton(entry: {
    workerSessionId: string;
    featureId: string;
    milestone?: string;
    skeleton: string;
  }): Promise<void> {
    const entryWithTimestamp = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    const logLine = `${JSON.stringify(entryWithTimestamp)}\n`;

    try {
      await fs.appendFile(this.transcriptsPath, logLine);
    } catch {
      await fs.writeFile(this.transcriptsPath, logLine);
    }
  }

  // ============ AGENTS.md ============

  private get agentsMdPath(): string {
    return path.join(this.missionDir, 'AGENTS.md');
  }

  /**
   * Read the mission AGENTS.md
   */
  async readAgentsMd(): Promise<string | null> {
    try {
      return await fs.readFile(this.agentsMdPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Write the mission AGENTS.md
   */
  async writeAgentsMd(content: string): Promise<void> {
    await fs.writeFile(this.agentsMdPath, content);
  }

  // ============ mission.md ============

  private get missionMdPath(): string {
    return path.join(this.missionDir, 'mission.md');
  }

  /**
   * Read the mission file (accepted proposal)
   */
  async readMissionMd(): Promise<string | null> {
    try {
      return await fs.readFile(this.missionMdPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Read the mission title from mission.md.
   */
  async readMissionTitle(): Promise<string | null> {
    const missionMd = await this.readMissionMd();
    return extractMissionTitleFromMarkdown(missionMd);
  }

  /**
   * Write the mission file (accepted proposal)
   */
  async writeMissionMd(title: string, content: string): Promise<void> {
    const fullContent = `# ${title}\n\n${content}`;
    await fs.writeFile(this.missionMdPath, fullContent);
    this.syncMissionMetadataToCloud();
  }

  // ============ Working Directory ============

  private get workingDirectoryPath(): string {
    return path.join(this.missionDir, 'working_directory.txt');
  }

  /**
   * Store the working directory for this mission
   */
  async writeWorkingDirectory(workingDirectory: string): Promise<void> {
    await fs.writeFile(this.workingDirectoryPath, workingDirectory, 'utf-8');
    this.syncMissionMetadataToCloud();
  }

  /**
   * Read the stored working directory for this mission
   */
  async readWorkingDirectory(): Promise<string | null> {
    try {
      const content = await fs.readFile(this.workingDirectoryPath, 'utf-8');
      return content.trim();
    } catch {
      return null;
    }
  }

  // ============ model-settings.json ============

  private get modelSettingsPath(): string {
    return path.join(this.missionDir, 'model-settings.json');
  }

  /**
   * Read mission-specific model settings.
   * Returns null if file doesn't exist or is invalid JSON.
   */
  async readModelSettings(): Promise<MissionModelSettings | null> {
    try {
      const content = await fs.readFile(this.modelSettingsPath, 'utf-8');
      return JSON.parse(content) as MissionModelSettings;
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      // ENOENT is expected for missions without custom model settings
      if (errorCode !== 'ENOENT') {
        logWarn('[MissionFileService] Failed to read model-settings.json', {
          baseSessionId: this.baseSessionId,
          filePath: this.modelSettingsPath,
          cause: error,
        });
      }
      return null;
    }
  }

  async readEffectiveModelSettings(): Promise<MissionModelSettings> {
    const missionSettings = await this.readModelSettings();
    const globalSettings = getSettingsService().getMissionModelSettings();

    return {
      workerModel: missionSettings?.workerModel ?? globalSettings.workerModel,
      workerReasoningEffort:
        missionSettings?.workerReasoningEffort ??
        globalSettings.workerReasoningEffort,
      validationWorkerModel:
        missionSettings?.validationWorkerModel ??
        globalSettings.validationWorkerModel,
      validationWorkerReasoningEffort:
        missionSettings?.validationWorkerReasoningEffort ??
        globalSettings.validationWorkerReasoningEffort,
      skipScrutiny:
        missionSettings?.skipScrutiny ?? globalSettings.skipScrutiny,
      skipUserTesting:
        missionSettings?.skipUserTesting ?? globalSettings.skipUserTesting,
    };
  }

  /**
   * Write mission-specific model settings.
   * Merges with existing settings if the file already exists.
   */
  async writeModelSettings(
    settings: Partial<MissionModelSettings>
  ): Promise<void> {
    // Read existing settings to merge
    const existing = (await this.readModelSettings()) ?? {};
    const merged: MissionModelSettings = { ...existing, ...settings };

    await fs.writeFile(
      this.modelSettingsPath,
      JSON.stringify(merged, null, 2),
      'utf-8'
    );

    logInfo('[MissionFileService] Wrote mission model settings', {
      baseSessionId: this.baseSessionId,
      workerModel: merged.workerModel,
      validationWorkerModel: merged.validationWorkerModel,
    });
  }

  // ============ runtime-custom-models.json ============

  private get runtimeCustomModelsPath(): string {
    return path.join(this.missionDir, 'runtime-custom-models.json');
  }

  getRuntimeCustomModelsPath(): string {
    return this.runtimeCustomModelsPath;
  }

  async writeRuntimeCustomModels(customModels: CustomModel[]): Promise<string> {
    await this.initializeMissionDir();

    await fs.writeFile(
      this.runtimeCustomModelsPath,
      JSON.stringify({ customModels }, null, 2),
      'utf-8'
    );
    await setSecureFilePermissions(this.runtimeCustomModelsPath);

    logInfo('[MissionFileService] Wrote runtime custom models', {
      baseSessionId: this.baseSessionId,
      count: customModels.length,
      filePath: this.runtimeCustomModelsPath,
    });

    return this.runtimeCustomModelsPath;
  }

  // ============ Utility methods ============

  /**
   * Get all mission file paths
   */
  getFilePaths(): {
    state: string;
    features: string;
    progressLog: string;
    agentsMd: string;
    missionMd: string;
  } {
    return {
      state: this.stateFilePath,
      features: this.featuresFilePath,
      progressLog: this.progressLogPath,
      agentsMd: this.agentsMdPath,
      missionMd: this.missionMdPath,
    };
  }
}

// Singleton cache for mission file services
const missionFileServices = new Map<string, MissionFileService>();
let missionMetadataSyncShutdownHookRegistered = false;

function registerMissionMetadataSyncShutdownHook(): void {
  if (missionMetadataSyncShutdownHookRegistered) {
    return;
  }
  missionMetadataSyncShutdownHookRegistered = true;

  getShutdownCoordinator().registerHook(
    MISSION_METADATA_SYNC_SHUTDOWN_HOOK_NAME,
    async () => {
      await Promise.all(
        Array.from(missionFileServices.values()).map((service) =>
          service.flushPendingMissionMetadataSyncToCloud()
        )
      );
    },
    {
      // Flush pending mission metadata before the general CloudSyncService hook
      // drains tracked requests.
      priority: SHUTDOWN_HOOK_PRIORITY.Default - 1,
    }
  );
}

/**
 * Get or create a MissionFileService for a given session
 */
export function getMissionFileService(
  baseSessionId: string
): MissionFileService {
  registerMissionMetadataSyncShutdownHook();

  let service = missionFileServices.get(baseSessionId);
  if (!service) {
    service = new MissionFileService(baseSessionId);
    missionFileServices.set(baseSessionId, service);
  }
  return service;
}
