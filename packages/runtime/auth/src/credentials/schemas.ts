import { z } from 'zod';

import type { StoredCredentials } from '../storage/common/types';

/**
 * Schema for stored credentials.
 * Matches the CLI's existing StoredAuth format for compatibility.
 */
export const StoredCredentialsSchema: z.ZodType<StoredCredentials> = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  active_organization_id: z.string().nullable().optional(),
});

/**
 * Schema for WorkOS JWT payload.
 * Based on actual WorkOS token structure.
 */
export const WorkOSJwtPayloadSchema = z.object({
  // Standard JWT claims
  iss: z.string().optional(),
  sub: z.string(),
  jti: z.string().optional(),
  exp: z.number().optional(),
  iat: z.number().optional(),

  // WorkOS user fields
  object: z.literal('user').optional(),
  id: z.string().optional(),
  email: z.string(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  email_verified: z.boolean().optional(),
  profile_picture_url: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),

  // Organization fields (org_id = WorkOS internal, external_org_id = our Firestore org ID)
  org_id: z.string().optional(),
  external_org_id: z.string().optional(),
  sid: z.string().optional(),

  // Role/permissions
  role: z.string().optional(),
  roles: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
});
