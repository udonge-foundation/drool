import { z } from 'zod';

/** Response from WorkOS device authorization endpoint */
export const DeviceAuthorizationResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  expires_in: z.number(),
  interval: z.number(),
});

/** Response from WorkOS token endpoints (authenticate) */
export const TokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
});

/** Error response during device code polling */
export const PollingErrorResponseSchema = z.object({
  error: z.string(),
});
