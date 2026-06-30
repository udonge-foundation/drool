import { IndustryDroolSession } from '@industry/common/sessionV2';
import {
  ManagedSettingsResponseSchema,
  type ManagedSettingsResponse,
} from '@industry/common/settings';

import { fetch } from './fetch';
import {
  UpdateDroolStatusApiParams,
  UpdateDroolStatusResponse,
  UpdateDroolStatusRequestBody,
} from './types';

async function fetchSession(sessionId: string): Promise<IndustryDroolSession> {
  const response = await fetch(`/api/sessions/${sessionId}`);
  return (await response.json()) as IndustryDroolSession;
}

async function getManagedSettings(): Promise<ManagedSettingsResponse> {
  const response = await fetch(`/api/organization/managed-settings`);
  const json = await response.json();
  const parseResult = ManagedSettingsResponseSchema.safeParse(json);

  if (!parseResult.success) {
    return {
      success: false,
      errors: parseResult.error.errors.map((e) => ({
        path: e.path.length > 0 ? e.path.join('.') : '(root)',
        message: e.message,
      })),
    };
  }

  return parseResult.data;
}

async function updateDroolStatus({
  sessionId,
  droolStatus,
  droolProcessId,
  metadata,
  droolRequestId,
}: UpdateDroolStatusApiParams): Promise<UpdateDroolStatusResponse> {
  const response = await fetch(`/api/sessions/${sessionId}/drool-status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      droolStatus,
      droolProcessId,
      metadata,
      ...(droolRequestId && { droolRequestId }),
    } satisfies UpdateDroolStatusRequestBody),
  });

  return (await response.json()) as UpdateDroolStatusResponse;
}

// eslint-disable-next-line industry/constants-file-organization
export const droolApi = {
  fetchSession,
  getManagedSettings,
  updateDroolStatus,
};
