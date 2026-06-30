import { z } from 'zod';

import { TraceContextMetaSchema } from '@industry/drool-sdk-ext/protocol/shared';

import {
  RelayAuthMethod,
  RelayAuthResponseType,
  RelayControlType,
  RelayEnvelopeType,
  RelayFrameType,
} from './enums';
import { AuthCredentialSchema } from '../api/shared';

const withTraceMeta = <TShape extends z.ZodRawShape>(shape: TShape) =>
  z.object({
    ...shape,
    _meta: TraceContextMetaSchema.optional(),
  });

export const RelayEnvelopeSchema = z.discriminatedUnion('type', [
  withTraceMeta({
    type: z.literal(RelayEnvelopeType.ClientConnected),
    clientId: z.string().uuid(),
  }),
  withTraceMeta({
    type: z.literal(RelayEnvelopeType.ClientDisconnected),
    clientId: z.string().uuid(),
  }),
  withTraceMeta({
    type: z.literal(RelayEnvelopeType.ClientFrame),
    clientId: z.string().uuid(),
    frameType: z.nativeEnum(RelayFrameType),
    data: z.string(),
  }),
  withTraceMeta({
    type: z.literal(RelayEnvelopeType.TunnelClientConnected),
    clientId: z.string().uuid(),
    /** Target TCP port on the daemon's localhost */
    port: z.number().int().min(1).max(65535),
  }),
  withTraceMeta({
    type: z.literal(RelayEnvelopeType.TunnelClientDisconnected),
    clientId: z.string().uuid(),
  }),
  withTraceMeta({
    type: z.literal(RelayEnvelopeType.TunnelClientFrame),
    clientId: z.string().uuid(),
    frameType: z.nativeEnum(RelayFrameType),
    data: z.string(),
  }),
]);

/** relay.authenticate = method + credential */
export const RelayAuthenticateRequestSchema = AuthCredentialSchema.and(
  withTraceMeta({
    method: z.literal(RelayAuthMethod.AUTHENTICATE),
  })
);

export const RelayAuthenticateResponseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(RelayAuthResponseType.AuthOk),
  }),
  z.object({
    type: z.literal(RelayAuthResponseType.AuthError),
    message: z.string(),
  }),
]);

const RelayControlSchema = z.object({
  type: z.nativeEnum(RelayControlType),
});

export const RelayPingSchema = RelayControlSchema.refine(
  (v) => v.type === RelayControlType.Ping
);

export const RelayPongSchema = RelayControlSchema.refine(
  (v) => v.type === RelayControlType.Pong
);

export const RelayHealthResponseSchema = z.object({
  githubSha: z.string().optional(),
  /** Present on relays that support relay.authenticate. Absent on old relays. */
  authRequired: z.boolean().optional(),
});

/**
 * Per-computer status reported by the relay's internal observability
 * endpoint. `lastFrameAt` is the ISO timestamp of the most recent inbound
 * frame from the daemon, or `null` when no session exists / the daemon
 * disconnected / no frame has arrived yet. Callers decide liveness by
 * comparing this against COMPUTER_STALE_MS; an absent or stale value
 * means the relay would refuse to forward to the daemon anyway.
 */
export const RelayComputerStatusSchema = z.object({
  lastFrameAt: z.string().datetime().nullable(),
  relayInstanceId: z.string(),
});
