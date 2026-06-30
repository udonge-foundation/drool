import {
  ManagedSettingsResponseSchema,
  type ManagedSettingsResponse,
} from '@industry/common/settings';
import { fetch } from '@industry/utils/api/fetch';

export async function getManagedSettings(): Promise<ManagedSettingsResponse> {
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
