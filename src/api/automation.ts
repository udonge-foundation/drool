import { z } from 'zod';

import {
  Automation,
  AutomationListResponse,
  AutomationListResponseSchema,
  AutomationSchema,
  CreateAutomationRequest,
  UpdateAutomationRequest,
} from '@industry/common/api/v0/automations';
import { fetch } from '@industry/drool-core/api/fetch';
import { isFetchError, MetaError } from '@industry/logging/errors';

const AutomationRunResponseSchema = z.object({
  message: z.string(),
  sessionId: z.string(),
});

function automationPath(automationId: string): string {
  return `/api/v0/automations/${encodeURIComponent(automationId)}`;
}

// Automation payloads carry user-authored content (name/prompt/description),
// so response bodies must never be attached to error metadata. Surface only
// the failing field paths and Zod issue codes for debugging.
function parseFailureMetadata(error: z.ZodError): {
  data: { issues: string[] };
} {
  return {
    data: {
      issues: error.issues.map(
        (issue) => `${issue.path.join('.') || '<root>'}: ${issue.code}`
      ),
    },
  };
}

/** Create a cloud scheduled automation. */
export async function createAutomation(
  body: CreateAutomationRequest
): Promise<Automation> {
  const response = await fetch('/api/v0/automations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  const result = AutomationSchema.safeParse(data);
  if (!result.success) {
    throw new MetaError(
      'Invalid automation response from create',
      parseFailureMetadata(result.error)
    );
  }
  return result.data;
}

/** Trigger an immediate run of an automation. Returns the started session. */
export async function runAutomation(
  automationId: string
): Promise<z.infer<typeof AutomationRunResponseSchema>> {
  const response = await fetch(`${automationPath(automationId)}/run`, {
    method: 'POST',
  });
  const data = await response.json();
  const result = AutomationRunResponseSchema.safeParse(data);
  if (!result.success) {
    throw new MetaError(
      'Invalid automation run response',
      parseFailureMetadata(result.error)
    );
  }
  return result.data;
}

/** Fetch a single automation by ID. Returns null if not found (404). */
export async function getAutomation(
  automationId: string
): Promise<Automation | null> {
  try {
    const response = await fetch(automationPath(automationId));
    const data = await response.json();
    const result = AutomationSchema.safeParse(data);
    if (!result.success) {
      throw new MetaError(
        'Invalid automation response',
        parseFailureMetadata(result.error)
      );
    }
    return result.data;
  } catch (error) {
    if (isFetchError(error) && error.response.status === 404) {
      return null;
    }
    throw error;
  }
}

/** List all cloud scheduled automations for the authenticated user's org. */
export async function listAutomations(): Promise<AutomationListResponse> {
  const response = await fetch('/api/v0/automations');
  const data = await response.json();
  const result = AutomationListResponseSchema.safeParse(data);
  if (!result.success) {
    throw new MetaError(
      'Invalid automation list response',
      parseFailureMetadata(result.error)
    );
  }
  return result.data;
}

/** Update an automation by ID. */
export async function updateAutomation(
  automationId: string,
  body: UpdateAutomationRequest
): Promise<Automation> {
  const response = await fetch(automationPath(automationId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  const result = AutomationSchema.safeParse(data);
  if (!result.success) {
    throw new MetaError(
      'Invalid automation response from update',
      parseFailureMetadata(result.error)
    );
  }
  return result.data;
}

/** Delete (soft) an automation by ID. */
export async function deleteAutomation(automationId: string): Promise<void> {
  await fetch(automationPath(automationId), { method: 'DELETE' });
}
