/**
 * Automation sync service.
 *
 * Handles syncing local automations to the backend API and uploading
 * visual content through the backend (which has S3 access).
 */

import { ACTIVE_ORGANIZATION_HEADER } from '@industry/drool-sdk-ext/protocol/drool';
import { logException, logInfo, logWarn, MetaError } from '@industry/logging';
import { getActiveOrganizationId, getAuthToken } from '@industry/runtime/auth';

import type { SyncResult } from './types';
import type { AutomationSyncResponse } from '@industry/common/api/backend/types';
import type { Automation } from '@industry/common/api/v0/automations';
import type { RuntimeAuthConfig } from '@industry/runtime/auth';

// =============================================================================
// Sync Functions
// =============================================================================

/**
 * Upload a visual HTML snapshot to the backend for S3 storage.
 *
 * Resolves the auth token internally; callers must thread the backend URL
 * (this package has no direct env access — see PR #12549).
 */
export async function uploadVisualToBackend(
  automationUuid: string,
  sessionId: string,
  visualContent: string,
  backendUrl: string,
  runtimeAuthConfig: RuntimeAuthConfig
): Promise<boolean> {
  const authToken = await getAuthToken(runtimeAuthConfig);
  const activeOrganizationId = await getActiveOrganizationId(runtimeAuthConfig);
  if (!authToken) {
    logWarn('Visual upload skipped: no auth token');
    return false;
  }

  const response = await fetch(
    `${backendUrl}/api/automations/${automationUuid}/visual`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        ...(activeOrganizationId && {
          [ACTIVE_ORGANIZATION_HEADER]: activeOrganizationId,
        }),
      },
      body: JSON.stringify({ sessionId, visualContent }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    logWarn('Visual upload failed', {
      statusCode: response.status,
      errorMessage: errorText,
    });
    throw new MetaError('Visual upload failed', {
      statusCode: response.status,
      errorMessage: errorText,
    });
  }

  logInfo('Visual uploaded to backend', {
    automationId: automationUuid,
    sessionId,
  });
  return true;
}

/**
 * Persist a local pre-session dispatch failure as an automation run record.
 *
 * The daemon dispatch path (poller → session) only produces a run record once
 * a chat session exists. Failures that happen before any session is created
 * (`dispatch_skipped`, `dispatch_failed`, `dispatch_exception`) would otherwise
 * emit metrics only and never reach Firestore/BigQuery, dropping them from the
 * run denominator. This routes them through the backend (which has Firestore
 * access) so they are counted. Best-effort: resolves auth internally and
 * returns quietly when unauthenticated.
 */
export async function recordRunFailureToBackend(
  automationUuid: string,
  params: { failureReason: string; triggerSource?: string },
  backendUrl: string,
  runtimeAuthConfig: RuntimeAuthConfig
): Promise<void> {
  const authToken = await getAuthToken(runtimeAuthConfig);
  const activeOrganizationId = await getActiveOrganizationId(runtimeAuthConfig);
  if (!authToken) {
    logWarn('Run-failure record skipped: no auth token');
    return;
  }

  const response = await fetch(
    `${backendUrl}/api/automations/${automationUuid}/runs/failure`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        ...(activeOrganizationId && {
          [ACTIVE_ORGANIZATION_HEADER]: activeOrganizationId,
        }),
      },
      body: JSON.stringify({
        failureReason: params.failureReason,
        ...(params.triggerSource
          ? { triggerSource: params.triggerSource }
          : {}),
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new MetaError('Run-failure record failed', {
      statusCode: response.status,
      errorMessage: errorText,
    });
  }

  logInfo('Run-failure record persisted', {
    automationId: automationUuid,
    failureReason: params.failureReason,
  });
}

/**
 * Sync local automations to the backend API.
 *
 * @param automations - Array of automation data to sync
 * @param backendUrl - Backend API base URL
 * @param authToken - Bearer authentication token
 * @returns Sync result with counts of synced/collided/errored automations
 */
export async function syncAutomationsToBackend(
  automations: Automation[],
  backendUrl: string,
  authToken: string,
  activeOrganizationId?: string | null
): Promise<SyncResult> {
  try {
    const response = await fetch(`${backendUrl}/api/automations/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        ...(activeOrganizationId && {
          [ACTIVE_ORGANIZATION_HEADER]: activeOrganizationId,
        }),
      },
      body: JSON.stringify({ automations }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logWarn('Automation sync failed', {
        statusCode: response.status,
        errorMessage: errorText,
      });
      return { synced: 0, collisions: [], errors: [errorText], deleted: [] };
    }

    const result: AutomationSyncResponse = await response.json();
    logInfo('Automation sync completed');
    return {
      synced: result.synced,
      collisions: result.collisions,
      errors: [],
      deleted: result.deleted ?? [],
    };
  } catch (error) {
    logException(error, 'Failed to sync automations to backend');
    return { synced: 0, collisions: [], errors: [String(error)], deleted: [] };
  }
}
