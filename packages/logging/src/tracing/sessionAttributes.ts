import * as SessionTypes from '@industry/drool-sdk-ext/protocol/session';

import { SessionKind, SpanAttribute } from './enums';

import type {
  DerivedSessionAttribution,
  IndustryCreateSessionSpanParams,
  IndustrySessionAttributionParams,
  SessionAttributionPlatform,
} from './types';
import type { Attributes } from '@opentelemetry/api';

/** Origins that represent direct human interaction. */
const USER_ORIGINS = new Set<string>([
  SessionTypes.SessionOrigin.Web,
  SessionTypes.SessionOrigin.Desktop,
  SessionTypes.SessionOrigin.CliTui,
  SessionTypes.SessionOrigin.CliExec,
  SessionTypes.SessionOrigin.CliAcp,
]);

/** Origins that represent external integration triggers. */
const DELEGATION_ORIGINS = new Set<string>([
  SessionTypes.SessionOrigin.Slack,
  SessionTypes.SessionOrigin.Linear,
  SessionTypes.SessionOrigin.SessionsApi,
  SessionTypes.SessionOrigin.Api,
]);

/** Origins that represent internal platform automations. */
const AUTOMATION_ORIGINS = new Set<string>([
  SessionTypes.SessionOrigin.Automation,
  SessionTypes.SessionOrigin.ReadinessRemediation,
  SessionTypes.SessionOrigin.ReadinessEvaluation,
  SessionTypes.SessionOrigin.WikiGeneration,
  SessionTypes.SessionOrigin.WikiCiSetup,
]);

/**
 * Derive session kind from origin and an optional kind hint.
 *
 * The kind hint is used for child sessions (subagent, mission_worker) where
 * the spawning context knows the kind but the origin is inherited from the
 * root ancestor. For top-level sessions the kind is derived from the origin.
 *
 * This is the single source of truth for the derivation rules. Dashboard
 * queries should use the materialized `industry.session.kind` attribute
 * instead of reimplementing this logic.
 */
/** @public */
export function deriveSessionKind(
  origin: SessionTypes.SessionOrigin | undefined,
  kindHint: SessionKind | undefined
): SessionKind {
  if (kindHint) return kindHint;
  if (!origin) return SessionKind.User;
  if (USER_ORIGINS.has(origin)) return SessionKind.User;
  if (DELEGATION_ORIGINS.has(origin)) return SessionKind.Delegation;
  if (AUTOMATION_ORIGINS.has(origin)) return SessionKind.Automation;
  return SessionKind.User;
}

/**
 * Returns span attributes for session lineage and classification.
 *
 * Stamps:
 * - `industry.session.parent_id` -- parent session (subagent/worker only)
 * - `industry.session.calling_tool_use_id` -- spawning tool call
 * - `industry.session.kind` -- user | subagent | mission_worker | delegation | automation
 * - `industry.session.origin` -- how the session was created
 */
export function getIndustrySessionAttributionAttributes(
  params: IndustrySessionAttributionParams
): Attributes {
  const kind =
    params.sessionKind ?? deriveSessionKind(params.sessionOrigin, undefined);
  return {
    ...(params.callingSessionId && {
      [SpanAttribute.INDUSTRY_SESSION_PARENT_ID]: params.callingSessionId,
    }),
    ...(params.callingToolUseId && {
      [SpanAttribute.INDUSTRY_SESSION_CALLING_TOOL_USE_ID]:
        params.callingToolUseId,
    }),
    [SpanAttribute.INDUSTRY_SESSION_KIND]: kind,
    ...(params.sessionOrigin && {
      [SpanAttribute.INDUSTRY_SESSION_ORIGIN]: params.sessionOrigin,
    }),
  };
}

export function getIndustryCreateSessionSpanAttributes(
  params: IndustryCreateSessionSpanParams
): Attributes {
  return {
    ...(params.sessionId && {
      [SpanAttribute.SESSION_ID]: params.sessionId,
    }),
    ...getIndustrySessionAttributionAttributes(params),
  };
}

function mapPlatformToOrigin(
  platform: SessionAttributionPlatform
): SessionTypes.SessionOrigin {
  switch (platform) {
    case undefined:
      return SessionTypes.SessionOrigin.Api;
    case SessionTypes.SessionPlatform.Slack:
      return SessionTypes.SessionOrigin.Slack;
    case SessionTypes.SessionPlatform.Linear:
      return SessionTypes.SessionOrigin.Linear;
    case SessionTypes.SessionPlatform.Api:
      return SessionTypes.SessionOrigin.Api;
    case SessionTypes.SessionPlatform.SessionsApi:
      return SessionTypes.SessionOrigin.SessionsApi;
    case SessionTypes.SessionPlatform.Web:
      return SessionTypes.SessionOrigin.Web;
    case SessionTypes.SessionPlatform.ReadinessRemediation:
      return SessionTypes.SessionOrigin.ReadinessRemediation;
    case SessionTypes.SessionPlatform.ReadinessEvaluation:
      return SessionTypes.SessionOrigin.ReadinessEvaluation;
    case SessionTypes.SessionPlatform.Automation:
      return SessionTypes.SessionOrigin.Automation;
    case SessionTypes.SessionPlatform.WikiGeneration:
      return SessionTypes.SessionOrigin.WikiGeneration;
    case SessionTypes.SessionPlatform.WikiCISetup:
      return SessionTypes.SessionOrigin.WikiCiSetup;
    default:
      return SessionTypes.SessionOrigin.Automation;
  }
}

export function deriveSessionAttributionFromPlatform(
  platform: SessionAttributionPlatform
): DerivedSessionAttribution {
  const sessionOrigin = mapPlatformToOrigin(platform);
  return {
    sessionOrigin,
    sessionKind: deriveSessionKind(sessionOrigin, undefined),
  };
}
