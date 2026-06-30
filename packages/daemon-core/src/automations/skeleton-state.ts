/**
 * Shared in-memory skeleton state for automation control-plane.
 *
 * This module holds the singleton state and accessor functions used
 * across control-plane action modules (runAutomation, getHistory, etc.).
 */

import { AutomationStatus } from '@industry/common/api/v0/automations';
import {
  AutomationErrorCode,
  AutomationPrivacyLevel,
  type AutomationError,
  type AutomationRunRecord,
  type AutomationRuntimeState,
} from '@industry/common/automations';

import { computeNextRunISO } from './computeNextRunISO';

import type { PendingRetryInfo } from './types';

interface SkeletonState {
  statuses: Map<string, AutomationStatus>;
  runHistory: Map<string, AutomationRunRecord[]>;
  currentRuns: Map<string, string>;
  degradedReasons: Map<string, string>;
  pendingRetries: Map<string, PendingRetryInfo>;
}

export function getRetryDelayMs(): number {
  return 5 * 60 * 1000;
}

export function getMaxRunHistory(): number {
  return 100;
}

function createSkeletonState(): SkeletonState {
  return {
    statuses: new Map(),
    runHistory: new Map(),
    currentRuns: new Map(),
    degradedReasons: new Map(),
    pendingRetries: new Map(),
  };
}

export const skeletonState = createSkeletonState();

export function getAutomationStatus(automationId: string): AutomationStatus {
  return skeletonState.statuses.get(automationId) ?? AutomationStatus.Active;
}

export function setAutomationStatus(
  automationId: string,
  status: AutomationStatus
): void {
  skeletonState.statuses.set(automationId, status);
}

export function notFoundError(id: string): AutomationError {
  return {
    code: AutomationErrorCode.NotFound,
    message: `Automation '${id}' not found`,
  };
}

function toPrivacyLevel(
  value: string | undefined
): AutomationPrivacyLevel | undefined {
  if (value === AutomationPrivacyLevel.Private) {
    return AutomationPrivacyLevel.Private;
  }
  if (value === AutomationPrivacyLevel.Organization) {
    return AutomationPrivacyLevel.Organization;
  }
  return undefined;
}

export function descriptorToRuntimeState(
  descriptor: {
    id: string;
    path: string;
    config: {
      id?: string;
      name: string;
      description?: string;
      schedule: { cadence: string };
      model?: string;
      tags?: string[];
      paused?: boolean;
      privacyLevel?: string;
      createdBy?: {
        name: string;
        email?: string;
        avatarUrl?: string;
      };
    };
    structure: {
      hasHeartbeat: boolean;
      hasVisual: boolean;
      hasMemoryDir: boolean;
      hasReportsDir: boolean;
    };
  },
  status?: AutomationStatus
): AutomationRuntimeState {
  if (!skeletonState.statuses.has(descriptor.id) && descriptor.config.paused) {
    skeletonState.statuses.set(descriptor.id, AutomationStatus.Paused);
  }
  const automationStatus = status ?? getAutomationStatus(descriptor.id);
  const runs = skeletonState.runHistory.get(descriptor.id) ?? [];
  const lastRun = runs[0];
  const currentRunId = skeletonState.currentRuns.get(descriptor.id);

  const isPaused = automationStatus === AutomationStatus.Paused;
  const nextRunAt = computeNextRunISO(descriptor.config.schedule, isPaused);

  return {
    id: descriptor.id,
    path: descriptor.path,
    config: {
      id: descriptor.config.id,
      name: descriptor.config.name,
      description: descriptor.config.description,
      schedule: descriptor.config.schedule,
      model: descriptor.config.model,
      tags: descriptor.config.tags,
      privacyLevel: toPrivacyLevel(descriptor.config.privacyLevel),
      createdBy: descriptor.config.createdBy,
    },
    status: automationStatus,
    lastRunAt: lastRun?.startedAt,
    nextRunAt,
    lastRunId: lastRun?.runId,
    lastRunStatus: lastRun?.status,
    isRunning: currentRunId !== undefined,
    currentRunId,
    structure: {
      hasHeartbeat: descriptor.structure.hasHeartbeat,
      hasVisual: descriptor.structure.hasVisual,
      hasMemoryDir: descriptor.structure.hasMemoryDir,
      hasReportsDir: descriptor.structure.hasReportsDir,
    },
    ...(automationStatus === AutomationStatus.Degraded && {
      degradedReason: skeletonState.degradedReasons.get(descriptor.id),
    }),
  };
}
