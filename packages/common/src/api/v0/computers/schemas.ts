import { z } from 'zod';

import { HostIdSchema } from '@industry/drool-sdk-ext/protocol/host';

import { ComputerSource, ComputerProviderType, ComputerStatus } from './enums';

export const ComputerIdSchema = z
  .object({
    computerId: z.string().describe('Computer ID'),
  })
  .strict();

export const ComputerNameSchema = z
  .object({
    name: z.string().min(1).max(63).describe('Computer name'),
  })
  .strict();

/**
 * Internal-only shape of a single provisioning step. Used by backend
 * code to track progress; intentionally NOT included on `ComputerSchema`
 * so the wire surface stays minimal and forward-compatible. Wizard
 * progress is surfaced via `currentProvisioningStep` (the in-flight
 * step object) only — the frontend interpolates a percent locally
 * using the shared `PROVISIONING_STEP_*` constants.
 */
export const ProvisioningStepSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  error: z.string().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  /**
   * Set only on the install-deps step: ID of the Drool session
   * spawned to autonomously install repo dependencies. Lives on the
   * step (not top-level) so every install-related field is in one
   * place, and so the wizard / settings card can deep-link from the
   * step's name without separate lookup state.
   */
  installSessionId: z.string().optional(),
});

export const ComputerSchema = z.object({
  id: z.string(),
  hostId: HostIdSchema.optional(),
  name: z.string(),
  hostname: z.string().optional(),
  providerType: z.nativeEnum(ComputerProviderType),
  status: z.nativeEnum(ComputerStatus).optional(),
  createdAt: z.number(),
  provisioningSteps: z.array(ProvisioningStepSchema).optional(),
  relayClientUrl: z.string().url().optional(),
  relayAgentUrl: z.string().url().optional(),
  remoteUser: z.string().optional(),
  /** Absent → human-owned. Typed as `z.string()` so pinned older clients tolerate future principal-kind additions. */
  ownerPrincipalKind: z.string().optional(),
  ownerId: z.string().optional(),
  /**
   * Provenance for computers created from another source. Absent means the
   * computer was created from scratch.
   */
  computerSource: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal(ComputerSource.Template),
        templateId: z.string().min(1),
      }),
      z.object({
        kind: z.literal(ComputerSource.Computer),
        computerId: z.string().min(1),
      }),
    ])
    .optional(),
});

export const ComputerListResponseSchema = z.object({
  computers: z.array(ComputerSchema),
});

export const ListComputersQuerySchema = z.object({
  hostId: HostIdSchema.optional(),
  // next-rest-framework models query params as strings (its `BaseQuery` is
  // `Record<string, string | string[]>`), so this is validated as a string
  // literal and converted to a boolean at the call site rather than typed
  // directly as `z.boolean()`.
  includeProvisioningSteps: z
    .enum(['true', 'false'])
    .optional()
    .describe('Whether to include provisioning step details.'),
});

/**
 * Clone-URL schema shared across every `repos` field.
 *
 * Guarded against three failure modes that `z.string().url()` alone
 * does not cover:
 *
 * 1. Embedded credentials — URLs whose URL components carry basic
 *    auth (a non-empty username or secret in the URL) must be
 *    rejected so those values can never enter provisioning logs or
 *    Firestore.
 * 2. Non-git protocols — only `http(s)`, `git`, and `ssh` are honored by
 *    the downstream `git clone` call, so other protocols are rejected
 *    here rather than at execution time.
 * 3. Length cap — long/hostile URLs get truncated at the schema layer so
 *    downstream logs / DB writes never see an unbounded string.
 */
const ALLOWED_CLONE_PROTOCOLS = new Set(['http:', 'https:', 'git:', 'ssh:']);

// Rely on `URL.canParse` (Node 22+) instead of a try/catch around
// `new URL()` so the refine stays cleanly synchronous and the project
// catch-handling lint rule doesn't force a log/rethrow in what is
// really a validation check.
const CloneUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine(
    (value) => {
      if (!URL.canParse(value)) return false;
      const parsed = new URL(value);
      if (!ALLOWED_CLONE_PROTOCOLS.has(parsed.protocol)) return false;
      // Reject credentials embedded in the URL (PATs, basic-auth) —
      // clients should rely on server-side credential helpers.
      if (parsed.username !== '' || parsed.password !== '') return false;
      return true;
    },
    {
      message:
        'Clone URL must use http(s), git, or ssh, must not contain embedded credentials, and must be ≤ 2048 chars.',
    }
  );

/**
 * Discriminated union describing non-scratch sources. Omitted on the wire ⇒
 * create from scratch. Per-instantiation env-var overrides are intentionally
 * NOT supported here — that surface lands with RT-90's structured
 * `ComputerEnvVarBinding`.
 */
export const CreateComputerSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal(ComputerSource.Template),
      templateId: z.string().min(1),
    })
    .strict(),
  /**
   * Fork from an existing live Computer. Scaffolding only in v1 — the
   * handler currently returns 501 until `provider.forkComputer` +
   * `rebindIdentity` are implemented per provider.
   */
  z
    .object({
      kind: z.literal(ComputerSource.Computer),
      sourceComputerId: z.string().min(1),
    })
    .strict(),
]);

export const CreateComputerRequestSchema = z
  .object({
    name: z.string().min(1).max(63),
    provider: z.nativeEnum(ComputerProviderType).optional(),
    hostId: HostIdSchema.optional(),
    /**
     * OS account the daemon SSHes into. Required for `Scratch`
     * (BYOM customer-chosen + managed scratch carries it as metadata
     * even though E2B always uses `industry-user`); forbidden for
     * `Template` / `Computer` where the snapshot bakes in
     * `industry-user` and a caller-supplied value would be ignored —
     * see `superRefine` below.
     */
    remoteUser: z.string().min(1).max(63).optional(),
    /**
     * Optional list of git clone URLs to clone onto the computer as part of
     * provisioning. Only honored by managed providers (e.g. E2B).
     */
    repos: z.array(CloneUrlSchema).max(20).optional(),
    /**
     * If true, the computer will run a session after repos are
     * cloned to detect and install project dependencies (npm, pip, cargo, etc.).
     * Only honored by managed providers (e.g. E2B). Currently surfaced via the
     * frontend Setup Configuration step in the create-computer wizard.
     */
    autoInstallDeps: z.boolean().optional(),
    /** Omitted → caller-as-owner. Set → create on behalf of the named SA (requires human Manager+). */
    serviceAccountId: z.string().min(1).optional(),
    /**
     * Non-scratch provisioning source discriminator. Omitted means create
     * from scratch. When set to `Template` or `Computer`, `provider` /
     * `hostId` / `repos` / `autoInstallDeps` must not be supplied — the
     * source dictates those values.
     */
    source: CreateComputerSourceSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.source === undefined) {
      // Scratch (incl. BYOM) requires `remoteUser` — the daemon needs
      // an OS account to SSH into.
      if (val.remoteUser === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['remoteUser'],
          message: 'remoteUser is required when source is omitted.',
        });
      }
      return;
    }
    // Template / Computer arms: forbid scratch-only fields. The
    // snapshot already encodes provider / repos / remote user.
    for (const field of [
      'provider',
      'hostId',
      'remoteUser',
      'repos',
      'autoInstallDeps',
    ] as const) {
      if (val[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is not allowed when source.kind === '${val.source.kind}'.`,
        });
      }
    }
  });

export const UpdateComputerRequestSchema = z.object({
  name: z.string().min(1).max(63).optional(),
  hostId: HostIdSchema.optional(),
  /** OS account on the BYOM machine that Drool will SSH into */
  remoteUser: z.string().min(1).max(63).optional(),
});

export const ComputerMetricSchema = z.object({
  timestamp: z.string(),
  cpuUsedPct: z.number(),
  cpuCount: z.number(),
  memUsed: z.number(),
  memTotal: z.number(),
  diskUsed: z.number(),
  diskTotal: z.number(),
});

export const ComputerMetricsResponseSchema = z.array(ComputerMetricSchema);

export const ComputerMetricsQuerySchema = z
  .object({
    start: z
      .string()
      .datetime()
      .optional()
      .describe('Start of time range (ISO 8601)'),
  })
  .strict();
