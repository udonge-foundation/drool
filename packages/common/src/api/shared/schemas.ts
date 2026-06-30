import { z } from 'zod';

/**
 * Authentication credential schema -- exactly one of token (JWT) or apiKey must be set.
 * Used by relay auth, backend middleware, and daemon connections.
 */
export const AuthCredentialSchema = z.union([
  z.object({
    /** WorkOS JWT access token */
    token: z.string().min(1),
    apiKey: z.never().optional(),
  }),
  z.object({
    token: z.never().optional(),
    /** Industry API key (fk-*) */
    apiKey: z.string().min(1),
  }),
]);
