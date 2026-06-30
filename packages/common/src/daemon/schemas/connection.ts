import z from 'zod';

import {
  JsonRpcBaseRequestSchema,
  JsonRpcBaseResponseSuccessSchema,
  JsonRpcBaseResponseFailureSchema,
  JsonRpcBaseNotificationSchema,
} from '@industry/drool-sdk-ext/protocol/shared';

import { DaemonConnectionMethod, DaemonConnectionEvent } from './enums';
import { Platform } from '../../shared/enums';

/**
 * Client-supplied metadata attached to the authenticate handshake.
 * Extensible: new fields can be added here without changing the
 * transport protocol. The daemon stores these on the connection
 * context and uses them for span attribution.
 */
export const DaemonConnectionMetadataSchema = z.object({
  tracing: z
    .object({
      /** Human interaction surface (e.g., 'web', 'desktop', 'cli_tui'). Absent for infrastructure callers. */
      app: z.string().optional(),
      /** Client-relative machine classification: local | ephemeral | computer. */
      machineType: z.string().optional(),
      /** Computer provider: byom | e2b. */
      machineProvider: z.string().optional(),
      /** Transport kind: ws_localhost | ws_direct | ws_relay. */
      daemonTransport: z.string().optional(),
    })
    .optional(),
});

// Connection-level authentication schemas
export const DaemonAuthenticateRequestParamsSchema = z
  .object({
    /** WorkOS JWT access token */
    token: z.string().optional(),
    /** Industry API key (fk-*) */
    apiKey: z.string().optional(),
    /**
     * Act-as delegation grant (`fdg-*`). Presented alongside `token` by a
     * Manager driving a session against a service-account-owned daemon. The
     * daemon verifies it against the backend (as the SA) and, on success,
     * authenticates the connection as the SA with the manager as operator.
     */
    actAsGrant: z.string().optional(),
    /** Frontend-generated connection ID for trace correlation */
    connectionId: z.string().optional(),
    /** Caller identifier for debugging (e.g., 'frontend', 'backend-v0-sessions', 'cli') */
    caller: z.string(),
    /** Client-supplied metadata for tracing and diagnostics. */
    metadata: DaemonConnectionMetadataSchema.optional(),
  })
  .refine((data) => data.token || data.apiKey, {
    message: 'Either token or apiKey must be provided',
  })
  .refine((data) => !data.actAsGrant || Boolean(data.token), {
    message: 'actAsGrant requires token',
  });

export const DaemonAuthenticateRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DaemonConnectionMethod.AUTHENTICATE),
  params: DaemonAuthenticateRequestParamsSchema,
});

export const DaemonAuthenticateResultSchema = z.object({
  userId: z.string(),
  orgId: z.string(),
});

export const DaemonAuthenticateResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: DaemonAuthenticateResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const DaemonLogoutRequestParamsSchema = z.object({}).strict();

export const DaemonLogoutRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DaemonConnectionMethod.LOGOUT),
  params: DaemonLogoutRequestParamsSchema,
});

export const DaemonLogoutResultSchema = z.object({
  accepted: z.literal(true),
});

export const DaemonLogoutResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: DaemonLogoutResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

// Connection status notification schemas
export const DaemonConnectionStatusNotificationParamsSchema = z.object({
  isDroolCLIInPath: z.boolean(),
  droolCLIVersion: z.string().optional(),
  homedir: z.string(),
  platform: z.nativeEnum(Platform),
});

export const DaemonConnectionStatusNotificationSchema =
  JsonRpcBaseNotificationSchema.extend({
    method: z.literal(DaemonConnectionEvent.CONNECTION_STATUS),
    params: DaemonConnectionStatusNotificationParamsSchema,
  });

// Inferred types
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export type DaemonConnectionMetadata = z.infer<
  typeof DaemonConnectionMetadataSchema
>;
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export type DaemonAuthenticateRequestParams = z.infer<
  typeof DaemonAuthenticateRequestParamsSchema
>;
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export type DaemonAuthenticateRequest = z.infer<
  typeof DaemonAuthenticateRequestSchema
>;
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export type DaemonAuthenticateResult = z.infer<
  typeof DaemonAuthenticateResultSchema
>;
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export type DaemonAuthenticateResponse = z.infer<
  typeof DaemonAuthenticateResponseSchema
>;
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export type DaemonLogoutRequestParams = z.infer<
  typeof DaemonLogoutRequestParamsSchema
>;
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export type DaemonLogoutRequest = z.infer<typeof DaemonLogoutRequestSchema>;
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export type DaemonLogoutResult = z.infer<typeof DaemonLogoutResultSchema>;
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export type DaemonLogoutResponse = z.infer<typeof DaemonLogoutResponseSchema>;
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export type DaemonConnectionStatusNotificationParams = z.infer<
  typeof DaemonConnectionStatusNotificationParamsSchema
>;
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export type DaemonConnectionStatusNotification = z.infer<
  typeof DaemonConnectionStatusNotificationSchema
>;
