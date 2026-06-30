import * as crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { AutomationListResponse } from '@industry/common/api/v0/automations';
import { PushGitAiPullRequestRequest } from '@industry/common/api/v0/git-ai';
import {
  AUTOMATION_HEARTBEAT_FILE,
  AUTOMATION_VISUAL_FILE,
  type ValidAutomationDescriptor,
} from '@industry/common/automations';
import {
  DaemonAddUserMessageResult,
  DaemonInitializeSessionResult,
  DaemonInterruptSessionResult,
  DaemonCloseSessionResult,
  DaemonListOpenedSessionsResult,
  DaemonListAvailableSessionsResult,
  DaemonLoadSessionResult,
  DaemonResolveQueuedUserMessageRequest,
  DaemonResolveQueuedUserMessageResult,
  DaemonUpdateSessionSettingsResult,
  DaemonDroolEvent,
  DaemonDroolMethod,
  DaemonRequestSchema,
  DaemonInitializeSessionRequest,
  DaemonLoadSessionRequest,
  DaemonAddUserMessageRequest,
  DaemonInterruptSessionRequest,
  DaemonCloseSessionRequest,
  DaemonKillWorkerSessionRequest,
  DaemonKillWorkerSessionResult,
  DaemonUpdateSessionSettingsRequest,
  DaemonRequestPermission,
  DaemonAskUser,
  DaemonSessionNotification,
  DaemonListOpenedSessionsRequest,
  DaemonListAvailableSessionsRequest,
  DaemonGetSessionMessagesRequest,
  DaemonGetSessionMessagesResult,
  DaemonToggleMcpServerRequest,
  McpSuccessResult,
  DaemonAuthenticateMcpServerRequest,
  DaemonCancelMcpAuthRequest,
  DaemonClearMcpAuthRequest,
  DaemonListFilesRequest,
  DaemonListFilesResult,
  DaemonSearchFilesRequest,
  DaemonSearchFilesResult,
  DaemonAddMcpServerRequest,
  DaemonRemoveMcpServerRequest,
  DaemonListMcpRegistryRequest,
  DaemonListMcpRegistryResult,
  DaemonListMcpRegistryResultSchema,
  DaemonListMcpToolsRequest,
  DaemonListMcpToolsResult,
  DaemonListMcpToolsResultSchema,
  DaemonListMcpServersRequest,
  DaemonListMcpServersResult,
  DaemonListMcpServersResultSchema,
  DaemonToggleMcpToolRequest,
  DaemonSubmitMcpAuthCodeRequest,
  DaemonSubmitMcpAuthErrorRequest,
  DaemonSearchSessionsRequest,
  DaemonSearchSessionsResult,
  DaemonArchiveSessionRequest,
  DaemonArchiveSessionResult,
  DaemonUnarchiveSessionRequest,
  DaemonUnarchiveSessionResult,
  DaemonRenameSessionRequest,
  DaemonRenameSessionResult,
  DaemonListSkillsRequest,
  DaemonListSkillsResult,
  DaemonListCommandsRequest,
  DaemonListCommandsResult,
  DaemonListCommandsResultSchema,
  DaemonListAvailablePluginsRequest,
  DaemonListAvailablePluginsResult,
  DaemonListAvailablePluginsResultSchema,
  DaemonListInstalledPluginsRequest,
  DaemonListInstalledPluginsResult,
  DaemonListInstalledPluginsResultSchema,
  DaemonInstallPluginRequest,
  DaemonInstallPluginResult,
  DaemonInstallPluginResultSchema,
  DaemonUninstallPluginRequest,
  DaemonUninstallPluginResult,
  DaemonUninstallPluginResultSchema,
  DaemonSetPluginEnabledRequest,
  DaemonSetPluginEnabledResult,
  DaemonSetPluginEnabledResultSchema,
  DaemonUpdatePluginRequest,
  DaemonUpdatePluginResult,
  DaemonUpdatePluginResultSchema,
  DaemonListMarketplacesRequest,
  DaemonListMarketplacesResult,
  DaemonListMarketplacesResultSchema,
  DaemonAddMarketplaceRequest,
  DaemonAddMarketplaceResult,
  DaemonAddMarketplaceResultSchema,
  DaemonRemoveMarketplaceRequest,
  DaemonRemoveMarketplaceResult,
  DaemonRemoveMarketplaceResultSchema,
  DaemonUpdateMarketplaceRequest,
  DaemonUpdateMarketplaceResult,
  DaemonUpdateMarketplaceResultSchema,
  DaemonSubmitBugReportRequest,
  DaemonSubmitBugReportResult,
  DaemonSubmitBugReportResultSchema,
  DaemonListAutomationsRequest,
  DaemonListAutomationsResult,
  DaemonRunAutomationRequest,
  DaemonRunAutomationResult,
  DaemonPauseAutomationRequest,
  DaemonPauseAutomationResult,
  DaemonResumeAutomationRequest,
  DaemonResumeAutomationResult,
  DaemonGetAutomationHistoryRequest,
  DaemonGetAutomationHistoryResult,
  DaemonGetAutomationVisualRequest,
  DaemonGetAutomationVisualResult,
  DaemonCreateAutomationRequest,
  DaemonCreateAutomationResult,
  DaemonUpdateAutomationModelRequest,
  DaemonUpdateAutomationModelResult,
  DaemonUpdateAutomationPrivacyRequest,
  DaemonUpdateAutomationPrivacyResult,
  DaemonUpdateAutomationPromptRequest,
  DaemonUpdateAutomationPromptResult,
  DaemonUpdateAutomationScheduleRequest,
  DaemonUpdateAutomationScheduleResult,
  DaemonRenameAutomationRequest,
  DaemonRenameAutomationResult,
  DaemonDeleteAutomationRequest,
  DaemonDeleteAutomationResult,
  DaemonForkAutomationRequest,
  DaemonForkAutomationResult,
  DaemonApplyAutomationConfigRequest,
  DaemonApplyAutomationConfigResult,
  DaemonListCronsRequest,
  DaemonListCronsResult,
  DaemonCreateCronRequest,
  DaemonCreateCronResult,
  DaemonUpdateCronRequest,
  DaemonUpdateCronResult,
  DaemonDeleteCronRequest,
  DaemonDeleteCronResult,
  DaemonHoldSessionCronsRequest,
  DaemonHoldSessionCronsResult,
  DaemonResumeSessionCronsRequest,
  DaemonResumeSessionCronsResult,
  DaemonListSkillsResultSchema,
  DaemonGetGitDiffRequest,
  DaemonGetGitDiffResult,
  DaemonGetGitDiffUnavailableReason,
  DaemonInspectMissionReadinessRequest,
  DaemonInspectMissionReadinessResult,
  DaemonGitPushRequest,
  DaemonGitPushResult,
  DaemonGitCommitRequest,
  DaemonGitCommitResult,
  DaemonCreatePRRequest,
  DaemonCreatePRResult,
  DaemonGetSemanticDiffCacheRequest,
  DaemonGetSemanticDiffCacheResult,
  DaemonGetSemanticDiffCacheResultSchema,
  DaemonSaveSemanticDiffCacheRequest,
  DaemonSaveSemanticDiffCacheResult,
  DaemonGenerateSemanticDiffRequest,
  DaemonGenerateSemanticDiffResult,
  DaemonGetProxyTokenResult,
  DaemonGetWorkspaceFileContentRequest,
  DaemonGetWorkspaceFileContentResult,
  DaemonGetRewindInfoRequest,
  DaemonGetRewindInfoResult,
  DaemonGetRewindInfoResultSchema,
  DaemonExecuteRewindRequest,
  DaemonExecuteRewindResult,
  DaemonExecuteRewindResultSchema,
  DaemonCompactSessionRequest,
  DaemonCompactSessionResult,
  DaemonCompactSessionResultSchema,
  DaemonForkSessionRequest,
  DaemonForkSessionResult,
  DaemonForkSessionResultSchema,
  DaemonGetContextBreakdownRequest,
  DaemonGetContextBreakdownResult,
  DaemonGetContextBreakdownResultSchema,
  DaemonWarmupCacheRequest,
  DaemonSpecificNotificationType,
  LOCAL_MACHINE_ID,
  McpSuccessResultSchema,
} from '@industry/common/daemon';
import {
  SESSION_TAG_BTW_FORK,
  convertMessageEventToIndustryDroolMessage,
  type IndustryMissionArtifactMetadata,
} from '@industry/common/session';
import {
  SessionSettingsSchema,
  type SessionSettings,
} from '@industry/common/session/settings';
import { MarketplaceSource } from '@industry/common/settings';
import { ClientType } from '@industry/common/shared';
import {
  ConnectionError,
  DroolClient,
  DroolClientEvent,
  InvalidSessionCwdError,
  ProcessExitError,
  ProcessTransport,
  SessionNotFoundError,
  TimeoutError,
} from '@industry/drool-sdk';
import {
  AddUserMessageResultSchema,
  AskUserResultSchema,
  CliRequestOrNotificationSchema,
  DroolClientMethod,
  DroolErrorType,
  DroolWorkingState,
  INDUSTRY_PROTOCOL_VERSION,
  InitializeSessionResultSchema,
  InterruptSessionResultSchema,
  KillWorkerSessionResultSchema,
  ACTIVE_ORGANIZATION_HEADER,
  LEGACY_INDUSTRY_API_VERSION,
  JSONRPC_VERSION,
  LoadSessionResultSchema,
  RequestPermissionResultSchema,
  ResolveQueuedUserMessageResultSchema,
  SessionNotificationType,
  ToolConfirmationOutcome,
  SYSTEM_REMINDER_START,
  SYSTEM_REMINDER_END,
  UpdateSessionSettingsResultSchema,
  type AskUserResult,
  type SessionNotificationEvent,
  type RequestPermissionResult,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  SessionOrigin,
  SessionPlatform,
} from '@industry/drool-sdk-ext/protocol/session';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import {
  JsonRpcBaseRequest,
  JsonRpcBaseResponseFailure,
  JsonRpcBaseResponseSuccess,
  JsonRpcErrorCode,
  TraceContextMeta,
} from '@industry/drool-sdk-ext/protocol/shared';
import { EnvironmentVariable, resolveEnv } from '@industry/environment';
import {
  logException,
  logInfo,
  logWarn,
  Metric,
  Metrics,
} from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import {
  ClientUiSurface,
  deriveSessionAttributionFromPlatform,
  OtelTracing,
  SpanAttribute,
  SpanName,
} from '@industry/logging/tracing';
import {
  getActiveOrganizationId,
  getAuthToken,
  type RuntimeAuthConfig,
} from '@industry/runtime/auth';
import { PluginMarketplaceManager } from '@industry/runtime/settings';
import {
  inspectMissionRepo,
  sanitizeGitRemoteUrl,
} from '@industry/utils/agentReadiness';
import {
  buildAutomationSlug,
  decideVisualPolicy,
  isAutomationRunTriggerSource,
  type AutomationRunTriggerSource,
  type VisualPolicyDecision,
} from '@industry/utils/automations';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import { isErrnoException } from '@industry/utils/errors';
import { getFileSuggestionCandidates } from '@industry/utils/file-suggestions';
import { parseFrontmatter } from '@industry/utils/frontmatter';
import {
  cleanupWorktree,
  resolveRepoRoot,
  setupWorktree,
  WorktreeSetupError,
  type WorktreeSessionInfo,
} from '@industry/utils/git';
import {
  readMissionArtifactMetadataForSession,
  type MissionArtifactReadError,
} from '@industry/utils/mission';
import { tryExtractSessionId } from '@industry/utils/protocol';
import {
  getMissionSessionRoleFromTags,
  isMissionSessionOrDescendant,
  sanitizeSessionTitle,
  withAutomationTemplateMetadata,
} from '@industry/utils/session';
import { findSessionFilePath } from '@industry/utils/sessionPaths';

import { BaseRequestHandler } from './base-request-handler';
import { validateCLIValue, validateGitRef } from './command-sanitization';
import { PendingDaemonRequestDispatchResult } from './enums';
import { buildGitDiffData } from './git-diff-data-builder';
import { PendingDaemonRequestStore } from './pending-daemon-request-store';
import { sanitizeReminderInline } from './reminderSanitization';
import { sessionIndexCache } from './session-index-cache';
import {
  AutomationSyncService,
  getPersistedLocalAutomationHistory,
  type AutomationOutcomeTracking,
  type TrackedSessionInfo,
} from '../../automations';
import { readAutomationState } from '../../automations/automation-state';
import { buildAutomationVisualBrandReminder } from '../../automations/buildAutomationVisualBrandReminder';
import { resolveAutomationRunContext } from '../../automations/resolveAutomationRunContext';
import { recordRunFailureToBackend } from '../../automations/sync';
import { CronRegistry, CronRuntime } from '../../crons';
import { DroolRegistry } from '../../drool/drool-registry';
import { ActiveListenerLifecycleEventType } from '../../drool/enums';
import { enforceMissionPolicyForDaemon } from '../../utils/enforce-mission-policy';
import { getWorktreeDefaults } from '../../utils/settings';
import {
  resolveBasePathOrCwd,
  resolveWorkingDirectory,
  validateWorkingDirectory,
} from '../../utils/validate-working-directory';
import { getOrCreateDaemonProxyToken } from '../auth/proxy-token';
import { getDaemonUserAuthEnv } from '../auth/utils';

import type { ChildIpcAttacher } from '../core/types';
import type { DaemonUser, IAuthedDaemonConnection } from '../types';
import type {
  BaseResponse,
  DroolRequestHandlerDeps,
  SessionIndexEntry,
} from './types';
import type { IndustryDroolMessage } from '@industry/drool-sdk-ext/protocol/sessionV2';

const TOOL_CONFIRMATION_OUTCOMES = new Set<string>(
  Object.values(ToolConfirmationOutcome)
);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isToolConfirmationOutcome(
  value: unknown
): value is ToolConfirmationOutcome {
  return typeof value === 'string' && TOOL_CONFIRMATION_OUTCOMES.has(value);
}

async function loadAutomationVisualPolicy(automationPath: string): Promise<{
  decision: VisualPolicyDecision;
  existingVisual: string | null;
}> {
  let existingVisual: string | null = null;
  try {
    existingVisual = await fs.promises.readFile(
      path.join(automationPath, AUTOMATION_VISUAL_FILE),
      'utf-8'
    );
  } catch (cause) {
    if (!isErrnoException(cause) || cause.code !== 'ENOENT') {
      logWarn('[loadAutomationVisualPolicy] readFile failed', { cause });
    }
  }
  const state = readAutomationState(automationPath);
  return {
    decision: decideVisualPolicy({
      existingHtml: existingVisual,
      isFirstRun: state?.runCount === 0,
    }),
    existingVisual,
  };
}

/**
 * Map a human-interaction client surface (`industry.client.surface`) to the
 * corresponding SessionOrigin. Used to derive the session origin for sessions
 * spawned from a client that supplied `tracing.app` in its connection
 * metadata but did not set an explicit `sessionOriginHint`.
 */
const CLIENT_UI_SURFACE_TO_SESSION_ORIGIN: ReadonlyMap<string, SessionOrigin> =
  new Map<string, SessionOrigin>([
    [ClientUiSurface.Web, SessionOrigin.Web],
    [ClientUiSurface.Desktop, SessionOrigin.Desktop],
    [ClientUiSurface.CliTui, SessionOrigin.CliTui],
    [ClientUiSurface.CliExec, SessionOrigin.CliExec],
    [ClientUiSurface.CliAcp, SessionOrigin.CliAcp],
  ]);

const TRUSTED_EXPLICIT_USER_MESSAGE_SOURCE_CALLERS = new Set<string>([
  ClientType.Backend,
]);

/**
 * Grace period before a headless automation run session is torn down after the
 * agent first goes idle. Lets the agent resume work after a transient mid-run
 * idle (e.g. between tool batches) and finish writing VISUAL.html before we
 * close and publish the final visual.
 */
const AUTOMATION_IDLE_TEARDOWN_GRACE_MS = 15_000;

const PREVIEW_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

interface CreateDroolClientForLoadSessionParams {
  sessionId: string;
  mcpServers: DaemonLoadSessionRequest['params']['mcpServers'];
  loadAllMessages?: boolean;
  mcpOAuthCallbackUri?: string;
  sessionOriginHint?: SessionOrigin;
  skipPermissionsUnsafe?: boolean;
  inactivityTimeoutMs?: number;
  disableInactivityTimeout?: boolean;
  runtimeSettingsPath?: string;
  context: IAuthedDaemonConnection;
  _meta?: TraceContextMeta;
  cwd?: string;
}

interface SessionIndexEntryWithMissionMetadata extends SessionIndexEntry {
  mission?: IndustryMissionArtifactMetadata;
}

function shouldIncludeMissionSession(
  isMissionSession: boolean,
  missionSessionsFilter: boolean | undefined
): boolean {
  if (missionSessionsFilter === undefined) {
    return true;
  }
  return missionSessionsFilter ? isMissionSession : !isMissionSession;
}

function getMissionsDir(): string {
  return path.join(getIndustryHome(), getIndustryDirName(), 'missions');
}

function sanitizeDirName(name: string): string {
  const sanitized = path.basename(name);
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new MetaError('Invalid directory name', { name });
  }
  return sanitized;
}

function getErrorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function logMissionArtifactReadError(error: MissionArtifactReadError): void {
  logWarn('[drool-request-handler] Failed to read mission artifact metadata', {
    errorName: getErrorName(error.error),
    eventType: error.operation,
    ...(error.fileName ? { fileName: error.fileName } : {}),
  });
}

/**
 * Validates that an automation path is safely contained within the expected
 * automations directories (user-level or project-level). Prevents path
 * traversal attacks where a crafted automationId could escape the sandbox.
 *
 * Note: Snyk flags downstream filesystem operations as path traversal because
 * it traces taint from request.params through automation discovery to
 * automation.path. This is a false positive: automation.path comes from
 * discoverAllAutomations() which reads from the local filesystem, and the
 * daemon runs locally with authenticated WebSocket connections only.
 */
function validateAutomationPath(
  automationPath: string,
  basePath: string
): void {
  const resolved = path.resolve(automationPath);
  const projectAutomationsDir = path.resolve(
    basePath,
    '.industry',
    'automations'
  );
  const userAutomationsDir = path.resolve(
    getIndustryHome(),
    getIndustryDirName(),
    'automations'
  );

  const isWithinProject = resolved.startsWith(projectAutomationsDir + path.sep);
  const isWithinUser = resolved.startsWith(userAutomationsDir + path.sep);

  if (!isWithinProject && !isWithinUser) {
    throw new MetaError('Automation path is outside the allowed directory', {
      targetPath: resolved,
    });
  }
}

function parseSettingsLevel(scope: string): SettingsLevel {
  const values = Object.values(SettingsLevel);
  const match = values.find((v) => v === scope);
  if (!match) {
    throw new MetaError('Invalid settings level', { value: scope });
  }
  return match;
}

/**
 * Strip credential userinfo (user:password@) from a URL before returning it
 * over the RPC boundary. Falls back to a best-effort scrub when the input is
 * not a parseable URL (e.g. SSH-style `git@host:path`).
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (err) {
    logWarn(
      '[drool-request-handler] redactUrl: not a parseable URL, falling back to regex scrub',
      {
        cause: err,
      }
    );
    return url.replace(/\/\/[^@/]+:[^@/]+@/, '//');
  }
}

/**
 * Produce a redacted representation of a MarketplaceSource suitable for
 * sending over the RPC boundary. Omits filesystem paths for local sources
 * (which can leak user home directories) and strips credential userinfo from
 * URL-bearing sources. Unknown/malformed sources collapse to `{ source: 'local' }`.
 */
function redactMarketplaceSource(
  source: MarketplaceSource
): DaemonListMarketplacesResult['marketplaces'][number]['source'] {
  switch (source.source) {
    case 'github':
      return { source: 'github', repo: source.repo };
    case 'url':
      return { source: 'url', url: redactUrl(source.url) };
    case 'local':
      return { source: 'local' };
    case 'git-subdir':
      return {
        source: 'git-subdir',
        url: redactUrl(source.url),
        path: source.path,
      };
    default:
      return { source: 'local' };
  }
}

function escapeHtmlForAutomationVisual(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildAutomationVisualScaffold(automationName: string): string {
  const escapedName = escapeHtmlForAutomationVisual(automationName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedName} - Visual Output</title>
  <script>
    (function () {
      function applyTheme(t) {
        if (t === 'light' || t === 'dark') {
          document.documentElement.setAttribute('data-theme', t);
        }
      }
      try {
        var m = (location.hash || '').match(/theme=(light|dark)/);
        if (m) applyTheme(m[1]);
      } catch (e) {}
      window.addEventListener('message', function (event) {
        var data = event && event.data;
        if (data && data.type === 'industry:set-theme') applyTheme(data.theme);
      });
    })();
  </script>
  <style>
    :root {
      color-scheme: dark;
      --page-bg: #000000;
      --surface-1: #161413;
      --surface: #161413;
      --surface-3: #161413;
      --surface-4: #342f2d;
      --surface-5: #4d4d4d;
      --border-1: #342f2d;
      --border: #342f2d;
      --border-2: #4d4d4d;
      --text-default: #ffffff;
      --text: #ffffff;
      --text-muted: #9b8e87;
      --text-footer: #948781;
      --mica-accent: #EE6018;
      --accent: #EE6018;
      --jade-1: rgba(111, 171, 120, 0.15);
      --jade-text: #6FAB78;
      --ruby-1: rgba(217, 54, 62, 0.15);
      --ruby-text: #D9363E;
      --topaz-1: rgba(240, 163, 48, 0.15);
      --topaz-text: #F0A330;
      --font-sans: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-mono: 'Geist Mono', 'Berkeley Mono', 'SF Mono', Monaco, Consolas, monospace;
    }
    @media (prefers-color-scheme: light) {
      :root:not([data-theme="dark"]) {
        color-scheme: light;
        --page-bg: #F2F0F0;
        --surface-1: #FFFFFF;
        --surface: #FFFFFF;
        --surface-3: #E4E2E1;
        --surface-4: #CBC5C2;
        --surface-5: #B8B3B0;
        --border-1: #CBC5C2;
        --border: #CBC5C2;
        --border-2: #B8B3B0;
        --text-default: #161413;
        --text: #161413;
        --text-muted: #666666;
        --text-footer: #555555;
        --mica-accent: #EE6018;
        --jade-1: rgba(63, 107, 71, 0.12);
        --jade-text: #3F6B47;
        --ruby-1: rgba(176, 38, 44, 0.12);
        --ruby-text: #B0262C;
        --topaz-1: rgba(140, 90, 20, 0.12);
        --topaz-text: #8C5A14;
      }
    }
    :root[data-theme="light"] {
      color-scheme: light;
      --page-bg: #F2F0F0;
      --surface-1: #FFFFFF;
      --surface: #FFFFFF;
      --surface-3: #E4E2E1;
      --surface-4: #CBC5C2;
      --surface-5: #B8B3B0;
      --border-1: #CBC5C2;
      --border: #CBC5C2;
      --border-2: #B8B3B0;
      --text-default: #161413;
      --text: #161413;
      --text-muted: #666666;
      --text-footer: #555555;
      --mica-accent: #EE6018;
      --jade-1: rgba(63, 107, 71, 0.12);
      --jade-text: #3F6B47;
      --ruby-1: rgba(176, 38, 44, 0.12);
      --ruby-text: #B0262C;
      --topaz-1: rgba(140, 90, 20, 0.12);
      --topaz-text: #8C5A14;
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --page-bg: #000000;
      --surface-1: #161413;
      --surface: #161413;
      --surface-3: #161413;
      --surface-4: #342f2d;
      --surface-5: #4d4d4d;
      --border-1: #342f2d;
      --border: #342f2d;
      --border-2: #4d4d4d;
      --text-default: #ffffff;
      --text: #ffffff;
      --text-muted: #9b8e87;
      --text-footer: #948781;
      --mica-accent: #EE6018;
      --jade-1: rgba(111, 171, 120, 0.15);
      --jade-text: #6FAB78;
      --ruby-1: rgba(217, 54, 62, 0.15);
      --ruby-text: #D9363E;
      --topaz-1: rgba(240, 163, 48, 0.15);
      --topaz-text: #F0A330;
    }
    * {
      box-sizing: border-box;
    }
    body {
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 20px;
      font-weight: 300;
      letter-spacing: -0.01em;
      line-height: 1.5;
      margin: 0;
      min-height: 100vh;
      padding: 24px;
    }
    main {
      margin: 0 auto;
      max-width: 960px;
      padding-top: 32px;
      width: 100%;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 4px;
      max-width: 520px;
      padding: 16px;
    }
    .eyebrow {
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 14px;
      font-weight: 400;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
      text-transform: uppercase;
    }
    h1 {
      font-size: 28px;
      font-weight: 300;
      letter-spacing: -0.01em;
      margin: 0 0 8px;
    }
    p {
      color: var(--text-muted);
      font-size: 14px;
      margin: 0;
    }
  </style>
</head>
<body data-industry-visual-scaffold="true">
  <main>
    <section class="card">
      <div class="eyebrow">Visual scaffold ready</div>
      <h1>${escapedName}</h1>
      <p>This starter visual exists so the automation always has a dashboard file. The automation can replace it with the task-specific layout that best fits each run.</p>
    </section>
  </main>
</body>
</html>`;
}

function resolveCreateAutomationPath(
  slug: string,
  automationId?: string
): string {
  // Resolve from the machine's real industry home (INDUSTRY_HOME_OVERRIDE ||
  // homedir), never the request cwd. The frontend sends the machine home as the
  // session cwd, but it can arrive empty (resolving to `/`) when machine info is
  // not yet available, which would place the automation under the filesystem
  // root (`/.industry/automations/...`) and fail with EROFS on a read-only root.
  // The daemon runs on the machine that hosts the automation, so its industry
  // home is the authoritative base and matches where automation discovery looks
  // for user-level automations.
  const automationsPath = path.resolve(
    getIndustryHome(),
    getIndustryDirName(),
    'automations'
  );
  const automationPath = path.resolve(
    automationsPath,
    buildAutomationSlug(slug, automationId)
  );
  if (!automationPath.startsWith(`${automationsPath}${path.sep}`)) {
    throw new MetaError(
      'Security violation: Attempted automation scaffold outside automations directory'
    );
  }
  return automationPath;
}

/**
 * Resolve the per-automation directory for a *create* (setup) session, or
 * `undefined` when the session is not an identified automation-create session.
 * Shared by the pre-spawn cwd redirect and the post-spawn visual scaffold so
 * both agree on a single path.
 */
function resolveCreateAutomationCwd(
  tags: DaemonInitializeSessionRequest['params']['tags']
): string | undefined {
  const createTag = tags?.find(
    (tag) =>
      tag.name === 'automation' &&
      String(tag.metadata?.type ?? '') === 'create' &&
      tag.metadata?.automationId !== undefined
  );
  if (!createTag) {
    return undefined;
  }
  return resolveCreateAutomationPath(
    createTag.metadata?.automationSlug
      ? String(createTag.metadata.automationSlug)
      : createTag.metadata?.automationName
        ? String(createTag.metadata.automationName)
        : 'Automation',
    String(createTag.metadata?.automationId)
  );
}

function isAutomationRunSession(
  tags: DaemonInitializeSessionRequest['params']['tags']
): boolean {
  return (
    tags?.some(
      (tag) =>
        tag.name === 'automation' && String(tag.metadata?.type ?? '') === 'run'
    ) ?? false
  );
}

function isUserAutomationCwd(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  const userAutomationsDir = path.resolve(
    getIndustryHome(),
    getIndustryDirName(),
    'automations'
  );
  return resolved.startsWith(`${userAutomationsDir}${path.sep}`);
}

async function ensureAutomationVisualFile(
  automationPath: string,
  automationName: string
): Promise<void> {
  const resolvedAutomationPath = path.resolve(automationPath);
  const visualPath = path.resolve(
    resolvedAutomationPath,
    AUTOMATION_VISUAL_FILE
  );
  if (!visualPath.startsWith(`${resolvedAutomationPath}${path.sep}`)) {
    throw new MetaError(
      'Security violation: Attempted visual write outside automation directory'
    );
  }

  try {
    await fs.promises.mkdir(resolvedAutomationPath, { recursive: true });
    await fs.promises.writeFile(
      visualPath,
      buildAutomationVisualScaffold(automationName),
      {
        encoding: 'utf-8',
        flag: 'wx',
      }
    );
    logInfo('[Automation] Created missing VISUAL.html scaffold', {
      value: automationPath,
    });
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
    if (code === 'EEXIST') {
      return;
    }
    logWarn('[Automation] Failed to create VISUAL.html scaffold', {
      cause: error,
    });
  }
}

export class DroolRequestHandler extends BaseRequestHandler {
  private droolRegistry: DroolRegistry;

  private droolExecPath?: string;

  private readonly pendingDaemonRequests: PendingDaemonRequestStore;

  /** Owning machine id for this daemon (LOCAL_MACHINE_ID or the computer id). */
  private readonly machineId: string;

  /**
   * Maps session ID to a pending load session operation.
   * Used to serialize load session requests and prevent race conditions.
   */
  private pendingLoadOperations: Map<string, Promise<DaemonLoadSessionResult>> =
    new Map();

  private isDevelopment: boolean;

  private apiBaseUrl: string;

  private deploymentEnv: string;

  private runtimeAuthConfig: RuntimeAuthConfig;

  private automationSyncService: AutomationSyncService;

  private cronRegistry: CronRegistry;

  private cronRuntime: CronRuntime;

  private supportsRootPromptCrons: boolean;

  private readonly unsubscribeActiveListenerLifecycle: () => void;

  private readonly attachChildIpc?: ChildIpcAttacher;

  constructor(deps: DroolRequestHandlerDeps) {
    super();
    this.droolRegistry = deps.registry;
    this.machineId = deps.env.machineId;
    this.droolExecPath = deps.env.droolExecPath;
    this.isDevelopment = deps.env.isDevelopment;
    this.apiBaseUrl = deps.env.apiBaseUrl;
    this.deploymentEnv = deps.env.deploymentEnv;
    this.runtimeAuthConfig = deps.env.runtimeAuthConfig;
    this.automationSyncService = deps.automationSyncService;
    this.cronRegistry = deps.cronRegistry;
    this.cronRuntime = deps.cronRuntime;
    this.supportsRootPromptCrons = deps.supportsRootPromptCrons ?? false;
    this.attachChildIpc = deps.attachChildIpc;
    this.pendingDaemonRequests = deps.pendingRequests;

    this.unsubscribeActiveListenerLifecycle =
      this.droolRegistry.subscribeToActiveListenerLifecycle((event) => {
        if (event.type === ActiveListenerLifecycleEventType.SessionClosed) {
          this.cronRegistry.holdSessionCrons(event.sessionId, 'session-closed');
          this.cronRuntime.sync();
          return;
        }
        if (event.type !== ActiveListenerLifecycleEventType.Connected) {
          return;
        }

        this.dispatchPendingRequestsForListener(
          event.sessionId,
          event.listener
        );
      });
  }

  shutdown(): void {
    this.unsubscribeActiveListenerLifecycle();
    this.cronRuntime.stop();
    this.automationSyncService.dispose();
  }

  private static combineCleanups(
    ...cleanups: Array<(() => void) | undefined>
  ): () => void {
    return () => {
      for (const cleanup of cleanups) {
        cleanup?.();
      }
    };
  }

  private buildSpawnEnv(
    user: DaemonUser,
    extra?: Record<string, string>,
    caller?: string
  ): Record<string, string> {
    // Forward packaged-dependency override env vars so spawned drool processes
    // also resolve rg / agent-browser / keytar from the admin-provided paths.
    const depOverrides: Record<string, string> = {};
    for (const key of [
      EnvironmentVariable.INDUSTRY_NPM_MODULES_DIR,
      EnvironmentVariable.INDUSTRY_RIPGREP_PATH,
      EnvironmentVariable.INDUSTRY_AGENT_BROWSER_PATH,
      EnvironmentVariable.INDUSTRY_KEYTAR_PATH,
    ] as const) {
      const val = resolveEnv({ name: key });
      if (val) depOverrides[key] = val;
    }

    return {
      [EnvironmentVariable.INDUSTRY_API_BASE_URL]: this.apiBaseUrl,
      [EnvironmentVariable.INDUSTRY_DEPLOYMENT_ENV]: this.deploymentEnv,
      [EnvironmentVariable.INDUSTRY_DROOL_AUTO_UPDATE_ENABLED]: 'false',
      [EnvironmentVariable.INDUSTRY_OTEL_ENABLED]: 'true',
      ...(caller
        ? { [EnvironmentVariable.INDUSTRY_UPSTREAM_CLIENT_TYPE]: caller }
        : {}),
      ...(() => {
        const cdpPort = resolveEnv({
          name: EnvironmentVariable.INDUSTRY_DESKTOP_CDP_PORT,
        });
        const agentBrowserCdp = resolveEnv({
          name: EnvironmentVariable.AGENT_BROWSER_CDP,
        });
        const agentBrowserSession = resolveEnv({
          name: EnvironmentVariable.AGENT_BROWSER_SESSION,
        });
        return cdpPort
          ? {
              [EnvironmentVariable.INDUSTRY_DESKTOP_CDP_PORT]: cdpPort,
              ...(agentBrowserCdp
                ? { [EnvironmentVariable.AGENT_BROWSER_CDP]: agentBrowserCdp }
                : {}),
              ...(agentBrowserSession
                ? {
                    [EnvironmentVariable.AGENT_BROWSER_SESSION]:
                      agentBrowserSession,
                  }
                : {}),
            }
          : {};
      })(),
      ...depOverrides,
      ...getDaemonUserAuthEnv(user),
      ...extra,
    };
  }

  private async connectProcessTransport({
    transport,
    context,
    sourceSessionId,
    connect,
  }: {
    transport: ProcessTransport;
    context: IAuthedDaemonConnection;
    sourceSessionId?: string;
    connect?: () => Promise<void>;
  }): Promise<void> {
    await (connect?.() ?? transport.connect());

    if (!this.attachChildIpc) {
      return;
    }

    const childProcess = transport.getManagedProcess()?.childProcess;
    if (!childProcess) {
      return;
    }

    this.attachChildIpc({
      childProcess,
      context,
      sourceSessionId,
    });
  }

  private getSessionOriginHintForSpawn(
    context: IAuthedDaemonConnection,
    params: DaemonInitializeSessionRequest['params']
  ): SessionOrigin | undefined {
    if (params.sessionOriginHint) {
      return params.sessionOriginHint;
    }

    if (params.sessionSource?.platform) {
      return deriveSessionAttributionFromPlatform(params.sessionSource.platform)
        .sessionOrigin;
    }

    const app = context.tracingMetadata?.app;
    if (app !== undefined) {
      const origin = CLIENT_UI_SURFACE_TO_SESSION_ORIGIN.get(app);
      if (origin !== undefined) {
        return origin;
      }
    }

    return undefined;
  }

  /**
   * Derive the client surface from a connection's tracing metadata
   * (web/desktop/cli_*). Returns undefined for non-UI surfaces.
   */
  private deriveSessionOriginFromContextSurface(
    context: IAuthedDaemonConnection
  ): SessionOrigin | undefined {
    const app = context.tracingMetadata?.app;
    if (app !== undefined) {
      const origin = CLIENT_UI_SURFACE_TO_SESSION_ORIGIN.get(app);
      if (origin !== undefined) {
        return origin;
      }
    }

    return undefined;
  }

  /**
   * Resolve the client surface for a load request. Load params do not carry a
   * `sessionSource`, so this prefers an explicit hint and otherwise derives the
   * origin from the connection's tracing surface (web/desktop/cli_*).
   */
  private getSessionOriginHintForLoad(
    context: IAuthedDaemonConnection,
    params: DaemonLoadSessionRequest['params']
  ): SessionOrigin | undefined {
    if (params.sessionOriginHint) {
      return params.sessionOriginHint;
    }

    return this.deriveSessionOriginFromContextSurface(context);
  }

  private getUserMessageSourceForAddUserMessage(
    context: IAuthedDaemonConnection,
    explicitUserMessageSource?: SessionOrigin
  ): SessionOrigin | undefined {
    if ('apiKey' in context.user && context.user.apiKey) {
      return explicitUserMessageSource;
    }

    if (
      explicitUserMessageSource === SessionOrigin.Web ||
      explicitUserMessageSource === SessionOrigin.Desktop
    ) {
      return explicitUserMessageSource;
    }

    if (
      explicitUserMessageSource !== SessionOrigin.Slack &&
      TRUSTED_EXPLICIT_USER_MESSAGE_SOURCE_CALLERS.has(context.caller)
    ) {
      return explicitUserMessageSource;
    }

    return undefined;
  }

  private async setupAutomationOutcomeTracking(params: {
    client: DroolClient;
    sessionId: string;
    info: TrackedSessionInfo;
  }): Promise<void> {
    const { client, sessionId, info } = params;
    const { automationId, automationPath, outcome } = info;

    const resolvedOutcome: AutomationOutcomeTracking =
      outcome.kind === 'none' || outcome.visualBaseline !== undefined
        ? outcome
        : {
            ...outcome,
            visualBaseline:
              await AutomationSyncService.captureVisualBaseline(automationPath),
          };

    this.automationSyncService.registerAutomationRun(sessionId, {
      ...info,
      outcome: resolvedOutcome,
    });

    const keepAlive = info.keepAliveForVisualEdits === true;
    let hasSeenNonIdle = false;
    let teardownTimer: ReturnType<typeof setTimeout> | undefined;

    const cancelPendingTeardown = () => {
      if (teardownTimer) {
        clearTimeout(teardownTimer);
        teardownTimer = undefined;
      }
    };

    // Publish whatever VISUAL.* is on disk now. Change-gated downstream, so
    // re-publishing on every idle is cheap and keeps the dashboard in sync
    // with later-turn edits.
    const publishCurrentVisual = () => {
      this.automationSyncService.snapshotAutomationVisual(sessionId);
      this.automationSyncService.syncTrackedAutomation(sessionId);
      if (resolvedOutcome.kind === 'create') {
        this.automationSyncService.evaluateCreateOutcome(sessionId);
      }
    };

    const idleWatcher = (event: {
      params: { notification: { type: string; newState?: string } };
    }) => {
      const { notification } = event.params;
      if (
        notification.type !==
        SessionNotificationType.DROOL_WORKING_STATE_CHANGED
      ) {
        return;
      }
      if (notification.newState !== DroolWorkingState.Idle) {
        hasSeenNonIdle = true;
        // The agent resumed work (e.g. another tool batch or a follow-up
        // turn); don't tear the session down on the earlier transient idle.
        cancelPendingTeardown();
        return;
      }
      if (!hasSeenNonIdle) {
        return;
      }

      logInfo('[Automation] Agent idle, publishing automation visual', {
        automationId,
        sessionId,
      });
      publishCurrentVisual();

      if (keepAlive) {
        // User-attended session: stay open and re-arm for the next turn so
        // later visual edits are published too.
        hasSeenNonIdle = false;
        return;
      }

      // Headless run: defer teardown so a transient mid-run idle (the agent
      // pausing before it finishes writing VISUAL.html) doesn't close the
      // session before the final visual is on disk. Resumed work cancels it.
      cancelPendingTeardown();
      teardownTimer = setTimeout(() => {
        client.off(DroolClientEvent.SESSION_NOTIFICATION, idleWatcher);
        publishCurrentVisual();
        logInfo('[Automation] Agent idle, closing automation session', {
          automationId,
          sessionId,
        });
        void this.droolRegistry.unregisterDroolClient(sessionId);
      }, AUTOMATION_IDLE_TEARDOWN_GRACE_MS);
      if (typeof teardownTimer.unref === 'function') {
        teardownTimer.unref();
      }
    };
    client.on(DroolClientEvent.SESSION_NOTIFICATION, idleWatcher);
  }

  /**
   * Dispatch a scheduled automation run headlessly.
   * Spawns a drool process, initializes a session, and sends the automation prompt.
   * The session shows up in the sidebar and runs to completion without user interaction.
   */
  async dispatchAutomationRun(
    automationId: string,
    context: IAuthedDaemonConnection,
    basePath: string
  ): Promise<{ sessionId: string }> {
    const { discoverAllAutomations } = await import(
      '@industry/drool-core/automations'
    );
    const discovery = await discoverAllAutomations(basePath);
    const automation = discovery.automations.find((a) => a.id === automationId);

    if (!automation || !automation.isValid) {
      throw new MetaError('Automation not found or invalid', { automationId });
    }
    validateAutomationPath(automation.path, basePath);

    const heartbeatPath = path.join(automation.path, AUTOMATION_HEARTBEAT_FILE);
    const content = await fs.promises.readFile(heartbeatPath, 'utf-8');

    const { body } = parseFrontmatter(content);
    const prompt = body.trim();

    if (!prompt) {
      throw new MetaError('Automation HEARTBEAT.md has no prompt content', {
        automationId,
      });
    }

    const sessionId = crypto.randomUUID();
    // The automation's scaffold (HEARTBEAT.md, VISUAL.html, memory/, reports/)
    // always lives at `automation.path`. The run session cwd defaults to that
    // same directory, but when the automation configures an explicit
    // `workingDirectory` we run from there instead, keeping scaffold
    // bookkeeping anchored to `automation.path`.
    const [{ cwd, scaffoldReminder }] = await Promise.all([
      resolveAutomationRunContext(automation),
      ensureAutomationVisualFile(automation.path, automation.config.name),
    ]);

    // Scheduled automation runs are headless: there is no user to approve
    // permission prompts, so the daemon's permission requests would just
    // time out / be cancelled, leaving the agent unable to call Execute,
    // Edit, Create, etc. (the very tools an automation needs to update
    // VISUAL.html and memory). Run with --skip-permissions-unsafe so the
    // CLI auto-approves every tool. Cannot be combined with --auto.
    const transport = new ProcessTransport({
      cwd,
      droolExecPath: this.droolExecPath,
      isDevelopment: this.isDevelopment,
      droolExecExtraArgs: ['--skip-permissions-unsafe'],
      env: this.buildSpawnEnv(context.user, undefined, context.caller),
      enableIpc: this.attachChildIpc !== undefined,
    });
    const client = new DroolClient({ transport });
    let cleanup: (() => void) | undefined;

    try {
      await this.connectProcessTransport({
        transport,
        context,
        sourceSessionId: sessionId,
      });

      const response = await client.initializeSession({
        machineId: LOCAL_MACHINE_ID,
        sessionId,
        cwd,
        ...(automation.config.model
          ? { modelId: automation.config.model }
          : {}),
        sessionSource: {
          platform: SessionPlatform.Automation,
          automationId: automation.config.id ?? automation.id,
          computerId: '',
        },
        tags: withAutomationTemplateMetadata(
          [
            {
              name: 'automation',
              metadata: {
                automationId,
                ...(automation.config.id
                  ? { automationUuid: automation.config.id }
                  : {}),
                automationName: automation.config.name,
                triggerSource: 'scheduled',
                type: 'run',
              },
            },
          ],
          automation.config.templateId
        ),
      });

      if (response.error) {
        throw new MetaError('Failed to initialize automation session', {
          code: response.error.code,
          message: response.error.message,
        });
      }

      const result = InitializeSessionResultSchema.parse(response.result);
      const actualSessionId = result.sessionId;

      cleanup = DroolRequestHandler.combineCleanups(
        this.setupEventForwarding(client, actualSessionId)
      );
      await this.droolRegistry.registerClient({
        sessionId: actualSessionId,
        droolClient: client,
        connection: context,
        cleanupFn: cleanup,
        cwd,
        skipPermissionsUnsafe: true,
      });

      this.droolRegistry.setMessagesCount(
        actualSessionId,
        result.session.messages.length
      );

      const { decision, existingVisual } = await loadAutomationVisualPolicy(
        automation.path
      );
      logInfo('[Automation] Visual policy decision', {
        automationId,
        // eslint-disable-next-line industry/no-nested-log-metadata -- policy decision branch + reason + issue ids consumed as a unit
        value: {
          branch: decision.branch,
          reason: decision.reason,
          issues: decision.issues.map((i) => i.id),
        },
      });

      const automationSystemReminder = [
        SYSTEM_REMINDER_START,
        `You are running a scheduled automation called **"${sanitizeReminderInline(automation.config.name)}"**. This is a non-interactive execution.`,
        'Do NOT use the AskUser tool. The user is not present and cannot respond.',
        'Make all decisions autonomously based on the prompt instructions below.',
        'CRITICAL: Execute every step in the prompt below to completion in a single assistant turn. Do NOT stop, pause, summarize, or wait for confirmation between steps. Keep calling tools until every step is done (read state, run the work, update memory files, write the report, regenerate VISUAL.html from scratch, and increment runCount). Only end your turn after the final write — incrementing `state.json.runCount` — is on disk.',
        'For the displayed total run count: read `./memory/state.json.runCount` and display `runCount + 1` in the visual (this run has not yet been counted at the time you write VISUAL.html). After updating VISUAL.html, write the incremented value back to `./memory/state.json` (preserve the existing `id` field — read-modify-write).',
        SYSTEM_REMINDER_END,
      ].join('\n');

      const visualReminder = buildAutomationVisualBrandReminder({
        decision,
        automationName: automation.config.name,
        existingVisual,
        forceRegenerate: true,
      });

      // Capture baseline + attach watcher BEFORE addUserMessage so a
      // fast Thinking->Idle can't fire before we listen and the agent
      // can't mutate VISUAL.* between baseline and snapshot.
      const visualBaseline = await AutomationSyncService.captureVisualBaseline(
        automation.path
      );

      await this.setupAutomationOutcomeTracking({
        client,
        sessionId: actualSessionId,
        info: {
          automationId,
          automationPath: automation.path,
          automationUuid: automation.config.id,
          outcome: {
            kind: 'run',
            executionLocation: 'local',
            triggerSource: 'scheduled',
            visualBaseline,
          },
        },
      });

      await client.addUserMessage({
        text: `${scaffoldReminder}${automationSystemReminder}\n${visualReminder}\n${prompt}`,
      });

      try {
        this.applyManualSessionTitle(
          actualSessionId,
          `[Automation] ${automation.config.name}`
        );
      } catch (titleError) {
        logWarn('[Automation] Failed to set scheduled-run session title', {
          sessionId: actualSessionId,
          cause: titleError,
        });
      }

      logInfo('[Automation] Scheduled run dispatched', {
        automationId,
        sessionId: actualSessionId,
        value: automation.config.name,
      });

      return { sessionId: actualSessionId };
    } catch (error) {
      if (cleanup) {
        cleanup();
      }
      await client.close().catch((closeError) => {
        logException(
          closeError,
          'Failed to close client after automation dispatch error'
        );
      });
      throw error;
    }
  }

  /**
   * Persist a local pre-session dispatch failure as a run record via the
   * backend (the daemon has no direct Firestore access). Resolves the
   * automation's stable UUID from local discovery so the record joins the same
   * way session-backed runs do. Best-effort: never throws — the metric is the
   * source of truth and persistence must not break the poller.
   */
  async recordAutomationDispatchFailure(
    automationId: string,
    reason: 'dispatch_skipped' | 'dispatch_failed' | 'dispatch_exception',
    basePath: string
  ): Promise<void> {
    try {
      const { discoverAllAutomations } = await import(
        '@industry/drool-core/automations'
      );
      const discovery = await discoverAllAutomations(basePath);
      const automation = discovery.automations.find(
        (a) => a.id === automationId
      );
      const automationUuid = automation?.config?.id;
      if (!automationUuid) {
        logWarn(
          '[Automation] Cannot record dispatch failure: unknown automation',
          { automationId, reason }
        );
        return;
      }
      await recordRunFailureToBackend(
        automationUuid,
        { failureReason: reason, triggerSource: 'scheduled' },
        this.apiBaseUrl,
        this.runtimeAuthConfig
      );
    } catch (error) {
      logWarn('[Automation] Failed to record dispatch failure', {
        automationId,
        reason,
        cause: error,
      });
    }
  }

  protected async dispatch(
    context: IAuthedDaemonConnection,
    request: JsonRpcBaseRequest
  ): Promise<BaseResponse> {
    const requestId = String(request.id);
    const parseResult = DaemonRequestSchema.safeParse(request);
    if (!parseResult.success) {
      return {
        type: 'response',
        id: requestId,
        error: {
          code: JsonRpcErrorCode.INVALID_PARAMS,
          message: 'Invalid request params',
          data: parseResult.error,
        },
      };
    }
    const daemonRequest = parseResult.data;
    try {
      switch (daemonRequest.method) {
        case DaemonDroolMethod.INITIALIZE_SESSION:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleInitializeSession(context, daemonRequest),
          };
        case DaemonDroolMethod.LOAD_SESSION:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleLoadSession(context, daemonRequest),
          };
        case DaemonDroolMethod.ADD_USER_MESSAGE:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleAddUserMessage(context, daemonRequest),
          };
        case DaemonDroolMethod.RESOLVE_QUEUED_USER_MESSAGE:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleResolveQueuedUserMessage(daemonRequest),
          };
        case DaemonDroolMethod.INTERRUPT_SESSION:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleInterruptSession(daemonRequest),
          };
        case DaemonDroolMethod.CLOSE_SESSION:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleCloseSession(daemonRequest),
          };
        case DaemonDroolMethod.KILL_WORKER_SESSION:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleKillWorkerSession(daemonRequest),
          };
        case DaemonDroolMethod.LIST_OPENED_SESSIONS:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleListOpenedSessions(daemonRequest),
          };
        case DaemonDroolMethod.LIST_AVAILABLE_SESSIONS:
          return {
            type: 'response',
            id: requestId,
            result:
              await DroolRequestHandler.handleListAvailableSessions(
                daemonRequest
              ),
          };
        case DaemonDroolMethod.GET_SESSION_MESSAGES:
          return {
            type: 'response',
            id: requestId,
            result:
              await DroolRequestHandler.handleGetSessionMessages(daemonRequest),
          };
        case DaemonDroolMethod.UPDATE_SESSION_SETTINGS:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleUpdateSessionSettings(
              context,
              daemonRequest
            ),
          };
        case DaemonDroolMethod.VALIDATE_WORKING_DIRECTORY:
          return {
            type: 'response',
            id: requestId,
            result: await validateWorkingDirectory(
              daemonRequest.params.workingDirectory
            ),
          };
        case DaemonDroolMethod.INSPECT_MISSION_READINESS:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleInspectMissionReadiness(daemonRequest),
          };
        case DaemonDroolMethod.GET_MCP_CONFIG:
        case DaemonDroolMethod.UPDATE_MCP_CONFIG:
          throw new MetaError(
            'MCP config management not implemented in daemon'
          );
        case DaemonDroolMethod.TOGGLE_MCP_SERVER:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleToggleMcpServer(daemonRequest),
          };
        case DaemonDroolMethod.AUTHENTICATE_MCP_SERVER:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleAuthenticateMcpServer(daemonRequest),
          };
        case DaemonDroolMethod.CANCEL_MCP_AUTH:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleCancelMcpAuth(daemonRequest),
          };
        case DaemonDroolMethod.CLEAR_MCP_AUTH:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleClearMcpAuth(daemonRequest),
          };
        case DaemonDroolMethod.LIST_FILES:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleListFiles(daemonRequest),
          };
        case DaemonDroolMethod.SEARCH_FILES:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleSearchFiles(daemonRequest),
          };
        case DaemonDroolMethod.ADD_MCP_SERVER:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleAddMcpServer(daemonRequest),
          };
        case DaemonDroolMethod.REMOVE_MCP_SERVER:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleRemoveMcpServer(daemonRequest),
          };
        case DaemonDroolMethod.LIST_MCP_REGISTRY:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleListMcpRegistry(daemonRequest),
          };
        case DaemonDroolMethod.LIST_MCP_TOOLS:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleListMcpTools(daemonRequest),
          };
        case DaemonDroolMethod.LIST_MCP_SERVERS:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleListMcpServers(daemonRequest),
          };
        case DaemonDroolMethod.TOGGLE_MCP_TOOL:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleToggleMcpTool(daemonRequest),
          };
        case DaemonDroolMethod.SUBMIT_MCP_AUTH_CODE:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleSubmitMcpAuthCode(daemonRequest),
          };
        case DaemonDroolMethod.SUBMIT_MCP_AUTH_ERROR:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleSubmitMcpAuthError(daemonRequest),
          };
        case DaemonDroolMethod.SEARCH_SESSIONS:
          return {
            type: 'response',
            id: requestId,
            result:
              await DroolRequestHandler.handleSearchSessions(daemonRequest),
          };
        case DaemonDroolMethod.ARCHIVE_SESSION:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleArchiveSession(daemonRequest),
          };
        case DaemonDroolMethod.UNARCHIVE_SESSION:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleUnarchiveSession(daemonRequest),
          };
        case DaemonDroolMethod.RENAME_SESSION:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleRenameSession(daemonRequest),
          };
        case DaemonDroolMethod.LIST_SKILLS:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleListSkills(daemonRequest),
          };
        case DaemonDroolMethod.LIST_COMMANDS:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleListCommands(daemonRequest),
          };
        case DaemonDroolMethod.LIST_AVAILABLE_PLUGINS:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleListAvailablePlugins(daemonRequest),
          };
        case DaemonDroolMethod.LIST_INSTALLED_PLUGINS:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleListInstalledPlugins(daemonRequest),
          };
        case DaemonDroolMethod.INSTALL_PLUGIN:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleInstallPlugin(daemonRequest),
          };
        case DaemonDroolMethod.UNINSTALL_PLUGIN:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleUninstallPlugin(daemonRequest),
          };
        case DaemonDroolMethod.SET_PLUGIN_ENABLED:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleSetPluginEnabled(daemonRequest),
          };
        case DaemonDroolMethod.UPDATE_PLUGIN:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleUpdatePlugin(daemonRequest),
          };
        case DaemonDroolMethod.LIST_MARKETPLACES:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleListMarketplaces(daemonRequest),
          };
        case DaemonDroolMethod.ADD_MARKETPLACE:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleAddMarketplace(daemonRequest),
          };
        case DaemonDroolMethod.REMOVE_MARKETPLACE:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleRemoveMarketplace(daemonRequest),
          };
        case DaemonDroolMethod.UPDATE_MARKETPLACE:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleUpdateMarketplace(daemonRequest),
          };
        case DaemonDroolMethod.SUBMIT_BUG_REPORT:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleSubmitBugReport(daemonRequest),
          };
        case DaemonDroolMethod.LIST_AUTOMATIONS:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleListAutomations(daemonRequest),
          };
        case DaemonDroolMethod.RUN_AUTOMATION:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleRunAutomation(daemonRequest),
          };
        case DaemonDroolMethod.PAUSE_AUTOMATION:
          return {
            type: 'response',
            id: requestId,
            result: await this.handlePauseAutomation(daemonRequest),
          };
        case DaemonDroolMethod.RESUME_AUTOMATION:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleResumeAutomation(daemonRequest),
          };
        case DaemonDroolMethod.GET_AUTOMATION_HISTORY:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleGetAutomationHistory(daemonRequest),
          };
        case DaemonDroolMethod.GET_AUTOMATION_VISUAL:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleGetAutomationVisual(daemonRequest),
          };
        case DaemonDroolMethod.CREATE_AUTOMATION:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleCreateAutomation(daemonRequest),
          };
        case DaemonDroolMethod.UPDATE_AUTOMATION_MODEL:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleUpdateAutomationModel(daemonRequest),
          };
        case DaemonDroolMethod.UPDATE_AUTOMATION_PRIVACY:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleUpdateAutomationPrivacy(daemonRequest),
          };
        case DaemonDroolMethod.UPDATE_AUTOMATION_PROMPT:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleUpdateAutomationPrompt(daemonRequest),
          };
        case DaemonDroolMethod.UPDATE_AUTOMATION_SCHEDULE:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleUpdateAutomationSchedule(daemonRequest),
          };
        case DaemonDroolMethod.RENAME_AUTOMATION:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleRenameAutomation(daemonRequest),
          };
        case DaemonDroolMethod.DELETE_AUTOMATION:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleDeleteAutomation(daemonRequest),
          };
        case DaemonDroolMethod.FORK_AUTOMATION:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleForkAutomation(daemonRequest),
          };
        case DaemonDroolMethod.APPLY_AUTOMATION_CONFIG:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleApplyAutomationConfig(daemonRequest),
          };
        case DaemonDroolMethod.LIST_CRONS:
          return {
            type: 'response',
            id: requestId,
            result: this.handleListCrons(daemonRequest),
          };
        case DaemonDroolMethod.CREATE_CRON:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleCreateCron(daemonRequest),
          };
        case DaemonDroolMethod.UPDATE_CRON:
          return {
            type: 'response',
            id: requestId,
            result: this.handleUpdateCron(daemonRequest),
          };
        case DaemonDroolMethod.DELETE_CRON:
          return {
            type: 'response',
            id: requestId,
            result: this.handleDeleteCron(daemonRequest),
          };
        case DaemonDroolMethod.HOLD_SESSION_CRONS:
          return {
            type: 'response',
            id: requestId,
            result: this.handleHoldSessionCrons(daemonRequest),
          };
        case DaemonDroolMethod.RESUME_SESSION_CRONS:
          return {
            type: 'response',
            id: requestId,
            result: this.handleResumeSessionCrons(daemonRequest),
          };
        case DaemonDroolMethod.GET_GIT_DIFF:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleGetGitDiff(daemonRequest),
          };
        case DaemonDroolMethod.GIT_PUSH:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleGitPush(daemonRequest),
          };
        case DaemonDroolMethod.GIT_COMMIT:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleGitCommit(daemonRequest),
          };
        case DaemonDroolMethod.CREATE_PR:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleCreatePR(daemonRequest),
          };
        case DaemonDroolMethod.GET_SEMANTIC_DIFF_CACHE:
          return {
            type: 'response',
            id: requestId,
            result:
              DroolRequestHandler.handleGetSemanticDiffCache(daemonRequest),
          };
        case DaemonDroolMethod.SAVE_SEMANTIC_DIFF_CACHE:
          return {
            type: 'response',
            id: requestId,
            result:
              DroolRequestHandler.handleSaveSemanticDiffCache(daemonRequest),
          };
        case DaemonDroolMethod.GENERATE_SEMANTIC_DIFF:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleGenerateSemanticDiff(
              context,
              daemonRequest
            ),
          };
        case DaemonDroolMethod.GET_PROXY_TOKEN:
          return {
            type: 'response',
            id: requestId,
            result: DroolRequestHandler.handleGetProxyToken(),
          };
        case DaemonDroolMethod.GET_WORKSPACE_FILE_CONTENT:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleGetWorkspaceFileContent(daemonRequest),
          };
        case DaemonDroolMethod.GET_REWIND_INFO:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleGetRewindInfo(daemonRequest),
          };
        case DaemonDroolMethod.EXECUTE_REWIND:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleExecuteRewind(daemonRequest),
          };
        case DaemonDroolMethod.COMPACT_SESSION:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleCompactSession(daemonRequest),
          };
        case DaemonDroolMethod.FORK_SESSION:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleForkSession(daemonRequest),
          };
        case DaemonDroolMethod.WARMUP_CACHE:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleWarmupCache(daemonRequest),
          };
        case DaemonDroolMethod.GET_CONTEXT_BREAKDOWN:
          return {
            type: 'response',
            id: requestId,
            result: await this.handleGetContextBreakdown(daemonRequest),
          };
        default: {
          throw new MetaError('Unsupported request contents', {
            method: daemonRequest.method,
          });
        }
      }
    } catch (error) {
      const failureSessionId = tryExtractSessionId(request.params);

      const { code, message, data } =
        DroolRequestHandler.classifyHandlerError(error);

      if (error instanceof InvalidSessionCwdError) {
        logWarn('Invalid cwd supplied to drool request', {
          method: request.method,
          requestId,
          sessionId: failureSessionId,
          code,
          reason: error.message,
          cwd: error.cwd,
        });
      } else {
        logException(error, 'JSON-RPC handler error (drool request)', {
          method: request.method,
          requestId,
          sessionId: failureSessionId,
          code,
        });
      }

      if (request.method === DaemonDroolMethod.GET_GIT_DIFF) {
        Metrics.addToCounter(Metric.DIFF_VIEWER_GET_GIT_DIFF_FAILURE_COUNT, 1, {
          sessionId: failureSessionId,
        });
      } else if (request.method === DaemonDroolMethod.CREATE_PR) {
        Metrics.addToCounter(Metric.DIFF_VIEWER_CREATE_PR_FAILURE_COUNT, 1, {
          sessionId: failureSessionId,
        });
      } else if (request.method === DaemonDroolMethod.GENERATE_SEMANTIC_DIFF) {
        Metrics.addToCounter(
          Metric.DIFF_VIEWER_SEMANTIC_DIFF_GENERATE_FAILURE_COUNT,
          1,
          { sessionId: failureSessionId }
        );
      }

      return {
        type: 'response',
        id: requestId,
        error: { code, message, data },
      };
    }
  }

  private static classifyHandlerError(error: unknown): {
    code: JsonRpcErrorCode;
    message: string;
    data?: Record<string, unknown>;
  } {
    if (error instanceof SessionNotFoundError) {
      return {
        code: JsonRpcErrorCode.ENTITY_NOT_FOUND,
        message: error.message,
        data: error.metadata,
      };
    }
    if (error instanceof InvalidSessionCwdError) {
      return {
        code: JsonRpcErrorCode.INVALID_PARAMS,
        message: error.message,
        data: error.metadata,
      };
    }
    if (error instanceof ProcessExitError) {
      return {
        code: JsonRpcErrorCode.SESSION_DISCONNECTED,
        message: error.message,
        data: error.metadata,
      };
    }
    if (error instanceof ConnectionError) {
      return {
        code: JsonRpcErrorCode.SESSION_DISCONNECTED,
        message: error.message,
        data: error.metadata,
      };
    }
    if (error instanceof TimeoutError) {
      return {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message: error.message,
        data: error.metadata,
      };
    }
    return {
      code: JsonRpcErrorCode.INTERNAL_ERROR,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  private broadcastSessionNotification(
    sessionId: string,
    notification: DaemonSessionNotification['params']['notification']
  ): void {
    const daemonNotification: DaemonSessionNotification = {
      type: 'notification',
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      method: DaemonDroolEvent.SESSION_NOTIFICATION,
      params: {
        sessionId,
        notification,
      },
    };

    this.droolRegistry.broadcastForSession(sessionId, daemonNotification);
  }

  /**
   * Handles permission responses from WebSocket clients
   */
  handlePermissionResponse(
    response: JsonRpcBaseResponseSuccess | JsonRpcBaseResponseFailure
  ): void {
    logInfo('[DroolRequestHandler] Received permission response', {
      requestId: String(response.id),
      payload: response,
    });

    const requestId = response.id;
    if (requestId === null) {
      logException(
        new MetaError('Received permission response with null id'),
        'Permission response handling'
      );
      return;
    }

    const pendingMethod =
      this.pendingDaemonRequests.getPendingMethod(requestId);
    if (!pendingMethod) {
      // No-op if permission already processed (idempotent for retries)
      // This handles the case where the CLI processed the response but the
      // daemon→client response was lost, causing the client to retry
      logWarn(
        '[DroolRequestHandler] Received permission response for unknown request - likely already processed',
        {
          requestId,
        }
      );
      return;
    }

    if (pendingMethod !== DaemonDroolEvent.REQUEST_PERMISSION) {
      logWarn('[DroolRequestHandler] Method mismatch for permission response', {
        requestId,
        method: pendingMethod,
      });
      return;
    }

    if ('error' in response && response.error) {
      this.pendingDaemonRequests.rejectRequest(
        requestId,
        new MetaError('Permission request failed', {
          code: response.error.code,
          message: response.error.message,
        })
      );
    } else if ('result' in response && response.result) {
      const parseResult = RequestPermissionResultSchema.safeParse(
        response.result
      );

      if (parseResult.success) {
        this.pendingDaemonRequests.resolveRequest(
          requestId,
          DaemonDroolEvent.REQUEST_PERMISSION,
          parseResult.data
        );
      } else {
        this.pendingDaemonRequests.rejectRequest(
          requestId,
          new MetaError('Invalid permission response format', {
            cause: parseResult.error,
          })
        );
      }
    } else {
      this.pendingDaemonRequests.rejectRequest(
        requestId,
        new MetaError('Invalid permission response')
      );
    }
  }

  /**
   * Handles AskUser responses from WebSocket clients
   */
  handleAskUserResponse(
    response: JsonRpcBaseResponseSuccess | JsonRpcBaseResponseFailure
  ): void {
    const isErrorResponse = 'error' in response && Boolean(response.error);
    const hasResultPayload =
      'result' in response && response.result !== undefined;
    const responseType = isErrorResponse
      ? 'error'
      : hasResultPayload
        ? 'result'
        : 'empty';

    logInfo('[DroolRequestHandler] Received ask-user response', {
      requestId: String(response.id),
      result: responseType,
      isEmpty: responseType === 'empty',
    });

    const requestId = response.id;
    if (requestId === null) {
      logException(
        new MetaError('Received ask-user response with null id'),
        'AskUser response handling'
      );
      return;
    }

    const pendingMethod =
      this.pendingDaemonRequests.getPendingMethod(requestId);
    if (!pendingMethod) {
      // No-op if already processed (idempotent for retries)
      logWarn(
        '[DroolRequestHandler] Received ask-user response for unknown request - likely already processed',
        { requestId }
      );
      return;
    }

    if (pendingMethod !== DaemonDroolEvent.ASK_USER) {
      logWarn('[DroolRequestHandler] Method mismatch for ask-user response', {
        requestId,
        method: pendingMethod,
      });
      return;
    }

    if ('error' in response && response.error) {
      this.pendingDaemonRequests.rejectRequest(
        requestId,
        new MetaError('AskUser request failed', {
          code: response.error.code,
          message: response.error.message,
        })
      );
      return;
    }

    if ('result' in response && response.result) {
      const parseResult = AskUserResultSchema.safeParse(response.result);

      if (parseResult.success) {
        this.pendingDaemonRequests.resolveRequest(
          requestId,
          DaemonDroolEvent.ASK_USER,
          parseResult.data
        );
        return;
      }

      this.pendingDaemonRequests.rejectRequest(
        requestId,
        new MetaError('Invalid ask-user response format', {
          cause: parseResult.error,
        })
      );
      return;
    }

    this.pendingDaemonRequests.rejectRequest(
      requestId,
      new MetaError('Invalid ask-user response')
    );
  }

  private dispatchPendingRequest(
    requestId: string,
    sessionId: string,
    listener: IAuthedDaemonConnection,
    options?: { targetListenerOnly?: boolean }
  ): PendingDaemonRequestDispatchResult {
    const dispatchResult = this.pendingDaemonRequests.dispatchRequest({
      requestId,
      listener,
      send: (targetListener, requestMessage) => {
        this.droolRegistry.broadcastForSession(
          sessionId,
          requestMessage,
          options?.targetListenerOnly ? targetListener : undefined
        );
      },
    });

    if (dispatchResult === PendingDaemonRequestDispatchResult.Sent) {
      logInfo('[DroolRequestHandler] Dispatched pending daemon request', {
        requestId,
        sessionId,
      });
      return dispatchResult;
    }

    if (dispatchResult === PendingDaemonRequestDispatchResult.Failed) {
      logWarn(
        '[DroolRequestHandler] Failed to dispatch pending daemon request',
        {
          requestId,
          sessionId,
          result: dispatchResult,
        }
      );
    }

    return dispatchResult;
  }

  private dispatchPendingRequestsForListener(
    sessionId: string,
    listener: IAuthedDaemonConnection
  ): void {
    const pendingRequestIds =
      this.pendingDaemonRequests.getRequestIdsForSession(sessionId);

    if (pendingRequestIds.length === 0) {
      return;
    }

    for (const requestId of pendingRequestIds) {
      this.dispatchPendingRequest(requestId, sessionId, listener, {
        targetListenerOnly: true,
      });
    }
  }

  /**
   * Sets up event forwarding from DroolClient to all subscribed WebSockets.
   * Should only be called ONCE when the DroolClient is first created.
   * Returns cleanup function to remove event handlers.
   */
  private setupEventForwarding(
    client: DroolClient,
    sessionId: string
  ): () => void {
    const notificationHandler = (event: SessionNotificationEvent) => {
      // Extract parent context from CLI's _meta if available
      const parentContext = event._meta?.traceparent
        ? OtelTracing.extractContext(event._meta)
        : undefined;

      // Wrap notification handling in a span linked to CLI's context
      OtelTracing.trace(
        SpanName.DAEMON_RECEIVE_NOTIFICATION,
        () => {
          const { params } = event;

          const parseResult = CliRequestOrNotificationSchema.safeParse({
            type: 'notification' as const,
            industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
            industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
            jsonrpc: JSONRPC_VERSION,
            method: DroolClientMethod.SESSION_NOTIFICATION,
            params,
          });

          if (!parseResult.success) {
            logException(
              new MetaError('Invalid session notification format', {
                sessionId,
                cause: parseResult.error,
              }),
              'Session notification validation'
            );
            return;
          }
          if (parseResult.data.type !== 'notification') {
            return;
          }
          const validatedNotification = parseResult.data.params.notification;

          // Check if this is a process crash notification
          if (
            validatedNotification.type === SessionNotificationType.ERROR &&
            validatedNotification.errorType ===
              DroolErrorType.PROCESS_EXIT_ERROR
          ) {
            logInfo('Drool process crashed, scheduling cleanup', {
              sessionId,
              message: validatedNotification.message,
            });

            // Clean up the drool client after sending the notification
            // Similar to how we handle inactivity timeout
            setImmediate(() => {
              void this.droolRegistry.unregisterDroolClient(sessionId);
            });

            const processExitedNotification: DaemonSessionNotification = {
              type: 'notification' as const,
              industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
              industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
              jsonrpc: JSONRPC_VERSION,
              method: DaemonDroolEvent.SESSION_NOTIFICATION as const,
              params: {
                sessionId,
                notification: {
                  type: DaemonSpecificNotificationType.SESSION_PROCESS_EXITED,
                  message: validatedNotification.message,
                  timestamp: Date.now(),
                },
              },
            };

            try {
              this.droolRegistry.broadcastForSession(
                sessionId,
                processExitedNotification
              );
            } catch (err) {
              logWarn(
                '[Daemon] Failed to broadcast process exit session notification',
                {
                  sessionId,
                  error: err instanceof Error ? err.message : 'Unknown error',
                }
              );
            }
          }

          // Inject trace context for distributed tracing propagation
          const _meta: TraceContextMeta = {};
          OtelTracing.injectContext(_meta, OtelTracing.getCurrentContext());

          const notification: DaemonSessionNotification = {
            type: 'notification' as const,
            industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
            industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
            jsonrpc: JSONRPC_VERSION,
            method: DaemonDroolEvent.SESSION_NOTIFICATION as const,
            params: {
              sessionId,
              notification: validatedNotification,
            },
            _meta: _meta.traceparent ? _meta : undefined,
          };

          // Broadcast to all connected websockets for this session
          try {
            this.droolRegistry.broadcastForSession(sessionId, notification);
          } catch (err) {
            // Don't re-throw - notifications are best-effort
            logWarn('[Daemon] Failed to broadcast session notification', {
              cause: err,
            });
          }
        },
        {
          attributes: {
            [SpanAttribute.SESSION_ID]: sessionId,
            [SpanAttribute.NOTIFICATION_TYPE]: event.params.notification.type,
          },
          parentContext,
        }
      );
    };

    client.on(DroolClientEvent.SESSION_NOTIFICATION, notificationHandler);

    // Set up permission handler
    client.setPermissionHandler(async (event) => {
      const requestId = event.id;
      let resolvePendingRequest!: (value: unknown) => void;
      let rejectPendingRequest!: (error: Error) => void;

      const pendingResponsePromise = new Promise<RequestPermissionResult>(
        (resolve, reject) => {
          resolvePendingRequest = (value: unknown) => {
            const parsed = RequestPermissionResultSchema.safeParse(value);
            if (parsed.success) {
              resolve(parsed.data);
              return;
            }

            // Handle bare ToolConfirmationOutcome (backward compat)
            if (isToolConfirmationOutcome(value)) {
              resolve({ selectedOption: value });
              return;
            }

            reject(
              new MetaError('Invalid permission response payload', {
                sessionId,
                requestId,
              })
            );
          };
          rejectPendingRequest = reject;
        }
      );

      // Reset timeout on permission request (drool process activity)
      await this.droolRegistry.safeExtendSessionTimeout(sessionId);

      // Extract parent context from CLI's _meta if available
      const parentContext = event._meta?.traceparent
        ? OtelTracing.extractContext(event._meta)
        : undefined;

      // Create a short-lived span for receiving and forwarding the permission request
      // The span ends after forwarding, not when the response comes back
      await OtelTracing.trace(
        SpanName.DAEMON_RECEIVE_PERMISSION_REQUEST,
        async () => {
          // Inject trace context for distributed tracing propagation
          const _meta: TraceContextMeta = {};
          OtelTracing.injectContext(_meta, OtelTracing.getCurrentContext());

          // Forward permission request to all connected WebSockets
          const permissionRequest: DaemonRequestPermission = {
            type: 'request' as const,
            industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
            industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
            jsonrpc: JSONRPC_VERSION,
            id: requestId,
            method: DaemonDroolEvent.REQUEST_PERMISSION,
            params: {
              sessionId,
              ...event.params,
            },
            _meta: _meta.traceparent ? _meta : undefined,
          };

          this.pendingDaemonRequests.addRequest({
            sessionId,
            payload: permissionRequest,
            resolve: resolvePendingRequest,
            reject: rejectPendingRequest,
          });

          const activeListener =
            this.droolRegistry.getActiveListenerForSession(sessionId);
          if (activeListener) {
            this.dispatchPendingRequest(requestId, sessionId, activeListener);
          } else {
            logInfo(
              '[DroolRequestHandler] Queued permission request without active listener',
              {
                requestId,
                sessionId,
              }
            );
          }
        },
        {
          attributes: {
            [SpanAttribute.SESSION_ID]: sessionId,
            [SpanAttribute.RPC_REQUEST_ID]: requestId,
          },
          parentContext,
        }
      );

      return pendingResponsePromise;
    });

    // Set up ask-user handler
    client.setAskUserHandler(async (event) => {
      const requestId = event.id;
      let resolvePendingRequest!: (value: unknown) => void;
      let rejectPendingRequest!: (error: Error) => void;

      const pendingResponsePromise = new Promise<AskUserResult>(
        (resolve, reject) => {
          resolvePendingRequest = (value: unknown) => {
            const parseResult = AskUserResultSchema.safeParse(value);
            if (!parseResult.success) {
              reject(
                new MetaError('Invalid ask-user response payload', {
                  sessionId,
                  requestId,
                  cause: parseResult.error,
                })
              );
              return;
            }

            resolve(parseResult.data);
          };
          rejectPendingRequest = reject;
        }
      );

      // Reset timeout on ask-user request (drool process activity)
      await this.droolRegistry.safeExtendSessionTimeout(sessionId);

      const parentContext = event._meta?.traceparent
        ? OtelTracing.extractContext(event._meta)
        : undefined;

      await OtelTracing.trace(
        SpanName.DAEMON_RECEIVE_ASK_USER_REQUEST,
        async () => {
          const _meta: TraceContextMeta = {};
          OtelTracing.injectContext(_meta, OtelTracing.getCurrentContext());

          const askUserRequest: DaemonAskUser = {
            type: 'request' as const,
            industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
            industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
            jsonrpc: JSONRPC_VERSION,
            id: requestId,
            method: DaemonDroolEvent.ASK_USER,
            params: {
              sessionId,
              toolCallId: event.params.toolCallId,
              questions: event.params.questions,
            },
            _meta: _meta.traceparent ? _meta : undefined,
          };

          this.pendingDaemonRequests.addRequest({
            sessionId,
            payload: askUserRequest,
            resolve: resolvePendingRequest,
            reject: rejectPendingRequest,
          });

          const activeListener =
            this.droolRegistry.getActiveListenerForSession(sessionId);
          if (activeListener) {
            this.dispatchPendingRequest(requestId, sessionId, activeListener);
          } else {
            logInfo(
              '[DroolRequestHandler] Queued ask-user request without active listener',
              {
                requestId,
                sessionId,
              }
            );
          }
        },
        {
          attributes: {
            [SpanAttribute.SESSION_ID]: sessionId,
            [SpanAttribute.RPC_REQUEST_ID]: requestId,
          },
          parentContext,
        }
      );

      return pendingResponsePromise;
    });

    // Inactivity cleanup drops pending prompts; explicit user stops reject them elsewhere.
    return () => {
      client.off(DroolClientEvent.SESSION_NOTIFICATION, notificationHandler);
      client.clearPermissionHandler();
      client.clearAskUserHandler();

      this.pendingDaemonRequests.dropRequestsForSession(sessionId);
    };
  }

  /**
   * Get the method that initiated a request (for routing responses)
   */
  getPendingRequestMethod(requestId: string): DaemonDroolEvent | undefined {
    const pendingMethod =
      this.pendingDaemonRequests.getPendingMethod(requestId);
    return pendingMethod;
  }

  rejectPendingInteractiveRequestsForSessions(
    sessionIds: string[],
    error: MetaError
  ): void {
    for (const sessionId of sessionIds) {
      const rejectedCount = this.pendingDaemonRequests.rejectRequestsForSession(
        sessionId,
        error
      );

      if (rejectedCount > 0) {
        logException(
          error,
          '[DroolRequestHandler] Rejected pending interactive requests for session',
          {
            sessionId,
            count: rejectedCount,
          }
        );
      }
    }
  }

  private async handleInitializeSession(
    context: IAuthedDaemonConnection,
    request: DaemonInitializeSessionRequest
  ): Promise<DaemonInitializeSessionResult> {
    const { params: typedParams } = request;

    await enforceMissionPolicyForDaemon(
      typedParams.interactionMode,
      context.user.userId,
      getMissionSessionRoleFromTags(typedParams.tags) ??
        typedParams.decompSessionType,
      typedParams.tags
    );

    logInfo('Drool InitializeSession method called', {
      sessionId: typedParams.sessionId,
    });

    // Resolve cwd once (trim, expand `~`, normalize) so every downstream
    // consumer (process spawn, registry, automations) sees an
    // absolute path. `cwd` is required by InitializeSessionRequestParamsSchema,
    // so no undefined-fallback branch is needed here.
    const resolvedCwd = resolveWorkingDirectory(typedParams.cwd);

    // Validate the resolved cwd before spawning the drool process so callers
    // get a structured INVALID_PARAMS error instead of an opaque "Failed to
    // send request" produced by a child_process spawn failure on a missing
    // directory.
    let cwdValidation = await validateWorkingDirectory(resolvedCwd);
    if (
      !cwdValidation.isValid &&
      isAutomationRunSession(typedParams.tags) &&
      isUserAutomationCwd(resolvedCwd)
    ) {
      try {
        await fs.promises.mkdir(resolvedCwd, { recursive: true });
        cwdValidation = await validateWorkingDirectory(resolvedCwd);
        logInfo('[Automation] Created missing run cwd before session init', {
          sessionId: typedParams.sessionId,
          path: resolvedCwd,
        });
      } catch (err) {
        logWarn('[Automation] Failed to create missing run cwd', {
          sessionId: typedParams.sessionId,
          path: resolvedCwd,
          cause: err,
        });
      }
    }
    if (!cwdValidation.isValid) {
      throw new InvalidSessionCwdError(
        typedParams.cwd,
        cwdValidation.error ?? 'Invalid working directory'
      );
    }

    // If the caller asked for a worktree session, derive (or reuse) a worktree
    // here so the spawned drool child gets the worktree path as its cwd.
    // The unique-suffix collision guard prevents two concurrent desktop
    // sessions started from the same branch from silently sharing a single
    // worktree directory.
    let worktreeInfo: WorktreeSessionInfo | undefined;
    let effectiveCwd = resolvedCwd;
    const sessionUuid = typedParams.sessionId ?? crypto.randomUUID();

    // Resolve the effective worktree flag. The frontend may send `undefined`
    // when the user submits before the async session-defaults query resolves;
    // in that case fall back to the on-disk session default so the daemon
    // remains the source of truth (matching the CLI's synchronous read).
    let effectiveWorktreeFlag = typedParams.worktree;
    let effectiveWorktreeDir = typedParams.worktreeDir;
    if (effectiveWorktreeFlag === undefined) {
      const disk = await getWorktreeDefaults();
      effectiveWorktreeFlag = disk.runInWorktree;
      effectiveWorktreeDir = effectiveWorktreeDir ?? disk.worktreeDirectory;
    }

    if (effectiveWorktreeFlag) {
      try {
        worktreeInfo = await setupWorktree(true, {
          worktreeDir: effectiveWorktreeDir,
          cwd: resolvedCwd,
          uniqueSuffix: sessionUuid,
        });
        effectiveCwd = worktreeInfo.path;
        logInfo(
          worktreeInfo.isNewlyCreated
            ? 'Created session worktree'
            : 'Reusing existing session worktree',
          {
            sessionId: sessionUuid,
            branch: worktreeInfo.branch,
            path: worktreeInfo.path,
          }
        );
      } catch (err) {
        if (
          err instanceof WorktreeSetupError &&
          /Not inside a git repository/i.test(err.message)
        ) {
          logWarn(
            'Worktree requested but cwd is not a git repo; falling back to cwd',
            { cwd: resolvedCwd, cause: err }
          );
        } else {
          throw new MetaError('Failed to set up worktree for session', {
            cause: err,
            cwd: resolvedCwd,
          });
        }
      }
    }

    // Automation *create* (setup) sessions are dispatched with the machine
    // home directory as cwd, but the setup agent scaffolds files using paths
    // relative to its working directory. Running in home leaks the scaffold
    // (`HEARTBEAT.md`, `memory/`, `reports/`, `VISUAL.html`) into `~` instead
    // of the automation directory. Resolve the automation directory from the
    // home-dir base and run the setup session inside it so relative paths
    // resolve correctly regardless of prompt wording. Worktree sessions keep
    // their derived worktree cwd.
    const createAutomationCwd = worktreeInfo
      ? undefined
      : resolveCreateAutomationCwd(typedParams.tags);
    if (createAutomationCwd) {
      // Best-effort: a mkdir failure must not block session init. Fall back to
      // the original (home) cwd, mirroring the non-blocking visual-scaffold
      // step (`ensureAutomationVisualFile`) that previously created this
      // directory.
      try {
        await fs.promises.mkdir(createAutomationCwd, { recursive: true });
        effectiveCwd = createAutomationCwd;
        logInfo(
          '[Automation] Running create session inside automation directory',
          { sessionId: sessionUuid, path: createAutomationCwd }
        );
      } catch (err) {
        logWarn(
          '[Automation] Failed to create automation directory; using home cwd',
          { sessionId: sessionUuid, path: createAutomationCwd, cause: err }
        );
      }
    }

    // Create new DroolClient with ProcessTransport, passing token via env var
    const droolExecExtraArgs = typedParams.skipPermissionsUnsafe
      ? ['--skip-permissions-unsafe']
      : [];
    const sessionOriginHint = this.getSessionOriginHintForSpawn(
      context,
      typedParams
    );
    const transport = new ProcessTransport({
      cwd: effectiveCwd,
      droolExecPath: this.droolExecPath,
      isDevelopment: this.isDevelopment,
      droolExecExtraArgs,
      env: this.buildSpawnEnv(
        context.user,
        {
          ...(typedParams.runtimeSettingsPath
            ? {
                [EnvironmentVariable.INDUSTRY_RUNTIME_SETTINGS_PATH]:
                  typedParams.runtimeSettingsPath,
              }
            : {}),
        },
        context.caller
      ),
      enableIpc: this.attachChildIpc !== undefined,
    });
    const client = new DroolClient({ transport });
    let cleanup: (() => void) | undefined;
    let sessionId: string | undefined;

    try {
      // Spawn the drool process
      await this.connectProcessTransport({
        transport,
        context,
        sourceSessionId: typedParams.sessionId,
        connect: () =>
          OtelTracing.trace(SpanName.DAEMON_DROOL_SPAWN, () =>
            transport.connect()
          ),
      });

      // Initialize session
      const { token: _token, ...initializeSessionParams } = typedParams;
      const response = await client.initializeSession({
        ...initializeSessionParams,
        cwd: effectiveCwd,
        sessionOriginHint,
      });

      if (response.error) {
        throw new MetaError('Failed to initialize session', {
          code: response.error.code,
          message: response.error.message,
          data: response.error.data,
        });
      }

      const result = InitializeSessionResultSchema.parse(response.result);

      // Store sessionId for error cleanup
      sessionId = result.sessionId;

      // Set up event forwarding (broadcasts to all websockets). Worktree
      // cleanup is intentionally NOT wired here: it runs only on explicit
      // `CloseSession` (handled below in `handleCloseSession`) so that
      // crashes, transport reconnects, inactivity timeouts, and daemon
      // shutdown all preserve the worktree on disk.
      cleanup = this.setupEventForwarding(client, sessionId);
      await this.droolRegistry.registerClient({
        sessionId,
        droolClient: client,
        connection: context,
        cleanupFn: cleanup,
        cwd: effectiveCwd,
        // When `cwd` is already inside a linked worktree, setupWorktree records
        // `repoRoot` as the worktree path (because `findGitRoot` returns the
        // worktree). Re-resolve via `resolveRepoRoot` so the registry stores
        // the main repo root and sidebar grouping works correctly.
        repoRoot: worktreeInfo
          ? (resolveRepoRoot(effectiveCwd) ?? worktreeInfo.repoRoot)
          : undefined,
        worktreeInfo,
        hostId: result.hostId,
        decompSessionType: typedParams.decompSessionType,
        tags: typedParams.tags,
        inactivityTimeoutMs: typedParams.inactivityTimeoutMs,
        skipPermissionsUnsafe: typedParams.skipPermissionsUnsafe,
        runtimeSettingsPath: typedParams.runtimeSettingsPath,
        disableInactivityTimeout: typedParams.disableInactivityTimeout,
      });

      // Set initial message count from initialized session
      this.droolRegistry.setMessagesCount(
        sessionId,
        result.session.messages.length
      );
      this.cronRegistry.resumeSessionCrons(sessionId);
      this.cronRuntime.sync();

      // Title-stamp any session created with an automation tag that carries a
      // human-readable name (added by #13818 / AUT-256).
      const titleStampTag = typedParams.tags?.find(
        (tag) => tag.name === 'automation'
      );
      const titleStampName = titleStampTag?.metadata?.automationName
        ? String(titleStampTag.metadata.automationName).trim()
        : '';
      if (titleStampTag && titleStampName) {
        const automationSessionId = sessionId;
        if (!automationSessionId) {
          throw new MetaError('Automation session ID missing after initialize');
        }
        try {
          this.applyManualSessionTitle(
            automationSessionId,
            `[Automation] ${titleStampName}`
          );
        } catch (titleError) {
          logWarn('[Automation] Failed to set session title', {
            sessionId: automationSessionId,
            cause: titleError,
          });
        }
      } else if (titleStampTag) {
        logWarn(
          '[Automation] Skipping title stamp: automationName missing from tag metadata',
          { sessionId }
        );
      }

      // Track automation sessions for visual snapshots and post-run sync.
      // Accepts both run-typed tags and create-typed tags that carry an
      // automationId (introduced by AUT-227 to fix 500s during create).
      const automationTag = typedParams.tags?.find((tag) => {
        const type = String(tag.metadata?.type ?? '');
        return (
          tag.name === 'automation' &&
          (type === 'run' ||
            (type === 'create' && tag.metadata?.automationId !== undefined))
        );
      });
      if (automationTag) {
        const automationTagType = String(automationTag.metadata?.type ?? '');
        const tagAutomationId = String(
          automationTag.metadata?.automationId ?? ''
        );
        const automationName = automationTag.metadata?.automationName
          ? String(automationTag.metadata.automationName)
          : 'Automation';
        // Run sessions may execute in the automation's configured
        // `workingDirectory` instead of its scaffold directory, so the session
        // cwd cannot be assumed to be the scaffold path. Resolve the scaffold
        // directory via local discovery so VISUAL.html bookkeeping and visual
        // snapshots stay anchored to the automation directory, falling back to
        // the session cwd only when the automation cannot be found locally.
        const automationPath =
          automationTagType === 'create'
            ? (createAutomationCwd ??
              resolveCreateAutomationPath(
                automationTag.metadata?.automationSlug
                  ? String(automationTag.metadata.automationSlug)
                  : automationName,
                tagAutomationId || undefined
              ))
            : ((tagAutomationId
                ? (await this.discoverAutomationById(tagAutomationId))?.path
                : undefined) ?? resolvedCwd);
        await ensureAutomationVisualFile(automationPath, automationName);
        const rawTriggerSource = automationTag.metadata?.triggerSource
          ? String(automationTag.metadata.triggerSource)
          : undefined;
        const triggerSource: AutomationRunTriggerSource | undefined =
          rawTriggerSource && isAutomationRunTriggerSource(rawTriggerSource)
            ? rawTriggerSource
            : undefined;
        if (automationTagType === 'run' && rawTriggerSource && !triggerSource) {
          logWarn(
            '[Automation] Ignoring unrecognized triggerSource on run tag; outcome metrics will not fire',
            {
              automationId: tagAutomationId,
              // eslint-disable-next-line industry/no-nested-log-metadata -- raw unrecognized trigger-source value retained for diagnosis
              value: { rawTriggerSource },
            }
          );
        } else if (automationTagType === 'run' && !rawTriggerSource) {
          logWarn(
            '[Automation] Run tag missing triggerSource; outcome metrics will not fire',
            { automationId: tagAutomationId }
          );
        }
        const automationSessionId = sessionId;
        if (!automationSessionId) {
          throw new MetaError('Automation session ID missing after initialize');
        }
        const automationSessionSourceComputerId =
          typedParams.sessionSource?.platform === SessionPlatform.Automation
            ? typedParams.sessionSource.computerId
            : undefined;
        const executionLocation: 'local' | 'remote' =
          Boolean(automationSessionSourceComputerId) ||
          typedParams.machineId !== LOCAL_MACHINE_ID
            ? 'remote'
            : 'local';
        const outcome: AutomationOutcomeTracking =
          automationTagType === 'run' && triggerSource
            ? {
                kind: 'run',
                executionLocation,
                triggerSource,
              }
            : automationTagType === 'create'
              ? { kind: 'create', executionLocation }
              : { kind: 'none' };
        const automationUuid = automationTag.metadata?.automationUuid
          ? String(automationTag.metadata.automationUuid)
          : automationTagType === 'create'
            ? tagAutomationId
            : undefined;
        await this.setupAutomationOutcomeTracking({
          client,
          sessionId: automationSessionId,
          info: {
            automationId: tagAutomationId,
            automationPath,
            automationUuid,
            outcome,
            // App-initiated automation sessions are user-attended: keep them
            // open across turns and re-publish the visual on each idle so
            // later-turn edits reach the dashboard.
            keepAliveForVisualEdits: true,
            ...(automationTagType === 'create'
              ? { syncRequiresCompleteStructure: true }
              : {}),
          },
        });
      }

      if (worktreeInfo) {
        return {
          ...result,
          worktree: {
            branch: worktreeInfo.branch,
            path: worktreeInfo.path,
            repoRoot: resolveRepoRoot(effectiveCwd) ?? worktreeInfo.repoRoot,
            isNewlyCreated: worktreeInfo.isNewlyCreated,
          },
        };
      }
      return result;
    } catch (error) {
      // Reject pending prompts before cleanup drops them.
      if (sessionId) {
        this.rejectPendingInteractiveRequestsForSessions(
          [sessionId],
          new MetaError('Session initialization failed', {
            sessionId,
          })
        );
      }

      // Clean up event handlers if they were set up
      if (cleanup) {
        cleanup();
      }

      // If worktree was created but session init failed afterwards, clean it up.
      if (worktreeInfo && worktreeInfo.isNewlyCreated) {
        await cleanupWorktree(worktreeInfo, {
          print: (msg) =>
            logInfo('[Daemon Worktree init-fail] cleanup', { message: msg }),
        }).catch((cleanupErr) =>
          logException(cleanupErr, 'Worktree cleanup after init failure failed')
        );
      }

      // Clean up client/transport on failure to prevent leaked child process
      await client.close().catch((closeError) => {
        logException(
          closeError,
          'Failed to close client after initialization error'
        );
      });
      throw error;
    }
  }

  private async handleLoadSession(
    context: IAuthedDaemonConnection,
    request: DaemonLoadSessionRequest
  ): Promise<DaemonLoadSessionResult> {
    const { params: typedParams } = request;
    const sessionId = typedParams.sessionId;
    const sessionOriginHint = this.getSessionOriginHintForLoad(
      context,
      typedParams
    );

    logInfo('Drool LoadSession method called', { sessionId });

    // Don't load archived (soft-deleted) sessions
    if (DroolRequestHandler.isSessionArchived(sessionId)) {
      throw new SessionNotFoundError(sessionId);
    }

    // If another load is in progress for this session, wait for it to complete
    // then proceed to register our websocket (or retry if it failed)
    const pendingLoad = this.pendingLoadOperations.get(sessionId);
    if (pendingLoad) {
      logInfo('Waiting for pending load operation', { sessionId });
      try {
        const result = await pendingLoad;
        const state = this.droolRegistry.getSessionState(sessionId);
        if (state && typedParams.disableInactivityTimeout !== undefined) {
          state.disableInactivityTimeout = typedParams.disableInactivityTimeout;
        }
        // Pending load succeeded - register our websocket and return the cached result
        const added = await this.droolRegistry.addConnectionToSession(
          sessionId,
          context
        );
        if (!added) {
          throw new MetaError(
            'Failed to add websocket to session after pending load',
            {
              sessionId,
            }
          );
        }
        return result;
      } catch (error) {
        // Pending load failed - proceed with our own attempt
        logWarn('Pending load operation failed, proceeding with new attempt', {
          sessionId,
          cause: error,
        });
      }
    }

    // Create a promise for this load operation
    const loadOperationPromise = (async () => {
      const preservedInactivityTimeoutMs =
        this.droolRegistry.getSessionState(sessionId)?.inactivityTimeoutMs;
      const preservedDisableInactivityTimeout =
        this.droolRegistry.getSessionState(sessionId)?.disableInactivityTimeout;

      // Try to get an existing client for this session
      let client = this.droolRegistry.getDroolClient(sessionId);

      if (client) {
        if (!client.isConnected) {
          // There is a client persisted, but it is disconnected.
          // For remote sessions: this could happen due to race conditions
          // in the daemon restarting and the child drool processes getting killed,
          // especially with memory persistence across hibernations.
          logInfo('Existing DroolClient is disconnected, unregistering', {
            sessionId,
          });
          await this.droolRegistry.unregisterDroolClient(sessionId);
          client = undefined;
        } else {
          logInfo('Reusing existing DroolClient for session', {
            sessionId,
          });
        }
      }

      // If no existing client, check if another request is already creating one
      if (!client) {
        const pendingCreation =
          this.droolRegistry.getPendingClientCreation(sessionId);

        if (pendingCreation) {
          logInfo('Waiting for pending DroolClient creation', {
            sessionId,
          });

          client = await pendingCreation;
          if (!client) {
            throw new MetaError(
              'Client creation completed but client not found',
              {
                sessionId,
              }
            );
          }
        }
      }

      // If we have a client (existing or from pending creation), reuse it
      if (client) {
        const state = this.droolRegistry.getSessionState(sessionId);
        if (state && typedParams.disableInactivityTimeout !== undefined) {
          state.disableInactivityTimeout = typedParams.disableInactivityTimeout;
        }
        const added = await this.droolRegistry.addConnectionToSession(
          sessionId,
          context
        );

        if (!added) {
          throw new MetaError('Failed to add websocket to session', {
            sessionId,
          });
        }

        const response = await client.loadSession({
          sessionId,
          mcpServers: typedParams.mcpServers,
          loadAllMessages: typedParams.loadAllMessages,
          mcpOAuthCallbackUri: typedParams.mcpOAuthCallbackUri,
          sessionOriginHint,
        });

        if (response.error) {
          throw new MetaError('Failed to load session state', {
            code: response.error.code,
            message: response.error.message,
            data: response.error.data,
          });
        }

        // CLI now handles PDF content population - pass through unchanged
        const parsed = LoadSessionResultSchema.parse(response.result);
        const loadResult = DroolRequestHandler.ensureCwdOnLoadResult(
          sessionId,
          parsed,
          this.droolRegistry
        );
        return loadResult;
      }

      // No existing client and no pending creation - create a new one
      logInfo('Creating new DroolClient for session', {
        sessionId,
      });

      // Track this creation to prevent concurrent duplicates
      const creationPromise = this.createDroolClientForLoadSession({
        sessionId,
        mcpServers: typedParams.mcpServers,
        loadAllMessages: typedParams.loadAllMessages,
        mcpOAuthCallbackUri: typedParams.mcpOAuthCallbackUri,
        sessionOriginHint,
        skipPermissionsUnsafe: typedParams.skipPermissionsUnsafe,
        inactivityTimeoutMs:
          this.droolRegistry.getSessionState(sessionId)?.inactivityTimeoutMs ??
          preservedInactivityTimeoutMs,
        disableInactivityTimeout:
          typedParams.disableInactivityTimeout ??
          this.droolRegistry.getSessionState(sessionId)
            ?.disableInactivityTimeout ??
          preservedDisableInactivityTimeout,
        runtimeSettingsPath: typedParams.runtimeSettingsPath,
        context,
      });

      // Store promise that resolves to client only for registry tracking
      // The promise will reject with the actual error so concurrent requests get proper error info
      const clientPromise = creationPromise.then((result) => result.client);

      // Attach a no-op rejection handler to prevent Node.js unhandled rejection warnings
      // The actual error handling happens in the try/catch blocks (original request below,
      // concurrent requests in the pending creation block above)
      clientPromise.catch(() => {
        // Intentionally empty - errors are handled by awaiting code
      });

      this.droolRegistry.setPendingClientCreation(sessionId, clientPromise);

      try {
        const { result } = await creationPromise;
        return result;
      } finally {
        // Clean up pending creation tracking
        this.droolRegistry.deletePendingClientCreation(sessionId);
      }
    })();

    // Track this load operation
    this.pendingLoadOperations.set(sessionId, loadOperationPromise);

    try {
      const result = await loadOperationPromise;
      this.cronRegistry.resumeSessionCrons(sessionId);
      this.cronRuntime.sync();
      return result;
    } finally {
      // Clean up pending load operation tracking
      this.pendingLoadOperations.delete(sessionId);
    }
  }

  /**
   * Creates a new DroolClient for an existing session and registers it.
   * This is extracted to allow proper tracking of pending client creations.
   * Returns both the client and the loaded session result to avoid redundant calls.
   */
  private async createDroolClientForLoadSession({
    sessionId,
    mcpServers,
    loadAllMessages,
    mcpOAuthCallbackUri,
    sessionOriginHint,
    skipPermissionsUnsafe,
    inactivityTimeoutMs,
    disableInactivityTimeout,
    runtimeSettingsPath,
    context,
    _meta,
    cwd,
  }: CreateDroolClientForLoadSessionParams): Promise<{
    client: DroolClient;
    result: DaemonLoadSessionResult;
  }> {
    // Check if session file exists before creating client and calling CLI
    // This provides fast failure for non-existent sessions
    if (!DroolRequestHandler.sessionFileExists(sessionId)) {
      throw new SessionNotFoundError(sessionId);
    }

    const droolExecExtraArgs = skipPermissionsUnsafe
      ? ['--skip-permissions-unsafe']
      : [];

    const transport = new ProcessTransport({
      cwd,
      droolExecPath: this.droolExecPath,
      isDevelopment: this.isDevelopment,
      droolExecExtraArgs,
      env: this.buildSpawnEnv(
        context.user,
        {
          ...(runtimeSettingsPath
            ? {
                [EnvironmentVariable.INDUSTRY_RUNTIME_SETTINGS_PATH]:
                  runtimeSettingsPath,
              }
            : {}),
        },
        context.caller
      ),
      enableIpc: this.attachChildIpc !== undefined,
    });
    const client = new DroolClient({ transport });
    let cleanup: (() => void) | undefined;

    try {
      await this.connectProcessTransport({
        transport,
        context,
        sourceSessionId: sessionId,
      });

      // Load existing session to verify it exists
      let response = await client.loadSession({
        sessionId,
        mcpServers,
        loadAllMessages,
        mcpOAuthCallbackUri,
        sessionOriginHint,
      });

      // If we get a model compatibility error, try clearing spec mode and retrying
      if (response.error) {
        const isModelCompatibilityError =
          response.error.message?.includes('Model compatibility error') ||
          response.error.message?.includes('cannot be paired with');

        if (isModelCompatibilityError) {
          logInfo(
            '[Daemon] Model compatibility error on load, clearing spec mode and retrying',
            {
              sessionId,
              code: response.error.code,
              errorMessage: response.error.message,
            }
          );

          // Clear spec mode by sending null
          const clearSpecResponse = await client.updateSessionSettings({
            specModeModelId: null,
          });

          if (clearSpecResponse.error) {
            logWarn('[Daemon] Failed to clear spec mode during recovery', {
              sessionId,
              code: clearSpecResponse.error.code,
              errorMessage: clearSpecResponse.error.message,
            });
            // Continue with original error
            throw new MetaError('Failed to load session', {
              code: response.error.code,
              message: response.error.message,
              data: response.error.data,
            });
          }

          // Retry loading with spec mode cleared
          logInfo('[Daemon] Retrying load after clearing spec mode', {
            sessionId,
          });
          response = await client.loadSession({
            sessionId,
            mcpServers,
            loadAllMessages,
            mcpOAuthCallbackUri,
            sessionOriginHint,
          });
        }

        // If still error after retry (or not a compatibility error), throw
        if (response.error) {
          throw new MetaError('Failed to load session', {
            code: response.error.code,
            message: response.error.message,
            data: response.error.data,
          });
        }
      }

      const parsed = LoadSessionResultSchema.parse(response.result);
      const result = DroolRequestHandler.ensureCwdOnLoadResult(
        sessionId,
        parsed,
        this.droolRegistry
      );

      // Set up event forwarding (broadcasts to all websockets)
      cleanup = DroolRequestHandler.combineCleanups(
        this.setupEventForwarding(client, sessionId)
      );
      await this.droolRegistry.registerClient({
        sessionId,
        droolClient: client,
        connection: context,
        cleanupFn: cleanup,
        cwd: result.cwd,
        hostId: result.hostId,
        decompSessionType: result.decompSessionType,
        tags: result.settings.tags,
        callingSessionId: result.callingSessionId,
        callingToolUseId: result.callingToolUseId,
        inactivityTimeoutMs,
        skipPermissionsUnsafe,
        runtimeSettingsPath,
        disableInactivityTimeout,
      });

      // Set initial message count from loaded session
      this.droolRegistry.setMessagesCount(
        sessionId,
        result.session.messages.length
      );

      // CLI now handles PDF content population - pass through unchanged
      return {
        client,
        result,
      };
    } catch (error) {
      // Reject pending prompts before cleanup drops them.
      this.rejectPendingInteractiveRequestsForSessions(
        [sessionId],
        new MetaError('Session load failed', {
          sessionId,
        })
      );

      // Clean up event handlers if they were set up
      if (cleanup) {
        cleanup();
      }

      // Clean up client/transport on failure to prevent leaked child process
      await client.close().catch((closeError) => {
        logException(closeError, 'Failed to close client after load error');
      });
      throw error;
    }
  }

  private static ensureCwdOnLoadResult(
    sessionId: string,
    result: DaemonLoadSessionResult,
    droolRegistry: DroolRegistry
  ): DaemonLoadSessionResult {
    const state = droolRegistry.getSessionState(sessionId);

    const cwd = result.cwd ?? state?.cwd;
    const callingSessionId = result.callingSessionId ?? state?.callingSessionId;
    const callingToolUseId = result.callingToolUseId ?? state?.callingToolUseId;

    // Update daemon in-memory session state so follow-up requests include resolved metadata.
    if (state) {
      if (cwd) {
        state.cwd = cwd;
      }
      if (callingSessionId) {
        state.callingSessionId = callingSessionId;
      }
      if (callingToolUseId) {
        state.callingToolUseId = callingToolUseId;
      }

      // Hydrate tags from the on-disk settings file so list filters
      // (e.g. btw-fork exclusion) work after daemon restart or session
      // reload, without waiting for an explicit updateSessionSettings RPC.
      if (state.tags === undefined) {
        const settingsPath =
          DroolRequestHandler.getSessionSettingsPath(sessionId);
        if (settingsPath) {
          const settings =
            DroolRequestHandler.readSessionSettings(settingsPath);
          if (settings?.tags) {
            state.tags = settings.tags;
          }
        }
      }
    }

    return {
      ...result,
      ...(cwd && !result.cwd ? { cwd } : {}),
      ...(callingSessionId && !result.callingSessionId
        ? { callingSessionId }
        : {}),
      ...(callingToolUseId && !result.callingToolUseId
        ? { callingToolUseId }
        : {}),
    };
  }

  private async handleAddUserMessage(
    context: IAuthedDaemonConnection,
    request: DaemonAddUserMessageRequest
  ): Promise<DaemonAddUserMessageResult> {
    const { params: typedParams } = request;
    const truncatedText =
      typedParams.text.length > 100
        ? `${typedParams.text.slice(0, 100)}...`
        : typedParams.text;
    logInfo('Drool AddUserMessage method called', {
      sessionId: typedParams.sessionId,
      textPreview: truncatedText,
    });
    const sessionId = typedParams.sessionId;
    // Debug logging for file attachments
    if (typedParams.files && typedParams.files.length > 0) {
      const fileInfo = typedParams.files.map((f) => ({
        name: f.name,
        type: f.type,
        mediaType: f.mediaType,
        hasData: Boolean(f.data),
        dataLength: f.data?.length ?? 0,
        hasParsedData: 'parsedData' in f && Boolean(f.parsedData),
        parsedDataLength:
          'parsedData' in f && typeof f.parsedData === 'string'
            ? f.parsedData.length
            : 0,
      }));
      logInfo('[Daemon] Received files with AddUserMessage', {
        sessionId,
        fileCount: typedParams.files.length,
        data: fileInfo,
      });
    }

    // Try to get existing client, respawn if missing or disconnected
    let client = this.droolRegistry.getDroolClient(sessionId);

    // Get the session state cwd for respawning (needed if client is missing/disconnected)
    const sessionState = this.droolRegistry.getSessionState(sessionId);
    const sessionCwd = sessionState?.cwd;
    const sessionInactivityTimeoutMs = sessionState?.inactivityTimeoutMs;
    const sessionDisableInactivityTimeout =
      sessionState?.disableInactivityTimeout;
    const sessionSkipPermissions = sessionState?.skipPermissionsUnsafe ?? false;
    const sessionRuntimeSettingsPath = sessionState?.runtimeSettingsPath;

    if (!client || !client.isConnected) {
      // Client is missing or disconnected (e.g., after interrupt caused worker process to exit)
      // Respawn a new client by loading the session
      logInfo(
        '[Daemon] AddUserMessage: client missing or disconnected, respawning',
        {
          sessionId,
          clientExists: !!client,
          isConnected: client?.isConnected ?? false,
        }
      );

      // Unregister the disconnected client if it exists
      if (client) {
        await this.droolRegistry.unregisterDroolClient(sessionId);
      }

      // Create a new client for this session, preserving the original permission setting
      const { client: newClient } = await this.createDroolClientForLoadSession({
        sessionId,
        mcpServers: [],
        sessionOriginHint: this.deriveSessionOriginFromContextSurface(context),
        skipPermissionsUnsafe: sessionSkipPermissions,
        inactivityTimeoutMs: sessionInactivityTimeoutMs,
        disableInactivityTimeout: sessionDisableInactivityTimeout,
        runtimeSettingsPath: sessionRuntimeSettingsPath,
        context,
        cwd: sessionCwd,
      });

      client = newClient;

      logInfo('[Daemon] AddUserMessage: client respawned successfully', {
        sessionId,
      });
    }

    const userMessageSource = this.getUserMessageSourceForAddUserMessage(
      context,
      typedParams.userMessageSource
    );

    const addUserMessageParams = {
      ...(typedParams.messageId && { messageId: typedParams.messageId }),
      text: typedParams.text,
      images: typedParams.images,
      files: typedParams.files,
      ...(userMessageSource && { userMessageSource }),
      ...(typedParams.skipAgentLoop && {
        skipAgentLoop: typedParams.skipAgentLoop,
      }),
      ...(typedParams.queuePlacement && {
        queuePlacement: typedParams.queuePlacement,
      }),
      ...(typedParams.role === 'user' && { role: typedParams.role }),
      ...(typedParams.visibility &&
        ['both', 'llm_only', 'user_only'].includes(typedParams.visibility) && {
          visibility: typedParams.visibility,
        }),
    };

    // Pass files through unchanged to CLI - CLI handles PDF storage and processing
    // NOTE: There is a race after daemon.interrupt_session where the worker process exits
    // but the DroolClient may still appear connected. In that case, addUserMessage can throw
    // (e.g., "Client closed"). We retry once by respawning the client.
    let response: Awaited<ReturnType<typeof client.addUserMessage>>;
    try {
      response = await client.addUserMessage(addUserMessageParams, request.id);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error ?? '');

      // Only retry on errors that look like transport/client disconnects.
      const shouldRetry =
        errorMessage.includes('Client closed') ||
        errorMessage.includes('connection closed') ||
        errorMessage.includes('WebSocket');

      if (!shouldRetry) {
        throw error;
      }

      logWarn(
        '[Daemon] AddUserMessage: addUserMessage threw; respawning and retrying once',
        {
          sessionId,
          errorMessage,
        }
      );

      // Best-effort unregister (the client may already be closing).
      await this.droolRegistry.unregisterDroolClient(sessionId).catch(() => {
        // ignore
      });

      const { client: newClient } = await this.createDroolClientForLoadSession({
        sessionId,
        mcpServers: [],
        sessionOriginHint: this.deriveSessionOriginFromContextSurface(context),
        skipPermissionsUnsafe: sessionSkipPermissions,
        inactivityTimeoutMs: sessionInactivityTimeoutMs,
        disableInactivityTimeout: sessionDisableInactivityTimeout,
        runtimeSettingsPath: sessionRuntimeSettingsPath,
        context,
        cwd: sessionCwd,
      });

      client = newClient;
      response = await client.addUserMessage(addUserMessageParams, request.id);
    }

    if (response.error) {
      throw new MetaError('Failed to add user message', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    return AddUserMessageResultSchema.parse(response.result);
  }

  private async handleResolveQueuedUserMessage(
    request: DaemonResolveQueuedUserMessageRequest
  ): Promise<DaemonResolveQueuedUserMessageResult> {
    const { sessionId, ...resolveParams } = request.params;
    const { requestId, action } = resolveParams;
    logInfo('Drool ResolveQueuedUserMessage method called', {
      sessionId,
      requestId,
      actionType: action,
    });

    const client = this.droolRegistry.getDroolClient(sessionId);
    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId,
      });
    }

    const response = await client.resolveQueuedUserMessage(resolveParams);

    if (response.error) {
      throw new MetaError('Failed to resolve queued user message', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    return ResolveQueuedUserMessageResultSchema.parse(response.result);
  }

  private async handleInterruptSession(
    request: DaemonInterruptSessionRequest
  ): Promise<DaemonInterruptSessionResult> {
    logInfo('Drool InterruptSession method called');

    const { params: typedParams } = request;
    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId: typedParams.sessionId,
      });
    }

    // Interrupt the session
    const response = await client.interruptSession({});

    if (response.error) {
      throw new MetaError('Failed to interrupt session', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    this.rejectPendingInteractiveRequestsForSessions(
      [typedParams.sessionId],
      new MetaError('Session interrupted by user', {
        sessionId: typedParams.sessionId,
      })
    );

    return InterruptSessionResultSchema.parse(response.result);
  }

  private async handleCloseSession(
    request: DaemonCloseSessionRequest
  ): Promise<DaemonCloseSessionResult> {
    logInfo('Drool CloseSession method called');

    const { params: typedParams } = request;
    const { sessionId } = typedParams;
    this.rejectPendingInteractiveRequestsForSessions(
      [sessionId],
      new MetaError('Session closed', {
        sessionId,
      })
    );

    const result = {};

    this.cronRegistry.holdSessionCrons(sessionId, 'session-closed');
    this.cronRuntime.sync();

    // Capture worktree info before unregister wipes session state. Worktree
    // cleanup runs only on this explicit-close path; crash/reconnect/timeout/
    // shutdown all leave the worktree on disk so the user can resume work
    // in the same directory.
    const worktreeInfo = this.droolRegistry.getWorktreeInfo(sessionId);
    const hasRegisteredClient =
      this.droolRegistry.getDroolClient(sessionId) !== undefined;

    if (hasRegisteredClient) {
      this.broadcastSessionNotification(sessionId, {
        type: DaemonSpecificNotificationType.SESSION_CLOSED,
        timestamp: Date.now(),
      });
    }

    // Unregister the session from the daemon registry.
    // This closes the DroolClient (terminates the worker process) and
    // cancels any pending inactivity timeouts.
    await this.droolRegistry.unregisterDroolClient(sessionId);

    if (worktreeInfo && worktreeInfo.isNewlyCreated) {
      await cleanupWorktree(worktreeInfo, {
        print: (msg) =>
          logInfo('[Daemon Worktree] cleanup', {
            message: msg,
            sessionId,
            branch: worktreeInfo.branch,
          }),
      }).catch((err) =>
        logWarn('[Daemon Worktree] Cleanup failed', { cause: err })
      );
    }

    return result;
  }

  private async handleKillWorkerSession(
    request: DaemonKillWorkerSessionRequest
  ): Promise<DaemonKillWorkerSessionResult> {
    logInfo('Drool KillWorkerSession method called');

    const { params: typedParams } = request;
    // Route to the ORCHESTRATOR session, not the worker - the orchestrator
    // owns the mission state and should emit notifications on its session
    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active orchestrator session found for ID', {
        sessionId: typedParams.sessionId,
      });
    }

    // Kill the worker session via the orchestrator
    const response = await client.killWorkerSession({
      workerSessionId: typedParams.workerSessionId,
    });

    if (response.error) {
      throw new MetaError('Failed to kill worker session', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    this.rejectPendingInteractiveRequestsForSessions(
      [typedParams.workerSessionId],
      new MetaError('Session killed by user', {
        sessionId: typedParams.workerSessionId,
      })
    );

    return KillWorkerSessionResultSchema.parse(response.result);
  }

  private async handleListOpenedSessions(
    request: DaemonListOpenedSessionsRequest
  ): Promise<DaemonListOpenedSessionsResult> {
    logInfo('Drool ListOpenedSessions method called');
    const missionSessionsFilter = request.params.filter?.missionSessions;
    const includeBtwForks = request.params.filter?.includeBtwForks === true;

    // Get all active sessions from registry (in-memory, fast)
    const registrySessions = this.droolRegistry.getAllSessionsWithStates();
    const registrySessionsById = new Map(
      registrySessions.map((session) => [session.sessionId, session])
    );
    const isDirectOpenedMissionSession = (
      session: (typeof registrySessions)[number]
    ) =>
      Boolean(
        session.decompSessionType ?? getMissionSessionRoleFromTags(session.tags)
      );

    const matchingRegistrySessions: typeof registrySessions = [];
    for (const session of registrySessions) {
      // Read on-disk settings once per session so we can both hydrate tags
      // (when missing from the in-memory registry) and detect archived
      // sessions. Without the archive check, listOpenedSessions leaks
      // archived sessions back into the sidebar after a page refresh
      // because the registry doesn't track `archivedAt`.
      const settingsPath = DroolRequestHandler.getSessionSettingsPath(
        session.sessionId
      );
      const settings = settingsPath
        ? DroolRequestHandler.readSessionSettings(settingsPath)
        : null;

      if (session.tags === undefined && settings?.tags) {
        session.tags = settings.tags;
        this.droolRegistry.setSessionTags(session.sessionId, settings.tags);
      }

      // Hydrate the registry's archive flag from disk so legacy archived
      // sessions (archived before the registry mirror landed) still get
      // dropped after a daemon restart.
      if (!session.archivedAt && settings?.archivedAt) {
        session.archivedAt = settings.archivedAt;
        this.droolRegistry.setSessionArchivedAt(
          session.sessionId,
          settings.archivedAt
        );
      }

      if (session.archivedAt) {
        continue;
      }

      // Exclude btw fork sessions unless explicitly requested — they are
      // managed by the btw panel and should never appear in the sidebar.
      if (
        !includeBtwForks &&
        session.tags?.some((t) => t.name === SESSION_TAG_BTW_FORK)
      ) {
        continue;
      }

      const isMissionSession =
        missionSessionsFilter === undefined
          ? false
          : await isMissionSessionOrDescendant({
              session,
              getSessionId: (candidate) => candidate.sessionId,
              getCallingSessionId: (candidate) => candidate.callingSessionId,
              getParentSession: (sessionId) =>
                registrySessionsById.get(sessionId),
              isDirectMissionSession: isDirectOpenedMissionSession,
            });

      if (
        shouldIncludeMissionSession(isMissionSession, missionSessionsFilter)
      ) {
        matchingRegistrySessions.push(session);
      }
    }

    // Map to response format (updatedAt is already in seconds from registry)
    const sessions = matchingRegistrySessions.map((session) => ({
      sessionId: session.sessionId,
      ...(session.hostId ? { hostId: session.hostId } : {}),
      workingState: session.workingState,
      updatedAt: session.updatedAt,
      cwd: session.cwd,
      ...(session.repoRoot ? { repoRoot: session.repoRoot } : {}),
      messagesCount: session.messagesCount,
      ...(session.callingSessionId
        ? { callingSessionId: session.callingSessionId }
        : {}),
      ...(session.callingToolUseId
        ? { callingToolUseId: session.callingToolUseId }
        : {}),
      ...(session.tags ? { tags: session.tags } : {}),
    }));

    return { sessions };
  }

  private static async handleListAvailableSessions(
    request: DaemonListAvailableSessionsRequest
  ): Promise<DaemonListAvailableSessionsResult> {
    logInfo('Drool ListAvailableSessions method called', {
      limit: request.params.limit,
      timestamp: request.params.endBefore,
      // eslint-disable-next-line industry/no-nested-log-metadata -- query filter snapshot (mission-session/state filters) consumed as a unit
      value: {
        missionSessions: request.params.filter?.missionSessions,
        missionStates: request.params.filter?.missionStates,
      },
    });

    const limit = request.params.limit ?? 50;
    const endBefore = request.params.endBefore;
    const missionSessionsFilter = request.params.filter?.missionSessions;
    const missionStateFilter = new Set(request.params.filter?.missionStates);
    const shouldFilterMissionSessions = missionSessionsFilter !== undefined;
    const shouldReadMissionMetadata =
      request.params.includeMissionMetadata ||
      shouldFilterMissionSessions ||
      missionStateFilter.size > 0;

    // Get all session files from filesystem with timestamps and titles (parallel async)
    const filesystemSessions =
      await DroolRequestHandler.getAllSessionIdsFromFilesystem();

    // Filter out internal sessions (e.g. semantic-diff generation) and archived sessions.
    // /btw forks are stored under sessions/btw/ and are not enumerated
    // by getAllSessionIdsFromFilesystem, so no tag filter is needed.
    const visibleSessions = filesystemSessions.filter(
      (session) =>
        !session.tags?.some((tag) => tag.name === 'semantic-diff') &&
        !session.archivedAt
    );

    // Sort by timestamp (most recent first)
    const sortedSessions = visibleSessions.sort((a, b) => b.mtime - a.mtime);
    const missionsDir = getMissionsDir();
    const missionMetadataBySessionId = new Map<
      string,
      IndustryMissionArtifactMetadata | undefined
    >();
    const readMissionMetadata = (sessionId: string) => {
      if (missionMetadataBySessionId.has(sessionId)) {
        return missionMetadataBySessionId.get(sessionId);
      }

      const mission = readMissionArtifactMetadataForSession({
        missionsDir,
        sessionId,
        onReadError: logMissionArtifactReadError,
      });
      missionMetadataBySessionId.set(sessionId, mission);
      return mission;
    };
    const sortedSessionsById = new Map(
      sortedSessions.map((session) => [session.sessionId, session])
    );
    const isDirectAvailableMissionSession = (
      session: (typeof sortedSessions)[number]
    ) =>
      Boolean(readMissionMetadata(session.sessionId)) ||
      getMissionSessionRoleFromTags(session.tags) !== undefined;

    // Apply cursor pagination
    let filteredSessions = sortedSessions;
    if (endBefore !== undefined) {
      const endBeforeMs = endBefore * 1000; // Convert to milliseconds
      filteredSessions = sortedSessions.filter((s) => s.mtime < endBeforeMs);
    }

    const matchingSessions: SessionIndexEntryWithMissionMetadata[] = [];
    for (const session of filteredSessions) {
      const mission = shouldReadMissionMetadata
        ? readMissionMetadata(session.sessionId)
        : undefined;

      const hasMissionArtifact = Boolean(mission);
      const isMissionSession =
        missionSessionsFilter === false
          ? await isMissionSessionOrDescendant({
              session,
              getSessionId: (candidate) => candidate.sessionId,
              getCallingSessionId: (candidate) => candidate.callingSessionId,
              getParentSession: (sessionId) =>
                sortedSessionsById.get(sessionId),
              isDirectMissionSession: isDirectAvailableMissionSession,
            })
          : hasMissionArtifact;

      if (missionSessionsFilter === true && !hasMissionArtifact) {
        continue;
      }

      if (missionSessionsFilter === false && isMissionSession) {
        continue;
      }

      if (missionStateFilter.size > 0) {
        const missionState = mission?.state;
        if (!missionState || !missionStateFilter.has(missionState)) {
          continue;
        }
      }

      matchingSessions.push(mission ? { ...session, mission } : session);
      if (matchingSessions.length > limit) {
        break;
      }
    }

    // Collect limit + 1 matching sessions to check if there are more results.
    const hasMore = matchingSessions.length > limit;
    const sessionsPage = hasMore
      ? matchingSessions.slice(0, limit)
      : matchingSessions;

    // Map to response format
    const sessions = sessionsPage.map((session) => {
      // Derive repoRoot from cwd (cached per-cwd in resolveRepoRoot) so
      // historical worktree sessions group under their parent project
      // without needing an on-disk schema migration.
      const repoRoot = session.cwd ? resolveRepoRoot(session.cwd) : undefined;
      return {
        sessionId: session.sessionId,
        ...(session.hostId ? { hostId: session.hostId } : {}),
        updatedAt: Math.floor(session.mtime / 1000), // Unix epoch seconds
        ...(session.title ? { title: session.title } : {}),
        cwd: session.cwd,
        ...(repoRoot ? { repoRoot } : {}),
        messagesCount: session.messagesCount,
        ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}),
        ...(session.callingSessionId
          ? { callingSessionId: session.callingSessionId }
          : {}),
        ...(session.callingToolUseId
          ? { callingToolUseId: session.callingToolUseId }
          : {}),
        ...(session.tags ? { tags: session.tags } : {}),
        ...(request.params.includeMissionMetadata && session.mission
          ? { mission: session.mission }
          : {}),
      };
    });

    // Calculate next cursor (mtime of last session in this page)
    const nextCursor =
      hasMore && sessionsPage.length > 0
        ? Math.floor(sessionsPage[sessionsPage.length - 1].mtime / 1000)
        : undefined;

    return {
      sessions,
      hasMore,
      nextCursor,
    };
  }

  private static async handleGetSessionMessages(
    request: DaemonGetSessionMessagesRequest
  ): Promise<DaemonGetSessionMessagesResult> {
    const { sessionId, limit, cursor, role } = request.params;
    const fileContent = DroolRequestHandler.readSessionFile(sessionId);
    if (!fileContent) {
      throw new MetaError('Session file not found', { sessionId });
    }

    const messages: IndustryDroolMessage[] = fileContent
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type !== 'message') return null;
          return convertMessageEventToIndustryDroolMessage(parsed);
          // eslint-disable-next-line industry/require-catch-handling
        } catch {
          return null;
        }
      })
      .filter((message): message is IndustryDroolMessage => message !== null)
      .filter((message) => !role || String(message.role) === String(role))
      .sort((a, b) => b.createdAt - a.createdAt);

    const startIndex = cursor
      ? Math.max(messages.findIndex((message) => message.id === cursor) + 1, 0)
      : 0;
    const paginated = messages.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < messages.length;

    return {
      messages: paginated,
      hasMore,
      nextCursor:
        hasMore && paginated.length > 0
          ? paginated[paginated.length - 1]?.id
          : undefined,
    };
  }

  /**
   * Checks if a session file exists on the filesystem.
   * Searches both global and project-specific session directories.
   * Returns true if the session has been archived (soft-deleted) on disk.
   * Used to gate read paths so cloud-sync consumers don't observe deleted
   * sessions in list/get responses.
   */
  private static isSessionArchived(sessionId: string): boolean {
    const settingsPath = DroolRequestHandler.getSessionSettingsPath(sessionId);
    if (!settingsPath) {
      return false;
    }
    const settings = DroolRequestHandler.readSessionSettings(settingsPath);
    return Boolean(settings?.archivedAt);
  }

  /**
   * Returns true if the session file exists, false otherwise.
   */
  private static sessionFileExists(sessionId: string): boolean {
    const sessionsDir = path.join(
      getIndustryHome(),
      getIndustryDirName(),
      'sessions'
    );

    // Check global session file
    const globalSessionPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    if (fs.existsSync(globalSessionPath)) {
      return true;
    }

    // Check project-specific directories (subdirectories starting with '-')
    if (!fs.existsSync(sessionsDir)) {
      return false;
    }

    try {
      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      const projectDirs = entries.filter(
        (entry) => entry.isDirectory() && entry.name.startsWith('-')
      );

      for (const dir of projectDirs) {
        const projectSessionPath = path.join(
          sessionsDir,
          dir.name,
          `${sessionId}.jsonl`
        );
        if (fs.existsSync(projectSessionPath)) {
          return true;
        }
      }
    } catch (error) {
      logWarn(
        'Failed to check project directories for session (existence check)',
        {
          sessionId,
          cause: error,
        }
      );
    }

    // Check the dedicated btw fork directory
    const btwPath = path.join(sessionsDir, 'btw', `${sessionId}.jsonl`);
    if (fs.existsSync(btwPath)) {
      return true;
    }

    return false;
  }

  /**
   * Returns all session metadata from the in-memory index cache.
   * First call builds the cache from a persisted index file or filesystem scan.
   * Subsequent calls only re-read files whose mtime changed on disk.
   */
  private static async getAllSessionIdsFromFilesystem(): Promise<
    SessionIndexEntry[]
  > {
    const sessionIds = await sessionIndexCache.getAll();
    return sessionIds;
  }

  private async handleUpdateSessionSettings(
    context: IAuthedDaemonConnection,
    request: DaemonUpdateSessionSettingsRequest
  ): Promise<DaemonUpdateSessionSettingsResult> {
    const { params: typedParams } = request;

    await enforceMissionPolicyForDaemon(
      typedParams.interactionMode,
      context.user.userId,
      getMissionSessionRoleFromTags(typedParams.tags),
      typedParams.tags
    );

    logInfo('[Daemon] UpdateSessionSettings received', {
      sessionId: typedParams.sessionId,
      modelId: typedParams.modelId,
      sessionTags: JSON.stringify(typedParams.tags),
      value: JSON.stringify({
        reasoningEffort: typedParams.reasoningEffort,
        autonomyMode: typedParams.autonomyMode,
        interactionMode: typedParams.interactionMode,
        autonomyLevel: typedParams.autonomyLevel,
        specModeModelId: typedParams.specModeModelId,
        specModeReasoningEffort: typedParams.specModeReasoningEffort,
      }),
    });

    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId: typedParams.sessionId,
      });
    }

    // Update session settings
    const { sessionId, ...clientParams } = typedParams;

    logInfo('[Daemon] Sending to CLI client', {
      sessionId,
      modelId: clientParams.modelId,
      value: JSON.stringify(clientParams),
    });

    const response = await client.updateSessionSettings(
      clientParams,
      request.id
    );

    if (response.error) {
      throw new MetaError('Failed to update session settings', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    logInfo('[Daemon] UpdateSessionSettings succeeded', {
      sessionId: typedParams.sessionId,
    });

    if (typedParams.tags !== undefined) {
      this.droolRegistry.setSessionTags(sessionId, typedParams.tags);

      // When btw-fork tags are cleared (promotion), move the session files
      // from sessions/btw/ to the proper project directory so the session
      // persists across restarts and appears in normal listings.
      const hasBtwTag = typedParams.tags.some(
        (t) => t.name === SESSION_TAG_BTW_FORK
      );
      if (!hasBtwTag) {
        DroolRequestHandler.promoteBtwSessionIfNeeded(sessionId);

        // Clear the parent link so the promoted session appears as a
        // top-level entry in the sidebar instead of a subsession.
        const sessionState = this.droolRegistry.getSessionState(sessionId);
        if (sessionState?.callingSessionId) {
          sessionState.callingSessionId = undefined;
        }
      }
    }

    return UpdateSessionSettingsResultSchema.parse(response.result);
  }

  private async handleListFiles(
    request: DaemonListFilesRequest
  ): Promise<DaemonListFilesResult> {
    const { sessionId, showHidden = false } = request.params;

    logInfo('[Daemon] ListFiles received', {
      sessionId,
    });

    // Get session state to access cwd
    const sessionState = this.droolRegistry.getSessionState(sessionId);
    if (!sessionState?.cwd) {
      throw new MetaError('Session  not found or has no working directory', {
        sessionId,
      });
    }

    const cwd = sessionState.cwd;

    logInfo('[Daemon] Listing files', {
      sessionId,
      cwd,
    });

    // Import listFiles utility
    const { listFiles } = await import('../../utils/file-listing.js');

    let files: string[];
    try {
      files = await listFiles(cwd, { showHidden });
    } catch (err) {
      logWarn('[Daemon] ListFiles failed, returning empty list', {
        sessionId,
        cwd,
        error: err instanceof Error ? err.message : String(err),
      });
      return { files: [] };
    }

    logInfo('[Daemon] Files listed', {
      sessionId,
      count: files.length,
    });

    return { files };
  }

  private async handleSearchFiles(
    request: DaemonSearchFilesRequest
  ): Promise<DaemonSearchFilesResult> {
    const {
      sessionId,
      query,
      maxResults = 60,
      showHidden = false,
    } = request.params;

    logInfo('[Daemon] SearchFiles received', {
      sessionId,
      query,
    });

    // Get session state to access cwd
    const sessionState = this.droolRegistry.getSessionState(sessionId);
    if (!sessionState?.cwd) {
      throw new MetaError('Session  not found or has no working directory', {
        sessionId,
      });
    }

    const cwd = sessionState.cwd;

    logInfo('[Daemon] Searching files', {
      sessionId,
      cwd,
      query,
    });

    // Import utilities
    const { listFiles } = await import('../../utils/file-listing.js');
    const { FuseSearch } = await import('@industry/utils/fuzzy');

    // Get fresh file list from ripgrep
    let files: string[];
    try {
      files = await listFiles(cwd, { showHidden });
    } catch (err) {
      logWarn('[Daemon] SearchFiles failed to list files, returning empty', {
        sessionId,
        cwd,
        query,
        error: err instanceof Error ? err.message : String(err),
      });
      return { files: [], totalFiles: 0 };
    }

    const fileSuggestions = getFileSuggestionCandidates(files);

    logInfo('[Daemon] Files loaded for search', {
      sessionId,
      count: files.length,
    });

    // Perform fuzzy search
    const fuseSearch = new FuseSearch(fileSuggestions, {
      maxResults,
      threshold: 0.5,
    });

    const results = query
      ? fuseSearch.search(query).map((r) => r.item)
      : fileSuggestions.slice(0, maxResults);

    logInfo('[Daemon] Search completed', {
      sessionId,
      query,
      count: results.length,
    });

    return {
      files: results,
      totalFiles: fileSuggestions.length,
    };
  }

  private async handleToggleMcpServer(
    request: DaemonToggleMcpServerRequest
  ): Promise<McpSuccessResult> {
    const { params: typedParams } = request;
    logInfo('Drool ToggleMcpServer method called', {
      sessionId: typedParams.sessionId,
      name: typedParams.serverName,
      isEnabled: typedParams.enabled,
      state: typedParams.settingsLevel,
    });

    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId: typedParams.sessionId,
        name: typedParams.serverName,
        isEnabled: typedParams.enabled,
        state: typedParams.settingsLevel,
      });
    }

    // Forward to CLI via drool client
    const response = await client.toggleMcpServer({
      serverName: typedParams.serverName,
      enabled: typedParams.enabled,
      settingsLevel: typedParams.settingsLevel,
    });

    if (response.error) {
      throw new MetaError('Failed to toggle MCP server', {
        sessionId: typedParams.sessionId,
        name: typedParams.serverName,
        isEnabled: typedParams.enabled,
        state: typedParams.settingsLevel,
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    return McpSuccessResultSchema.parse(response.result);
  }

  private async handleAuthenticateMcpServer(
    request: DaemonAuthenticateMcpServerRequest
  ): Promise<McpSuccessResult> {
    logInfo('Drool AuthenticateMcpServer method called');

    const { params: typedParams } = request;
    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId: typedParams.sessionId,
      });
    }

    // Forward to CLI via drool client
    const response = await client.authenticateMcpServer({
      serverName: typedParams.serverName,
    });

    if (response.error) {
      throw new MetaError('Failed to authenticate MCP server', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    return McpSuccessResultSchema.parse(response.result);
  }

  private async handleCancelMcpAuth(
    request: DaemonCancelMcpAuthRequest
  ): Promise<McpSuccessResult> {
    logInfo('Drool CancelMcpAuth method called');

    const { params: typedParams } = request;
    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId: typedParams.sessionId,
      });
    }

    // Forward to CLI via drool client
    const response = await client.cancelMcpAuth({
      serverName: typedParams.serverName,
    });

    if (response.error) {
      throw new MetaError('Failed to cancel MCP auth', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    return McpSuccessResultSchema.parse(response.result);
  }

  private async handleClearMcpAuth(
    request: DaemonClearMcpAuthRequest
  ): Promise<McpSuccessResult> {
    logInfo('Drool ClearMcpAuth method called');

    const { params: typedParams } = request;
    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId: typedParams.sessionId,
      });
    }

    // Forward to CLI via drool client
    const response = await client.clearMcpAuth({
      serverName: typedParams.serverName,
    });

    if (response.error) {
      throw new MetaError('Failed to clear MCP auth', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    return McpSuccessResultSchema.parse(response.result);
  }

  private async handleAddMcpServer(
    request: DaemonAddMcpServerRequest
  ): Promise<McpSuccessResult> {
    logInfo('Drool AddMcpServer method called');

    const { params: typedParams } = request;
    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId: typedParams.sessionId,
      });
    }

    // Forward to CLI via drool client
    const response = await client.addMcpServer({
      name: typedParams.name,
      type: typedParams.type,
      url: typedParams.url,
      headers: typedParams.headers,
      command: typedParams.command,
      args: typedParams.args,
      env: typedParams.env,
    });

    if (response.error) {
      throw new MetaError('Failed to add MCP server', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    return McpSuccessResultSchema.parse(response.result);
  }

  private async handleRemoveMcpServer(
    request: DaemonRemoveMcpServerRequest
  ): Promise<McpSuccessResult> {
    logInfo('Drool RemoveMcpServer method called');

    const { params: typedParams } = request;
    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId: typedParams.sessionId,
      });
    }

    // Forward to CLI via drool client
    const response = await client.removeMcpServer({
      serverName: typedParams.serverName,
      settingsLevel: typedParams.settingsLevel,
    });

    if (response.error) {
      throw new MetaError('Failed to remove MCP server', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    return McpSuccessResultSchema.parse(response.result);
  }

  private async handleListMcpRegistry(
    request: DaemonListMcpRegistryRequest
  ): Promise<DaemonListMcpRegistryResult> {
    logInfo('Drool ListMcpRegistry method called');

    const { params: typedParams } = request;
    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId: typedParams.sessionId,
      });
    }

    // Forward to CLI via drool client
    const response = await client.listMcpRegistry();

    if (response.error) {
      throw new MetaError('Failed to list MCP registry', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    return DaemonListMcpRegistryResultSchema.parse(response.result);
  }

  private async handleListMcpTools(
    request: DaemonListMcpToolsRequest
  ): Promise<DaemonListMcpToolsResult> {
    logInfo('Drool ListMcpTools method called');

    const { params: typedParams } = request;
    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId: typedParams.sessionId,
      });
    }

    // Forward to CLI via drool client
    const response = await client.listMcpTools();

    if (response.error) {
      throw new MetaError('Failed to list MCP tools', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    return DaemonListMcpToolsResultSchema.parse(response.result);
  }

  private async handleListMcpServers(
    request: DaemonListMcpServersRequest
  ): Promise<DaemonListMcpServersResult> {
    logInfo('Drool ListMcpServers method called');

    const { params: typedParams } = request;
    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId: typedParams.sessionId,
      });
    }

    const response = await client.listMcpServers();

    if (response.error) {
      throw new MetaError('Failed to list MCP servers', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    return DaemonListMcpServersResultSchema.parse(response.result);
  }

  private async handleToggleMcpTool(
    request: DaemonToggleMcpToolRequest
  ): Promise<McpSuccessResult> {
    logInfo('Drool ToggleMcpTool method called');

    const { params: typedParams } = request;
    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId: typedParams.sessionId,
      });
    }

    // Forward to CLI via drool client
    const response = await client.toggleMcpTool(
      typedParams.serverName,
      typedParams.toolName,
      typedParams.enabled
    );

    if (response.error) {
      throw new MetaError('Failed to toggle MCP tool', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    return McpSuccessResultSchema.parse(response.result);
  }

  private async handleSubmitMcpAuthCode(
    request: DaemonSubmitMcpAuthCodeRequest
  ): Promise<McpSuccessResult> {
    logInfo('Drool SubmitMcpAuthCode method called');

    const { params: typedParams } = request;
    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId: typedParams.sessionId,
      });
    }

    // Forward to CLI via drool client
    const response = await client.submitMcpAuthCode({
      serverName: typedParams.serverName,
      code: typedParams.code,
      state: typedParams.state,
    });

    if (response.error) {
      throw new MetaError('Failed to submit MCP auth code', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    return McpSuccessResultSchema.parse(response.result);
  }

  private async handleSubmitMcpAuthError(
    request: DaemonSubmitMcpAuthErrorRequest
  ): Promise<McpSuccessResult> {
    logInfo('Drool SubmitMcpAuthError method called');

    const { params: typedParams } = request;
    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId: typedParams.sessionId,
      });
    }

    const response = await client.submitMcpAuthError({
      serverName: typedParams.serverName,
      error: typedParams.error,
      errorDescription: typedParams.errorDescription,
      state: typedParams.state,
    });

    if (response.error) {
      throw new MetaError('Failed to submit MCP auth error', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    return McpSuccessResultSchema.parse(response.result);
  }

  private static async handleSearchSessions(
    request: DaemonSearchSessionsRequest
  ): Promise<DaemonSearchSessionsResult> {
    const { query, kind, limitSessions, limitHitsPerSession, contextChars } =
      request.params;

    logInfo('[Daemon] SearchSessions received', {
      query,
    });

    const { runDroolSearch } = await import('@industry/runtime/session-search');

    const results = await runDroolSearch(query, {
      kind: kind ?? 'all',
      limitSessions,
      limitHitsPerSession,
      contextChars,
    });

    logInfo('[Daemon] SearchSessions completed', {
      query,
      count: results.sessions.length,
    });

    return results;
  }

  /**
   * Validates sessionId to prevent path traversal attacks (CWE-23).
   * Returns true if valid, logs warning and returns false if invalid.
   */
  private static validateSessionId(sessionId: string): boolean {
    if (
      sessionId.includes('/') ||
      sessionId.includes('\\') ||
      sessionId.includes('..') ||
      sessionId.includes('\0')
    ) {
      logWarn('Invalid sessionId - contains path traversal characters', {
        sessionId,
      });
      return false;
    }
    return true;
  }

  /**
   * Validates that resolved path is within sessions directory.
   * Returns true if valid, logs warning and returns false if invalid.
   */
  private static validateSessionPath(
    resolvedPath: string,
    resolvedSessionsDir: string,
    sessionId: string,
    pathType: 'global' | 'project' | 'btw'
  ): boolean {
    if (!resolvedPath.startsWith(resolvedSessionsDir)) {
      logWarn('Path traversal attempt detected', {
        sessionId,
        type: pathType,
      });
      return false;
    }
    return true;
  }

  /**
   * Gets the path to a session's settings file.
   * Returns null if session file doesn't exist or if sessionId is invalid.
   */
  private static getSessionSettingsPath(sessionId: string): string | null {
    if (!this.validateSessionId(sessionId)) {
      return null;
    }

    // Sanitize sessionId to strip directory components (CWE-23 defense in depth)
    const sanitizedSessionId = path.basename(sessionId);

    const sessionsDir = path.join(
      getIndustryHome(),
      getIndustryDirName(),
      'sessions'
    );
    const resolvedSessionsDir = path.resolve(sessionsDir);

    // Check global session first
    const globalSessionPath = path.join(
      sessionsDir,
      `${sanitizedSessionId}.jsonl`
    );
    if (fs.existsSync(globalSessionPath)) {
      const settingsPath = path.join(
        sessionsDir,
        `${sanitizedSessionId}.settings.json`
      );
      if (
        !this.validateSessionPath(
          path.resolve(settingsPath),
          resolvedSessionsDir,
          sanitizedSessionId,
          'global'
        )
      ) {
        return null;
      }
      return settingsPath;
    }

    // Check the dedicated btw fork directory before project directories,
    // mirroring findSessionFilePath. Without this, btw fork settings are
    // never resolved here and tag-based filters (btw-fork exclusion in
    // listOpenedSessions) can't hydrate from disk.
    const btwSessionPath = path.join(
      sessionsDir,
      'btw',
      `${sanitizedSessionId}.jsonl`
    );
    if (fs.existsSync(btwSessionPath)) {
      const settingsPath = path.join(
        sessionsDir,
        'btw',
        `${sanitizedSessionId}.settings.json`
      );
      if (
        !this.validateSessionPath(
          path.resolve(settingsPath),
          resolvedSessionsDir,
          sanitizedSessionId,
          'btw'
        )
      ) {
        return null;
      }
      return settingsPath;
    }

    // Check project-specific directories
    if (!fs.existsSync(sessionsDir)) {
      return null;
    }

    try {
      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      const projectDirs = entries.filter(
        (entry) => entry.isDirectory() && entry.name.startsWith('-')
      );

      for (const dir of projectDirs) {
        const projectSessionPath = path.join(
          sessionsDir,
          dir.name,
          `${sanitizedSessionId}.jsonl`
        );
        if (fs.existsSync(projectSessionPath)) {
          const settingsPath = path.join(
            sessionsDir,
            dir.name,
            `${sanitizedSessionId}.settings.json`
          );
          if (
            !this.validateSessionPath(
              path.resolve(settingsPath),
              resolvedSessionsDir,
              sanitizedSessionId,
              'project'
            )
          ) {
            return null;
          }
          return settingsPath;
        }
      }
    } catch (error) {
      logWarn(
        'Failed to check project directories for session (settings lookup)',
        {
          sessionId: sanitizedSessionId,
          cause: error,
        }
      );
    }

    return null;
  }

  /**
   * Reads session settings from the settings file.
   * Returns null if file doesn't exist or is invalid.
   */
  private static readSessionSettings(
    settingsPath: string
  ): SessionSettings | null {
    try {
      if (fs.existsSync(settingsPath)) {
        const content = fs.readFileSync(settingsPath, 'utf-8');
        return SessionSettingsSchema.parse(JSON.parse(content));
      }
    } catch (error) {
      logWarn('Failed to read session settings', {
        configPath: settingsPath,
        cause: error,
      });
    }
    return null;
  }

  /**
   * Writes session settings to the settings file.
   */
  private static writeSessionSettings(
    settingsPath: string,
    settings: SessionSettings
  ): void {
    // Validate path stays within industry home (defense in depth for CWE-23)
    const sessionsDir = path.join(
      getIndustryHome(),
      getIndustryDirName(),
      'sessions'
    );
    if (!path.resolve(settingsPath).startsWith(path.resolve(sessionsDir))) {
      throw new MetaError(
        'Invalid settings path - outside sessions directory',
        {
          value: { settingsPath },
        }
      );
    }

    // Ensure directory exists
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  }

  /**
   * Archives a session by setting archivedAt in its settings file.
   */
  private async handleArchiveSession(
    request: DaemonArchiveSessionRequest
  ): Promise<DaemonArchiveSessionResult> {
    const { sessionId } = request.params;

    logInfo('[Daemon] ArchiveSession received', { sessionId });

    const settingsPath = DroolRequestHandler.getSessionSettingsPath(sessionId);
    if (!settingsPath) {
      throw new MetaError('Session not found', { sessionId });
    }

    // Read existing settings
    const existingSettings =
      DroolRequestHandler.readSessionSettings(settingsPath) ?? {};

    // Update with archive info
    const archivedAt = new Date().toISOString();
    const updatedSettings: SessionSettings = {
      ...existingSettings,
      archivedAt,
    };

    // Write back
    DroolRequestHandler.writeSessionSettings(settingsPath, updatedSettings);
    void sessionIndexCache.invalidate(sessionId);

    // Mirror the archive flag into the in-memory registry so a follow-up
    // listOpenedSessions can drop the session even if the on-disk settings
    // file isn't read (e.g. fast-path call before the read completes, or
    // an unexpected fs error swallowed by readSessionSettings).
    this.droolRegistry.setSessionArchivedAt(sessionId, archivedAt);

    logInfo('[Daemon] Session archived', { sessionId, timestamp: archivedAt });

    return { success: true, archivedAt };
  }

  /**
   * Unarchives a session by removing archivedAt from its settings file.
   */
  private async handleUnarchiveSession(
    request: DaemonUnarchiveSessionRequest
  ): Promise<DaemonUnarchiveSessionResult> {
    const { sessionId } = request.params;

    logInfo('[Daemon] UnarchiveSession received', { sessionId });

    const settingsPath = DroolRequestHandler.getSessionSettingsPath(sessionId);
    if (!settingsPath) {
      throw new MetaError('Session not found', { sessionId });
    }

    // Read existing settings
    const existingSettings =
      DroolRequestHandler.readSessionSettings(settingsPath) ?? {};

    // Update with unarchive info (remove archivedAt)
    const { archivedAt: _removed, ...settingsWithoutArchivedAt } =
      existingSettings;

    // Write back
    DroolRequestHandler.writeSessionSettings(
      settingsPath,
      settingsWithoutArchivedAt
    );
    void sessionIndexCache.invalidate(sessionId);

    this.droolRegistry.setSessionArchivedAt(sessionId, null);

    logInfo('[Daemon] Session unarchived', { sessionId });

    return { success: true };
  }

  /**
   * Persist a manual session title to the session's .jsonl first line and
   * broadcast a title-updated notification. Returns the sanitized title.
   */
  private applyManualSessionTitle(
    sessionId: string,
    title: string,
    requestId?: string
  ): string {
    const fileContent = DroolRequestHandler.readSessionFile(sessionId);
    if (!fileContent) {
      throw new MetaError('Session file not found', { sessionId });
    }

    const lines = fileContent.split('\n');
    if (lines.length === 0 || !lines[0]!.trim()) {
      throw new MetaError('Invalid session file: missing session summary');
    }

    const sessionSummary: {
      type: string;
      sessionTitle?: string;
      isSessionTitleManuallySet?: boolean;
    } = JSON.parse(lines[0]!);
    if (sessionSummary.type !== 'session_start') {
      throw new MetaError(
        'Invalid session file: first line is not session_start event'
      );
    }

    sessionSummary.sessionTitle = sanitizeSessionTitle(title);
    sessionSummary.isSessionTitleManuallySet = true;

    // Re-read the file immediately before writing so any events appended in
    // the meantime are preserved. This narrows (but does not fully close) the
    // read-modify-write race against `fs.appendFileSync` on the same file.
    const latestContent = DroolRequestHandler.readSessionFile(sessionId);
    const latestLines = latestContent
      ? latestContent.split('\n')
      : lines.slice();
    latestLines[0] = JSON.stringify(sessionSummary);

    const written = DroolRequestHandler.writeSessionFile(
      sessionId,
      latestLines.join('\n')
    );
    if (!written) {
      throw new MetaError('Failed to write session file', { sessionId });
    }
    void sessionIndexCache.invalidate(sessionId);

    try {
      this.broadcastSessionNotification(sessionId, {
        type: SessionNotificationType.SESSION_TITLE_UPDATED,
        ...(requestId !== undefined ? { requestId } : {}),
        title: sessionSummary.sessionTitle,
      });
    } catch (err) {
      logWarn('[Daemon] Failed to broadcast session title notification', {
        sessionId,
        cause: err,
      });
    }

    return sessionSummary.sessionTitle;
  }

  /**
   * Renames a session by updating sessionTitle in its .jsonl first line.
   */
  private async handleRenameSession(
    request: DaemonRenameSessionRequest
  ): Promise<DaemonRenameSessionResult> {
    const { sessionId, title } = request.params;

    logInfo('[Daemon] RenameSession received', { sessionId });

    this.applyManualSessionTitle(sessionId, title, request.id);

    logInfo('[Daemon] Session renamed', { sessionId });

    return { success: true };
  }

  /**
   * Reads the content of a session file.
   * Returns null if session not found or invalid.
   */
  private static readSessionFile(sessionId: string): string | null {
    const sessionPath = findSessionFilePath({
      industryHome: getIndustryHome(),
      industryDirName: getIndustryDirName(),
      sessionId,
    });
    if (!sessionPath) {
      return null;
    }

    try {
      return fs.readFileSync(sessionPath, 'utf-8');
    } catch (err) {
      logWarn('[Daemon] Failed to read session file', { cause: err });
      return null;
    }
  }

  /**
   * Writes content to a session file, preserving modification time.
   */
  private static writeSessionFile(sessionId: string, content: string): boolean {
    const sessionPath = findSessionFilePath({
      industryHome: getIndustryHome(),
      industryDirName: getIndustryDirName(),
      sessionId,
    });
    if (!sessionPath) {
      return false;
    }

    try {
      const originalStats = fs.statSync(sessionPath);
      fs.writeFileSync(sessionPath, content);
      fs.utimesSync(sessionPath, originalStats.atime, originalStats.mtime);
      return true;
    } catch (err) {
      logWarn('[Daemon] Failed to write session file', { cause: err });
      return false;
    }
  }

  /**
   * If a session's JSONL lives in sessions/btw/, move it (and its settings
   * file) to the proper project directory derived from the session's CWD.
   * Also deletes any stale project-dir copy that may have been created by
   * the parent CLI process before the btw-write fix.
   */
  private static promoteBtwSessionIfNeeded(sessionId: string): void {
    const sessionsDir = path.join(
      getIndustryHome(),
      getIndustryDirName(),
      'sessions'
    );
    const btwDir = path.join(sessionsDir, 'btw');
    const btwJsonl = path.join(btwDir, `${sessionId}.jsonl`);

    if (!fs.existsSync(btwJsonl)) {
      return; // Not in btw dir, nothing to move
    }

    try {
      // Read the full file so we can rewrite the session_start line
      const fileContent = fs.readFileSync(btwJsonl, 'utf-8');
      const lines = fileContent.split('\n');
      const firstLine = lines[0]?.trim();
      if (!firstLine) return;
      const sessionStart: Record<string, unknown> = JSON.parse(firstLine);
      if (sessionStart.type !== 'session_start' || !sessionStart.cwd) return;

      // Clear parent links so the promoted session appears as a top-level
      // entry in the sidebar after reload (not grouped as a subsession).
      delete sessionStart.callingSessionId;
      delete sessionStart.parent;
      lines[0] = JSON.stringify(sessionStart);
      fs.writeFileSync(btwJsonl, lines.join('\n'));

      // Derive project directory name: /Users/foo/bar → -Users-foo-bar
      const cwd = String(sessionStart.cwd).replace(/\/+$/, '');
      const dirName = `-${cwd.replace(/^\/+/, '').replace(/\/+/g, '-')}`;
      const projectDir = path.join(sessionsDir, dirName);

      if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
      }

      const destJsonl = path.join(projectDir, `${sessionId}.jsonl`);
      const destSettings = path.join(projectDir, `${sessionId}.settings.json`);

      // Remove stale project-dir copy if it exists
      if (fs.existsSync(destJsonl)) {
        fs.unlinkSync(destJsonl);
      }
      if (fs.existsSync(destSettings)) {
        fs.unlinkSync(destSettings);
      }

      // Move JSONL
      fs.renameSync(btwJsonl, destJsonl);

      // Move settings file if it exists
      const btwSettings = path.join(btwDir, `${sessionId}.settings.json`);
      if (fs.existsSync(btwSettings)) {
        fs.renameSync(btwSettings, destSettings);
      }

      void sessionIndexCache.invalidate(sessionId);

      logInfo('[Daemon] Promoted btw session to project directory', {
        sessionId,
        value: JSON.stringify({ from: btwDir, to: projectDir }),
      });
    } catch (err) {
      logWarn('[Daemon] Failed to promote btw session', {
        sessionId,
        cause: err,
      });
    }
  }

  private async handleListSkills(
    request: DaemonListSkillsRequest
  ): Promise<DaemonListSkillsResult> {
    logInfo('Drool ListSkills method called');

    const { params: typedParams } = request;
    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId: typedParams.sessionId,
      });
    }

    // Forward to CLI via drool client
    const response = await client.listSkills();

    if (response.error) {
      throw new MetaError('Failed to list skills', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    return DaemonListSkillsResultSchema.parse(response.result);
  }

  private async handleListCommands(
    request: DaemonListCommandsRequest
  ): Promise<DaemonListCommandsResult> {
    logInfo('Drool ListCommands method called');

    const { params: typedParams } = request;
    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId: typedParams.sessionId,
      });
    }

    // Forward to CLI via drool client
    const response = await client.listCommands();

    if (response.error) {
      throw new MetaError('Failed to list commands', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    return DaemonListCommandsResultSchema.parse(response.result);
  }

  private async handleListAvailablePlugins(
    _request: DaemonListAvailablePluginsRequest
  ): Promise<DaemonListAvailablePluginsResult> {
    logInfo('Drool ListAvailablePlugins method called');
    const mgr = PluginMarketplaceManager.getInstance();
    const plugins = await mgr.listAvailablePlugins();
    return DaemonListAvailablePluginsResultSchema.parse({ plugins });
  }

  private async handleListInstalledPlugins(
    request: DaemonListInstalledPluginsRequest
  ): Promise<DaemonListInstalledPluginsResult> {
    logInfo('Drool ListInstalledPlugins method called');
    const { params } = request;
    const mgr = PluginMarketplaceManager.getInstance();
    const scope = params.scope ? parseSettingsLevel(params.scope) : undefined;
    const entries = await mgr.listInstalledPluginStatuses(scope);
    const plugins = entries.map(({ id, entry, active, reason }) => ({
      id,
      ...entry,
      active,
      reason,
    }));
    return DaemonListInstalledPluginsResultSchema.parse({ plugins });
  }

  private async handleInstallPlugin(
    request: DaemonInstallPluginRequest
  ): Promise<DaemonInstallPluginResult> {
    logInfo('Drool InstallPlugin method called');
    const { params } = request;
    const mgr = PluginMarketplaceManager.getInstance();
    const result = await mgr.installPlugin(
      params.marketplace,
      params.pluginName,
      parseSettingsLevel(params.scope)
    );
    return DaemonInstallPluginResultSchema.parse(result);
  }

  private async handleUninstallPlugin(
    request: DaemonUninstallPluginRequest
  ): Promise<DaemonUninstallPluginResult> {
    logInfo('Drool UninstallPlugin method called');
    const { params } = request;
    const mgr = PluginMarketplaceManager.getInstance();
    const success = await mgr.uninstallPlugin(
      params.pluginId,
      parseSettingsLevel(params.scope)
    );
    return DaemonUninstallPluginResultSchema.parse({ success });
  }

  private async handleSetPluginEnabled(
    request: DaemonSetPluginEnabledRequest
  ): Promise<DaemonSetPluginEnabledResult> {
    logInfo('Drool SetPluginEnabled method called');
    const { params } = request;
    const mgr = PluginMarketplaceManager.getInstance();
    const result = await mgr.setPluginEnabled(
      params.pluginId,
      parseSettingsLevel(params.scope),
      params.enabled
    );
    return DaemonSetPluginEnabledResultSchema.parse(result);
  }

  private async handleUpdatePlugin(
    request: DaemonUpdatePluginRequest
  ): Promise<DaemonUpdatePluginResult> {
    logInfo('Drool UpdatePlugin method called');
    const { params } = request;
    const mgr = PluginMarketplaceManager.getInstance();
    const raw = await mgr.updatePlugin(
      params.pluginId,
      params.scope ? parseSettingsLevel(params.scope) : undefined
    );
    const results = raw.map((r) => ({
      pluginId: r.pluginId ?? params.pluginId ?? '',
      success: r.success,
      error: r.error,
    }));
    return DaemonUpdatePluginResultSchema.parse({ results });
  }

  private async handleListMarketplaces(
    _request: DaemonListMarketplacesRequest
  ): Promise<DaemonListMarketplacesResult> {
    logInfo('Drool ListMarketplaces method called');
    const mgr = PluginMarketplaceManager.getInstance();
    const items = await mgr.listMarketplaces();
    const marketplaces = items.map((m) => ({
      name: m.name,
      source: redactMarketplaceSource(m.entry.source),
      pluginCount: m.pluginCount,
      autoUpdate: m.entry.autoUpdate ?? false,
    }));
    return DaemonListMarketplacesResultSchema.parse({ marketplaces });
  }

  private async handleAddMarketplace(
    request: DaemonAddMarketplaceRequest
  ): Promise<DaemonAddMarketplaceResult> {
    const { params } = request;
    logInfo('[DroolRequestHandler] AddMarketplace method called', {
      sessionId: params.sessionId,
      sourceType: params.source.source,
    });
    const mgr = PluginMarketplaceManager.getInstance();
    const result = await mgr.addMarketplace(params.source);
    logInfo('[DroolRequestHandler] AddMarketplace completed', {
      sessionId: params.sessionId,
      success: result.success,
      name: result.name,
      errorMessage: result.error,
    });
    return DaemonAddMarketplaceResultSchema.parse(result);
  }

  private async handleRemoveMarketplace(
    request: DaemonRemoveMarketplaceRequest
  ): Promise<DaemonRemoveMarketplaceResult> {
    const { params } = request;
    logInfo('[DroolRequestHandler] RemoveMarketplace method called', {
      sessionId: params.sessionId,
      name: params.name,
    });
    const mgr = PluginMarketplaceManager.getInstance();
    const result = await mgr.removeMarketplace(params.name);
    logInfo('[DroolRequestHandler] RemoveMarketplace completed', {
      sessionId: params.sessionId,
      success: result.success,
      errorMessage: result.error,
    });
    return DaemonRemoveMarketplaceResultSchema.parse(result);
  }

  private async handleUpdateMarketplace(
    request: DaemonUpdateMarketplaceRequest
  ): Promise<DaemonUpdateMarketplaceResult> {
    const { params } = request;
    logInfo('[DroolRequestHandler] UpdateMarketplace method called', {
      sessionId: params.sessionId,
      name: params.name,
    });
    const mgr = PluginMarketplaceManager.getInstance();
    const raw = await mgr.updateMarketplace(params.name);
    const results = raw.map((r) => ({
      name: r.name ?? '',
      success: r.success,
      error: r.error,
    }));
    logInfo('[DroolRequestHandler] UpdateMarketplace completed', {
      sessionId: params.sessionId,
      totalCount: results.length,
    });
    return DaemonUpdateMarketplaceResultSchema.parse({ results });
  }

  private async handleSubmitBugReport(
    request: DaemonSubmitBugReportRequest
  ): Promise<DaemonSubmitBugReportResult> {
    logInfo('Drool SubmitBugReport method called');

    const { params: typedParams } = request;
    const client = this.droolRegistry.getDroolClient(typedParams.sessionId);

    if (!client) {
      throw new MetaError('No active session found for ID', {
        sessionId: typedParams.sessionId,
      });
    }

    // Forward to CLI via drool client
    const response = await client.submitBugReport(
      typedParams.userComment,
      typedParams.clientLogs
    );

    if (response.error) {
      throw new MetaError('Failed to submit bug report', {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }

    return DaemonSubmitBugReportResultSchema.parse(response.result);
  }

  private async handleListAutomations(
    request: DaemonListAutomationsRequest
  ): Promise<DaemonListAutomationsResult> {
    logInfo('Drool ListAutomations method called');

    const [localAutomations, computerAutomations] = await Promise.all([
      this.resolveLocalAutomationList(request),
      DroolRequestHandler.resolveComputerAutomationList(),
    ]);

    // Dedupe local vs computer by uuid / id. A local automation whose
    // HEARTBEAT.md contains `id: <uuid>` is the same logical automation as
    // a computer automation returned with `id === <uuid>` (they were synced).
    // Local wins because it reflects filesystem state (including the latest
    // run metadata persisted via state.json).
    const seen = new Set<string>();
    for (const a of localAutomations) {
      if (a.uuid) seen.add(a.uuid);
      seen.add(a.id);
    }
    const dedupedComputer = computerAutomations.filter((a) => !seen.has(a.id));

    return { automations: [...localAutomations, ...dedupedComputer] };
  }

  private async resolveLocalAutomationList(
    request: DaemonListAutomationsRequest
  ): Promise<DaemonListAutomationsResult['automations']> {
    const { listAutomations } = await import('../../automations/control-plane');
    const basePath = resolveBasePathOrCwd(request.params.basePath);
    // The control-plane backfills lastRunAt from memory/state.json, so the
    // result can be mapped to wire entries directly.
    const result = await listAutomations(basePath);

    const automations: DaemonListAutomationsResult['automations'] =
      await Promise.all(
        (result.automations ?? []).map(async (a) => {
          let prompt: string | undefined;
          try {
            const heartbeatPath = path.join(a.path, AUTOMATION_HEARTBEAT_FILE);
            const raw = await fs.promises.readFile(heartbeatPath, 'utf-8');
            prompt = parseFrontmatter(raw).body.trim();
          } catch (err) {
            logWarn('[Daemon] Failed to read automation prompt', {
              cause: err,
            });
          }
          return {
            id: a.id,
            uuid: a.config.id,
            name: a.config.name,
            description: a.config.description ?? undefined,
            prompt,
            status: a.status,
            schedule: a.config.schedule?.cadence,
            model: a.config.model ?? undefined,
            tags: a.config.tags,
            nextRunAt: a.nextRunAt,
            lastRunAt: a.lastRunAt ?? undefined,
            isValid: true,
            path: a.path,
            templateId: a.config.templateId ?? undefined,
            privacyLevel: a.config.privacyLevel ?? undefined,
            createdBy: a.config.createdBy ?? undefined,
            forkedFrom: a.config.forkedFrom ?? undefined,
            // Stamp the owning machine so the client can classify locality from
            // the source of truth rather than `computerId` presence (which a
            // BYOM-registered local machine also sets on local automations).
            machineId: this.machineId,
          };
        })
      );

    // Include invalid automations if present
    if (result.invalidAutomations) {
      for (const inv of result.invalidAutomations) {
        automations.push({
          id: inv.id,
          name: inv.id,
          status: 'invalid',
          isValid: false,
          path: inv.path,
          machineId: this.machineId,
        });
      }
    }

    return automations;
  }

  private static async resolveComputerAutomationList(): Promise<
    DaemonListAutomationsResult['automations']
  > {
    const { getApiClient } = await import('../../services/ApiClient');
    const apiClient = getApiClient();
    if (!apiClient) return [];

    const response = await apiClient.get<AutomationListResponse>(
      '/api/v0/automations'
    );
    // Firestore persists optional fields as `null` even though our zod schemas
    // declare them as `.optional()` (which only accepts `undefined`). Coerce
    // `null` -> `undefined` so the daemon response survives strict validation
    // on the client side.
    return response.data.automations.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description ?? undefined,
      prompt: a.prompt ?? undefined,
      status: a.status,
      schedule: a.schedule,
      model: a.model ?? undefined,
      tags: a.tags,
      isValid: true,
      path: '',
      computerId: a.computerId ?? undefined,
      templateId: a.templateId ?? undefined,
      privacyLevel: a.privacyLevel ?? undefined,
      createdBy: a.createdBy ?? undefined,
      lastRunAt: a.lastRunAt ?? undefined,
      machineId: a.machineId ?? a.computerId ?? undefined,
    }));
  }

  /**
   * Extract the automation directory name from request params.
   */
  private getAutomationDirName(params: {
    automationId: string;
    automationDirName?: string;
  }): string {
    return sanitizeDirName(params.automationDirName ?? params.automationId);
  }

  private async handleRunAutomation(
    request: DaemonRunAutomationRequest
  ): Promise<DaemonRunAutomationResult> {
    if (request.params.computerId) {
      return this.resolveComputerAutomation(
        request.params.automationId,
        request.params.computerId,
        request.params.basePath
      );
    }
    return this.resolveLocalAutomation(request.params);
  }

  /**
   * Resolve automation metadata from the backend API for computer automations.
   */
  private async resolveComputerAutomation(
    automationId: string,
    computerId: string,
    basePath?: string
  ): Promise<DaemonRunAutomationResult> {
    logInfo('Resolving computer automation from backend', {
      automationId,
      computerId,
    });

    const { getApiClient } = await import('../../services/ApiClient');
    const apiClient = getApiClient();
    if (!apiClient) {
      throw new MetaError('Daemon API client not initialized', {
        automationId,
      });
    }

    const { AutomationSchema, AutomationStatus } = await import(
      '@industry/common/api/v0/automations'
    );
    const response = await apiClient.get<unknown>(
      `/api/v0/automations/${encodeURIComponent(automationId)}`
    );
    const automation = AutomationSchema.parse(response.data);

    if (!automation.prompt) {
      throw new MetaError('Computer automation has no prompt', {
        automationId,
      });
    }

    // When the run is dispatched to the computer that actually hosts the
    // automation, its files live on this machine's filesystem. Resolve the
    // local automation directory so the session runs inside it instead of `/`,
    // which would let the agent's relative scaffold paths leak into the root.
    //
    // Computer automations are always user-level: only home-dir automations are
    // synced to the backend (the sync service scans `homeDir` only, which skips
    // project-level `.industry/automations/` discovery), and every computer
    // automation is sourced from that backend list. User-level automations are
    // discovered regardless of `basePath`, so this resolves a hosted automation
    // even when no project root is supplied. The `/` fallback therefore only
    // fires for a pure proxy daemon that does not have the files on disk at all
    // — a case no project-root search could fix.
    let hosted = await this.discoverAutomationById(automation.id, basePath);
    if (!hosted) {
      // Run-time ensure: the computer's own files are the source of truth, but
      // when they are missing (e.g. the machine was re-provisioned) rebuild the
      // scaffold from the Firestore backup so the run has files to read. This
      // only fires when nothing is on disk, so existing computer files always
      // win and the two sources do not drift.
      try {
        const { createAutomationScaffold } = await import(
          '../../automations/automation-loader'
        );
        // Computer automations are user-level, so mirror the user-automations
        // directory resolution used by create (home dir + configured industry
        // dir) instead of the daemon cwd.
        const usesUserAutomationDirectory = basePath === undefined;
        await createAutomationScaffold({
          id: buildAutomationSlug(automation.name, automation.id),
          uuid: automation.id,
          name: automation.name,
          ...(automation.description
            ? { description: automation.description }
            : {}),
          schedule: automation.schedule,
          ...(automation.model ? { model: automation.model } : {}),
          instructions: automation.prompt,
          basePath: usesUserAutomationDirectory
            ? getIndustryHome()
            : resolveBasePathOrCwd(basePath),
          ...(usesUserAutomationDirectory
            ? { industryDirName: getIndustryDirName() }
            : {}),
        });
        hosted = await this.discoverAutomationById(automation.id, basePath);
        logInfo('[Automation] Rebuilt missing computer automation scaffold', {
          automationId: automation.id,
        });
      } catch (cause) {
        logWarn(
          '[Automation] Failed to rebuild missing computer automation scaffold',
          { automationId: automation.id, cause }
        );
      }
    }
    // Offline UI edit reconcile: when the backend recorded an edit while this
    // computer was offline (fileSyncPending), Firestore holds a config the file
    // never received. This is the one case where the backup wins over the local
    // file — apply it to the file now, then clear the flag so the file resumes
    // being the source of truth for subsequent runs.
    if (hosted && automation.fileSyncPending) {
      try {
        const { reconcileAutomationHeartbeat } = await import(
          '../../automations/automation-loader'
        );
        await reconcileAutomationHeartbeat(hosted.path, {
          name: automation.name,
          description: automation.description,
          schedule: automation.schedule,
          model: automation.model,
          prompt: automation.prompt,
          tags: automation.tags,
          privacyLevel: automation.privacyLevel,
          paused: automation.status === AutomationStatus.Paused,
        });
        await apiClient.post(
          `/api/v0/automations/${encodeURIComponent(
            automation.id
          )}/file-synced`,
          {}
        );
        const reconciled = await this.discoverAutomationById(
          automation.id,
          basePath
        );
        if (reconciled) {
          hosted = reconciled;
        }
        logInfo('[Automation] Reconciled pending offline edit to file', {
          automationId: automation.id,
        });
      } catch (cause) {
        logWarn(
          '[Automation] Failed to reconcile pending offline edit to file',
          { automationId: automation.id, cause }
        );
      }
    }

    // The scaffold always lives at the automation directory. When the
    // automation configures an explicit `workingDirectory`, the run executes
    // there instead, and we prepend the scaffold-location reminder so the
    // agent's relative scaffold paths still resolve under the automation dir.
    if (hosted) {
      // The computer's own HEARTBEAT.md is the source of truth for the prompt,
      // model and name. The Firestore record is only the backup consumed by the
      // run-time ensure above, so reading the file here keeps the run aligned
      // with whatever the agent has evolved locally and prevents drift.
      const runContext = await resolveAutomationRunContext(hosted);
      // A discovered automation should always have a readable HEARTBEAT.md, but
      // if the read fails (race with a delete, permissions) fall back to the
      // Firestore backup prompt rather than failing the whole run.
      let fileBody = '';
      try {
        fileBody = await this.readAutomationPromptBody(hosted.path);
      } catch (cause) {
        logWarn(
          '[Automation] Failed to read hosted HEARTBEAT.md; using backup prompt',
          { automationId: automation.id, cause }
        );
      }
      return {
        prompt: `${runContext.scaffoldReminder}${fileBody || automation.prompt}`,
        automationName: hosted.config.name,
        automationId: hosted.config.id ?? hosted.id,
        ...(hosted.config.templateId
          ? { templateId: hosted.config.templateId }
          : {}),
        cwd: runContext.cwd,
        ...(hosted.config.model ? { model: hosted.config.model } : {}),
        computerId,
        ...(runContext.scaffoldReminder
          ? { scaffoldReminder: runContext.scaffoldReminder }
          : {}),
      };
    }

    // Fallback: the computer's files are unavailable (discovery and the
    // run-time ensure both failed). Use the Firestore backup so the run can
    // still proceed, running in root.
    logWarn(
      '[Automation] Computer automation not found locally; running in root',
      { automationId: automation.id }
    );
    return {
      prompt: automation.prompt,
      automationName: automation.name,
      automationId: automation.id,
      ...(automation.templateId ? { templateId: automation.templateId } : {}),
      cwd: '/',
      ...(automation.model ? { model: automation.model } : {}),
      computerId,
    };
  }

  /**
   * Read the prompt body (everything after the YAML frontmatter) from an
   * automation's HEARTBEAT.md. Shared by the local and computer run-resolution
   * paths so both read the on-disk prompt identically.
   */
  private async readAutomationPromptBody(
    automationPath: string
  ): Promise<string> {
    const fsModule = await import('fs');
    const pathModule = await import('path');
    const heartbeatPath = pathModule.join(
      automationPath,
      AUTOMATION_HEARTBEAT_FILE
    );
    const content = await fsModule.promises.readFile(heartbeatPath, 'utf-8');
    const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
    const match = frontmatterRegex.exec(content);
    return (match ? content.substring(match[0].length) : content).trim();
  }

  /**
   * Best-effort discovery of an automation on the local filesystem by its
   * UUID or directory name. Returns the discovered descriptor when the
   * automation is hosted on this machine, or undefined when it cannot be
   * discovered locally.
   */
  private async discoverAutomationById(
    automationId: string,
    basePath?: string
  ): Promise<ValidAutomationDescriptor | undefined> {
    try {
      const { discoverAllAutomations } = await import(
        '@industry/drool-core/automations'
      );
      const discovery = await discoverAllAutomations(
        resolveBasePathOrCwd(basePath)
      );
      return discovery.automations.find(
        (a): a is ValidAutomationDescriptor =>
          a.isValid &&
          Boolean(a.path) &&
          (a.config.id === automationId || a.id === automationId)
      );
    } catch (error) {
      logWarn('[Automation] Failed to discover automation locally', {
        automationId,
        cause: error,
      });
      return undefined;
    }
  }

  /**
   * Resolve automation metadata from local HEARTBEAT.md filesystem.
   */
  private async resolveLocalAutomation(
    params: DaemonRunAutomationRequest['params']
  ): Promise<DaemonRunAutomationResult> {
    const automationDirName = this.getAutomationDirName(params);
    logInfo('Resolving local automation from filesystem', {
      automationId: automationDirName,
    });

    const { discoverAllAutomations } = await import(
      '@industry/drool-core/automations'
    );
    const basePath = resolveBasePathOrCwd(params.basePath);
    const discovery = await discoverAllAutomations(basePath);

    const automation = discovery.automations.find(
      (a) => a.id === automationDirName || a.config?.id === automationDirName
    );

    if (!automation || !automation.isValid) {
      throw new MetaError('Automation not found or invalid', {
        automationId: automationDirName,
      });
    }
    validateAutomationPath(automation.path, basePath);

    const prompt = await this.readAutomationPromptBody(automation.path);

    if (!prompt) {
      throw new MetaError('Automation HEARTBEAT.md has no prompt content', {
        automationId: automationDirName,
      });
    }
    // Honor a configured workingDirectory (run from the project), prepending
    // the scaffold-location reminder so relative scaffold paths still resolve
    // under the automation directory. Defaults to the scaffold dir otherwise.
    const [runContext] = await Promise.all([
      resolveAutomationRunContext(automation),
      ensureAutomationVisualFile(automation.path, automation.config.name),
    ]);

    const resolvedAutomationId = automation.config.id ?? automation.id;
    const { decision, existingVisual } = await loadAutomationVisualPolicy(
      automation.path
    );
    logInfo('[Automation] Local visual policy decision', {
      automationId: resolvedAutomationId,
      // eslint-disable-next-line industry/no-nested-log-metadata -- policy decision branch + reason + issue ids + callsite consumed as a unit
      value: {
        branch: decision.branch,
        reason: decision.reason,
        issues: decision.issues.map((i) => i.id),
        callsite: 'resolveLocalAutomation',
      },
    });
    const brandReminder = buildAutomationVisualBrandReminder({
      decision,
      automationName: automation.config.name,
      existingVisual,
      forceRegenerate: true,
    });

    return {
      prompt: `${runContext.scaffoldReminder}${brandReminder}\n${prompt}`,
      automationName: automation.config.name,
      automationId: resolvedAutomationId,
      ...(automation.config.templateId
        ? { templateId: automation.config.templateId }
        : {}),
      cwd: runContext.cwd,
      model: automation.config.model,
      ...(runContext.scaffoldReminder
        ? { scaffoldReminder: runContext.scaffoldReminder }
        : {}),
    };
  }

  private async handlePauseAutomation(
    request: DaemonPauseAutomationRequest
  ): Promise<DaemonPauseAutomationResult> {
    const automationDirName = this.getAutomationDirName(request.params);
    logInfo('Drool PauseAutomation method called', {
      automationId: automationDirName,
    });

    const { pauseAutomation } = await import('../../automations/control-plane');
    const basePath = resolveBasePathOrCwd(request.params.basePath);
    const result = await pauseAutomation({ id: automationDirName }, basePath);

    if (!result.success) {
      return {
        success: false,
        automationId: automationDirName,
        status: '',
        error: result.error?.message ?? 'Failed to pause automation',
      };
    }

    return {
      success: true,
      automationId: automationDirName,
      status: result.automation?.status ?? 'paused',
    };
  }

  private async handleResumeAutomation(
    request: DaemonResumeAutomationRequest
  ): Promise<DaemonResumeAutomationResult> {
    const automationDirName = this.getAutomationDirName(request.params);
    logInfo('Drool ResumeAutomation method called', {
      automationId: automationDirName,
    });

    const { resumeAutomation } = await import(
      '../../automations/control-plane'
    );
    const basePath = resolveBasePathOrCwd(request.params.basePath);
    const result = await resumeAutomation({ id: automationDirName }, basePath);

    if (!result.success) {
      return {
        success: false,
        automationId: automationDirName,
        status: '',
        error: result.error?.message ?? 'Failed to resume automation',
      };
    }

    return {
      success: true,
      automationId: automationDirName,
      status: result.automation?.status ?? 'active',
    };
  }

  private async handleGetAutomationHistory(
    request: DaemonGetAutomationHistoryRequest
  ): Promise<DaemonGetAutomationHistoryResult> {
    const automationDirName = this.getAutomationDirName(request.params);
    logInfo('Drool GetAutomationHistory method called', {
      automationId: automationDirName,
    });

    const automationId = automationDirName;
    const limit = request.params.limit ?? 50;
    const offset = request.params.offset ?? 0;

    const basePath = resolveBasePathOrCwd(request.params.basePath);
    const { runs, totalCount } = await getPersistedLocalAutomationHistory({
      automationId,
      basePath,
      limit,
      offset,
    });

    return {
      automationId,
      runs,
      totalCount,
    };
  }

  private async handleGetAutomationVisual(
    request: DaemonGetAutomationVisualRequest
  ): Promise<DaemonGetAutomationVisualResult> {
    const automationDirName = this.getAutomationDirName(request.params);
    logInfo('Drool GetAutomationVisual method called', {
      automationId: automationDirName,
    });

    const { discoverAllAutomations } = await import(
      '@industry/drool-core/automations'
    );
    const basePath = resolveBasePathOrCwd(request.params.basePath);
    const discovery = await discoverAllAutomations(basePath);

    const automation = discovery.automations.find(
      (a) => a.id === automationDirName || a.config?.id === automationDirName
    );

    if (!automation || !automation.isValid) {
      return {
        automationId: automationDirName,
        exists: false,
      };
    }
    validateAutomationPath(automation.path, basePath);

    const fsModule = await import('fs');
    const pathModule = await import('path');

    const sessionId = request.params.sessionId;

    if (sessionId) {
      // Per-run visual: try local visuals/<sessionId>.html first.
      // Validate the sessionId is a UUID and defensively resolve the path
      // so a caller cannot escape the visuals/ directory via traversal
      // sequences (`..`, absolute paths, path separators).
      if (!UUID_PATTERN.test(sessionId)) {
        return {
          automationId: automationDirName,
          exists: false,
        };
      }
      const visualsDir = pathModule.resolve(automation.path, 'visuals');
      const localVisualPath = pathModule.resolve(
        visualsDir,
        `${sessionId}.html`
      );
      if (!localVisualPath.startsWith(`${visualsDir}${pathModule.sep}`)) {
        return {
          automationId: automationDirName,
          exists: false,
        };
      }

      try {
        const content = await fsModule.promises.readFile(
          localVisualPath,
          'utf-8'
        );
        return {
          automationId: automationDirName,
          exists: true,
          content,
        };
      } catch (localReadError) {
        logWarn(
          '[drool-request-handler] Local visual not found, falling back to S3',
          {
            cause: localReadError,
          }
        );
        try {
          const token = await getAuthToken(this.runtimeAuthConfig);
          const activeOrganizationId = await getActiveOrganizationId(
            this.runtimeAuthConfig
          );
          const automationUuid = automation.config?.id;
          if (token && automationUuid) {
            const response = await fetch(
              `${this.apiBaseUrl}/api/automations/${automationUuid}/visual?sessionId=${sessionId}`,
              {
                headers: {
                  Authorization: `Bearer ${token}`,
                  ...(activeOrganizationId && {
                    [ACTIVE_ORGANIZATION_HEADER]: activeOrganizationId,
                  }),
                },
              }
            );
            if (response.ok) {
              const data: { url: string | null } = await response.json();
              if (data.url) {
                return {
                  automationId: automationDirName,
                  exists: true,
                  s3Url: data.url,
                };
              }
            }
          }
        } catch (s3Error) {
          logWarn('[drool-request-handler] S3 visual fallback failed', {
            cause: s3Error,
          });
        }
        return {
          automationId: automationDirName,
          exists: false,
        };
      }
    }

    const visualPath = pathModule.join(automation.path, AUTOMATION_VISUAL_FILE);

    try {
      const content = await fsModule.promises.readFile(visualPath, 'utf-8');
      const stats = await fsModule.promises.stat(visualPath);
      const isStale = Date.now() - stats.mtimeMs > 24 * 60 * 60 * 1000; // > 24h old

      return {
        automationId: automationDirName,
        exists: true,
        content,
        isStale,
      };
    } catch (err) {
      logWarn('[Daemon] Failed to read automation heartbeat', { cause: err });
      return {
        automationId: automationDirName,
        exists: false,
      };
    }
  }

  private async handleCreateAutomation(
    request: DaemonCreateAutomationRequest
  ): Promise<DaemonCreateAutomationResult> {
    logInfo('Drool CreateAutomation method called', {
      automationId: request.params.id,
    });

    const { createAutomation } = await import(
      '../../automations/control-plane'
    );
    // No basePath means a user-level automation: create it in the
    // environment-aware user automations directory (the same location user
    // discovery and the in-process TUI runtime use), not the daemon's cwd.
    const usesUserAutomationDirectory = request.params.basePath === undefined;
    const basePath = usesUserAutomationDirectory
      ? getIndustryHome()
      : resolveBasePathOrCwd(request.params.basePath);
    const result = await createAutomation(
      {
        id: request.params.id,
        uuid: request.params.uuid,
        name: request.params.name,
        description: request.params.description,
        instructions: request.params.instructions,
        schedule: request.params.schedule,
        model: request.params.model,
        visualDescription: request.params.visualDescription,
        memoryStrategy: request.params.memoryStrategy,
        skipFirstRun: request.params.skipFirstRun,
      },
      basePath,
      usesUserAutomationDirectory ? getIndustryDirName() : undefined
    );

    if (!result.success) {
      return {
        success: false,
        error: result.error?.message ?? 'Failed to create automation',
      };
    }

    return {
      success: true,
      automationId: request.params.id,
    };
  }

  private async handleUpdateAutomationModel(
    request: DaemonUpdateAutomationModelRequest
  ): Promise<DaemonUpdateAutomationModelResult> {
    const automationDirName = this.getAutomationDirName(request.params);
    logInfo('Drool UpdateAutomationModel method called', {
      automationId: automationDirName,
      modelId: request.params.model ?? undefined,
    });
    try {
      const { discoverAllAutomations } = await import(
        '@industry/drool-core/automations'
      );
      const { mutateAutomationHeartbeat } = await import(
        '../../automations/automation-loader'
      );
      const basePath = resolveBasePathOrCwd(request.params.basePath);
      const discovery = await discoverAllAutomations(basePath);
      const automation = discovery.automations.find(
        (a) => a.id === automationDirName || a.config?.id === automationDirName
      );
      if (!automation) {
        return { success: false, error: 'Automation not found' };
      }
      validateAutomationPath(automation.path, basePath);
      await mutateAutomationHeartbeat(automation.path, {
        mutateFrontmatter: (frontmatter) => {
          frontmatter.model =
            request.params.model === null ? undefined : request.params.model;
        },
      });
      return { success: true };
    } catch (error) {
      logWarn('[Daemon] Failed to update automation model', { cause: error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async handleUpdateAutomationPrivacy(
    request: DaemonUpdateAutomationPrivacyRequest
  ): Promise<DaemonUpdateAutomationPrivacyResult> {
    const automationDirName = this.getAutomationDirName(request.params);
    logInfo('Drool UpdateAutomationPrivacy method called', {
      automationId: automationDirName,
    });
    try {
      const { discoverAllAutomations } = await import(
        '@industry/drool-core/automations'
      );
      const { mutateAutomationHeartbeat } = await import(
        '../../automations/automation-loader'
      );
      const basePath = resolveBasePathOrCwd(request.params.basePath);
      const discovery = await discoverAllAutomations(basePath);
      const automation = discovery.automations.find(
        (a) => a.id === automationDirName || a.config?.id === automationDirName
      );
      if (!automation) {
        return { success: false, error: 'Automation not found' };
      }
      validateAutomationPath(automation.path, basePath);
      await mutateAutomationHeartbeat(automation.path, {
        mutateFrontmatter: (frontmatter) => {
          if (request.params.privacyLevel === 'private') {
            frontmatter.privacyLevel = undefined;
            frontmatter.createdBy = undefined;
          } else {
            frontmatter.privacyLevel = request.params.privacyLevel;
            frontmatter.createdBy = request.params.createdBy;
          }
        },
      });
      return { success: true };
    } catch (error) {
      logWarn('[Daemon] Failed to update automation privacy', { cause: error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async handleUpdateAutomationPrompt(
    request: DaemonUpdateAutomationPromptRequest
  ): Promise<DaemonUpdateAutomationPromptResult> {
    const automationDirName = this.getAutomationDirName(request.params);
    logInfo('Drool UpdateAutomationPrompt method called', {
      automationId: automationDirName,
    });
    const prompt = request.params.prompt.trim();
    if (!prompt) {
      return { success: false, error: 'Prompt cannot be empty' };
    }

    try {
      const { discoverAllAutomations } = await import(
        '@industry/drool-core/automations'
      );
      const { mutateAutomationHeartbeat } = await import(
        '../../automations/automation-loader'
      );
      const basePath = resolveBasePathOrCwd(request.params.basePath);
      const discovery = await discoverAllAutomations(basePath);
      const automation = discovery.automations.find(
        (a) => a.id === automationDirName || a.config?.id === automationDirName
      );
      if (!automation) {
        return { success: false, error: 'Automation not found' };
      }
      validateAutomationPath(automation.path, basePath);
      await mutateAutomationHeartbeat(automation.path, {
        body: prompt,
        rejectSymlink: true,
      });
      this.automationSyncService.syncAutomation({
        automationId: automation.id,
        automationPath: automation.path,
        ...(automation.config?.id
          ? { automationUuid: automation.config.id }
          : {}),
        outcome: { kind: 'none' },
        syncRequiresCompleteStructure: true,
      });
      return { success: true };
    } catch (error) {
      logWarn('[Daemon] Failed to update automation prompt', { cause: error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async handleUpdateAutomationSchedule(
    request: DaemonUpdateAutomationScheduleRequest
  ): Promise<DaemonUpdateAutomationScheduleResult> {
    const automationDirName = this.getAutomationDirName(request.params);
    logInfo('Drool UpdateAutomationSchedule method called', {
      automationId: automationDirName,
    });

    const { normalizeAutomationScheduleInput } = await import(
      '@industry/common/api/v0/automations'
    );
    const normalizedSchedule = normalizeAutomationScheduleInput(
      request.params.schedule
    );
    if (!normalizedSchedule) {
      return {
        success: false,
        error:
          'Invalid schedule. Enter a schedule like "every Monday at 9am PST" or a 5-part cron expression.',
      };
    }

    try {
      const { discoverAllAutomations } = await import(
        '@industry/drool-core/automations'
      );
      const { mutateAutomationHeartbeat } = await import(
        '../../automations/automation-loader'
      );
      const basePath = resolveBasePathOrCwd(request.params.basePath);
      const discovery = await discoverAllAutomations(basePath);
      const automation = discovery.automations.find(
        (a) =>
          a.config?.id === request.params.automationId ||
          a.id === request.params.automationId ||
          a.id === automationDirName
      );
      if (!automation) {
        return { success: false, error: 'Automation not found' };
      }
      validateAutomationPath(automation.path, basePath);
      await mutateAutomationHeartbeat(automation.path, {
        rejectSymlink: true,
        mutateFrontmatter: (frontmatter) => {
          frontmatter.schedule = normalizedSchedule;
        },
      });
      this.automationSyncService.syncAutomation({
        automationId: automation.id,
        automationPath: automation.path,
        ...(automation.config?.id
          ? { automationUuid: automation.config.id }
          : {}),
        outcome: { kind: 'none' },
        syncRequiresCompleteStructure: true,
      });
      return { success: true };
    } catch (error) {
      logWarn('[Daemon] Failed to update automation schedule', {
        cause: error,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async handleRenameAutomation(
    request: DaemonRenameAutomationRequest
  ): Promise<DaemonRenameAutomationResult> {
    const automationDirName = this.getAutomationDirName(request.params);
    logInfo('Drool RenameAutomation method called', {
      automationId: automationDirName,
    });
    try {
      const { discoverAllAutomations } = await import(
        '@industry/drool-core/automations'
      );
      const { mutateAutomationHeartbeat } = await import(
        '../../automations/automation-loader'
      );
      const basePath = resolveBasePathOrCwd(request.params.basePath);
      const discovery = await discoverAllAutomations(basePath);
      const automation = discovery.automations.find(
        (a) => a.id === automationDirName || a.config?.id === automationDirName
      );
      if (!automation) {
        return { success: false, error: 'Automation not found' };
      }
      validateAutomationPath(automation.path, basePath);
      await mutateAutomationHeartbeat(automation.path, {
        mutateFrontmatter: (frontmatter) => {
          frontmatter.name = request.params.newName;
        },
      });
      this.automationSyncService.syncAutomation({
        automationId: automation.id,
        automationPath: automation.path,
        ...(automation.config?.id
          ? { automationUuid: automation.config.id }
          : {}),
        outcome: { kind: 'none' },
        syncRequiresCompleteStructure: true,
      });
      return { success: true };
    } catch (error) {
      logWarn('[Daemon] Failed to rename automation', { cause: error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async handleDeleteAutomation(
    request: DaemonDeleteAutomationRequest
  ): Promise<DaemonDeleteAutomationResult> {
    const automationDirName = this.getAutomationDirName(request.params);
    logInfo('Drool DeleteAutomation method called', {
      automationId: automationDirName,
    });
    try {
      const { discoverAllAutomations } = await import(
        '@industry/drool-core/automations'
      );
      const fsModule = await import('fs');
      const basePath = resolveBasePathOrCwd(request.params.basePath);
      const discovery = await discoverAllAutomations(basePath);
      const automation = discovery.automations.find(
        (a) => a.id === automationDirName || a.config?.id === automationDirName
      );
      if (!automation) {
        return { success: false, error: 'Automation not found' };
      }
      validateAutomationPath(automation.path, basePath);
      await fsModule.promises.rm(automation.path, {
        recursive: true,
        force: true,
      });
      return { success: true };
    } catch (error) {
      logWarn('[Daemon] Failed to delete automation', { cause: error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async handleForkAutomation(
    request: DaemonForkAutomationRequest
  ): Promise<DaemonForkAutomationResult> {
    logInfo('Drool ForkAutomation method called', {
      automationId: request.params.automationId,
    });
    try {
      const fsModule = await import('fs');
      const pathModule = await import('path');
      const yaml = await import('js-yaml');
      const basePath = process.cwd();
      const safeDirName = sanitizeDirName(request.params.localDirName);
      const automationsDir = pathModule.default.join(
        basePath,
        '.industry',
        'automations',
        safeDirName
      );
      validateAutomationPath(automationsDir, basePath);
      await fsModule.promises.mkdir(automationsDir, { recursive: true });
      const heartbeatMetadata: Record<string, unknown> = {
        id: request.params.automationId,
        name: request.params.name,
        schedule: request.params.schedule,
        forkedFrom: request.params.forkedFrom,
      };
      if (request.params.description) {
        heartbeatMetadata.description = request.params.description;
      }
      if (request.params.tags) {
        heartbeatMetadata.tags = request.params.tags;
      }
      if (request.params.model) {
        heartbeatMetadata.model = request.params.model;
      }
      const frontmatter = yaml
        .dump(heartbeatMetadata, { lineWidth: -1 })
        .trimEnd();
      const heartbeatContent = `---\n${frontmatter}\n---\n\n${request.params.prompt}\n`;
      await fsModule.promises.writeFile(
        pathModule.default.join(automationsDir, 'HEARTBEAT.md'),
        heartbeatContent,
        'utf-8'
      );
      return {
        success: true,
        automationId: request.params.localDirName,
      };
    } catch (error) {
      logWarn('[Daemon] Failed to fork automation', { cause: error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Push a backend (Firestore) automation edit onto this machine's on-disk
   * HEARTBEAT.md. The backend calls this synchronously after an online UI edit
   * so the file (the per-run source of truth) reflects the edit immediately and
   * does not drift from Firestore. When the automation is not hosted here the
   * backend keeps the fileSyncPending flag so the next run reconciles instead.
   */
  private async handleApplyAutomationConfig(
    request: DaemonApplyAutomationConfigRequest
  ): Promise<DaemonApplyAutomationConfigResult> {
    try {
      const hosted = await this.discoverAutomationById(
        request.params.automationId,
        request.params.basePath
      );
      if (!hosted) {
        return {
          success: false,
          error: 'Automation not found on this machine',
        };
      }
      const { reconcileAutomationHeartbeat } = await import(
        '../../automations/automation-loader'
      );
      await reconcileAutomationHeartbeat(hosted.path, {
        name: request.params.name,
        description: request.params.description,
        schedule: request.params.schedule,
        model: request.params.model,
        prompt: request.params.prompt,
        tags: request.params.tags,
        privacyLevel: request.params.privacyLevel,
        paused: request.params.paused,
      });
      return { success: true };
    } catch (error) {
      logWarn('[Daemon] Failed to apply automation config', { cause: error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private handleListCrons(
    request: DaemonListCronsRequest
  ): DaemonListCronsResult {
    return {
      crons: this.cronRegistry.listCrons(request.params),
    };
  }

  private async handleCreateCron(
    request: DaemonCreateCronRequest
  ): Promise<DaemonCreateCronResult> {
    if (
      request.params.kind === 'root_prompt' &&
      !this.supportsRootPromptCrons
    ) {
      throw new MetaError('Root prompt crons are not supported', {
        reason: 'unsupported_root_prompt_cron_runtime',
      });
    }

    const created = this.cronRegistry.createCron(request.params);
    this.cronRuntime.sync();
    const cron = this.cronRegistry.getCron(created.id) ?? created;
    if (request.params.runImmediately) {
      void this.cronRuntime.fireNow(created.id).catch((error) => {
        logException(
          error,
          '[DroolRequestHandler] Failed to fire cron immediately',
          { externalId: created.id }
        );
      });
    }
    return { cron };
  }

  private handleUpdateCron(
    request: DaemonUpdateCronRequest
  ): DaemonUpdateCronResult {
    const { cronId, status, schedule, payload } = request.params;
    const existing = this.cronRegistry.getCron(cronId);
    const payloadPatch =
      payload && existing
        ? {
            payload: {
              ...existing.payload,
              ...(payload.prompt ? { prompt: payload.prompt } : {}),
            },
          }
        : {};
    const cron = this.cronRegistry.updateCron(cronId, {
      ...(status ? { status } : {}),
      ...(schedule
        ? { schedule: { ...schedule, timezone: 'UTC' as const } }
        : {}),
      ...payloadPatch,
    });
    this.cronRuntime.sync();
    return {
      cron: cron ? (this.cronRegistry.getCron(cron.id) ?? cron) : null,
    };
  }

  private handleDeleteCron(
    request: DaemonDeleteCronRequest
  ): DaemonDeleteCronResult {
    const deleted = this.cronRegistry.deleteCron(
      request.params.cronId,
      request.params.sessionId
    );
    this.cronRuntime.sync();
    return { deleted };
  }

  private handleHoldSessionCrons(
    request: DaemonHoldSessionCronsRequest
  ): DaemonHoldSessionCronsResult {
    const heldCount = this.cronRegistry.holdSessionCrons(
      request.params.sessionId,
      request.params.reason
    );
    this.cronRuntime.sync();
    return { heldCount };
  }

  private handleResumeSessionCrons(
    request: DaemonResumeSessionCronsRequest
  ): DaemonResumeSessionCronsResult {
    const resumedCount = this.cronRegistry.resumeSessionCrons(
      request.params.sessionId
    );
    this.cronRuntime.sync();
    return { resumedCount };
  }

  /**
   * Maximum diff output size (2MB) to prevent memory issues with large diffs.
   */
  private static readonly MAX_DIFF_SIZE = 2 * 1024 * 1024;

  /**
   * Runs a git command in the given directory and returns the output.
   * Returns null if the command fails.
   */
  private static async runGitCommand(
    args: string[],
    cwd: string,
    maxOutputSize?: number
  ): Promise<string | null> {
    try {
      const proc = Bun.spawn(['git', ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const chunks: Buffer[] = [];
      let totalSize = 0;
      const reader = proc.stdout.getReader();

      // Read stdout with size limit

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (maxOutputSize && totalSize + value.length > maxOutputSize) {
          const remaining = maxOutputSize - totalSize;
          if (remaining > 0) {
            chunks.push(Buffer.from(value.slice(0, remaining)));
          }
          totalSize = maxOutputSize;
          proc.kill();
          break;
        }

        chunks.push(Buffer.from(value));
        totalSize += value.length;
      }

      await proc.exited;

      if (proc.exitCode !== 0 && totalSize < (maxOutputSize ?? Infinity)) {
        return null;
      }

      return Buffer.concat(chunks).toString('utf-8').trim();
    } catch (err) {
      logWarn('[Daemon] Failed to run process for output', { cause: err });
      return null;
    }
  }

  private static async readStreamWithLimit(
    stream: ReadableStream<Uint8Array>,
    maxOutputSize?: number,
    onLimitExceeded?: () => void
  ): Promise<string> {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    const reader = stream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (
          maxOutputSize !== undefined &&
          totalSize + value.length > maxOutputSize
        ) {
          const remaining = Math.max(0, maxOutputSize - totalSize);
          if (remaining > 0) {
            chunks.push(Buffer.from(value.slice(0, remaining)));
          }
          onLimitExceeded?.();
          break;
        }

        chunks.push(Buffer.from(value));
        totalSize += value.length;
      }
    } finally {
      reader.releaseLock();
    }

    return Buffer.concat(chunks).toString('utf-8');
  }

  /**
   * Runs a git command and returns stdout, stderr, and exitCode.
   * Unlike runGitCommand, this preserves stderr for error reporting.
   */
  private static async runGitCommandWithStderr(
    args: string[],
    cwd: string,
    maxStdoutSize?: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const proc = Bun.spawn(['git', ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [stdout, stderr] = await Promise.all([
        DroolRequestHandler.readStreamWithLimit(
          proc.stdout,
          maxStdoutSize,
          () => proc.kill()
        ),
        new Response(proc.stderr).text(),
      ]);

      await proc.exited;

      return {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: proc.exitCode ?? 1,
      };
    } catch (err) {
      logWarn('[Daemon] Failed to run process with stderr', { cause: err });
      return {
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 1,
      };
    }
  }

  /**
   * Determines the base branch for diff comparison using local refs only.
   * Falls back through: origin/dev -> origin/main -> origin/master -> dev -> main -> master -> HEAD~10
   */
  private static async determineBaseBranch(
    cwd: string
  ): Promise<string | null> {
    const gitDir = await DroolRequestHandler.runGitCommand(
      ['rev-parse', '--git-dir'],
      cwd
    );
    if (!gitDir) {
      return null;
    }

    const baseBranches = ['dev', 'main', 'master'];

    // Prefer remote tracking branches (more up-to-date than local)
    for (const branch of baseBranches) {
      const remoteResult = await DroolRequestHandler.runGitCommand(
        ['rev-parse', '--verify', `refs/remotes/origin/${branch}`],
        cwd
      );
      if (remoteResult) {
        return `origin/${branch}`;
      }
    }

    // Fall back to local branches
    for (const branch of baseBranches) {
      const result = await DroolRequestHandler.runGitCommand(
        ['rev-parse', '--verify', `refs/heads/${branch}`],
        cwd
      );
      if (result) {
        return branch;
      }
    }

    return 'HEAD~10';
  }

  private static createUnavailableGitDiffResult(
    unavailableReason: DaemonGetGitDiffUnavailableReason,
    unavailableMessage: string
  ): DaemonGetGitDiffResult {
    return {
      success: false,
      unavailableReason,
      unavailableMessage,
    };
  }

  private static recordGitDiffUnavailable(
    sessionId: string,
    reason: DaemonGetGitDiffUnavailableReason,
    startTime: number
  ): void {
    Metrics.addToCounter(Metric.DIFF_VIEWER_GET_GIT_DIFF_UNAVAILABLE_COUNT, 1, {
      sessionId,
      reason,
    });
    Metrics.recordHistogram(
      Metric.DIFF_VIEWER_GET_GIT_DIFF_LATENCY,
      Date.now() - startTime,
      {
        sessionId,
        reason,
        fileCount: 0,
      }
    );
  }

  private async handleInspectMissionReadiness(
    request: DaemonInspectMissionReadinessRequest
  ): Promise<DaemonInspectMissionReadinessResult> {
    const { cwd } = request.params;

    const validation = await validateWorkingDirectory(cwd);
    if (!validation.isValid) {
      return {
        isGitRepo: false,
        hasRemote: false,
        remoteUrl: null,
        isEmpty: true,
      };
    }

    const dir = validation.resolvedPath ?? cwd;

    const inspection = await inspectMissionRepo(dir, {
      runGitCommand: (args, gitCwd) =>
        DroolRequestHandler.runGitCommand(args, gitCwd),
      readDirectory: (readCwd) => fs.promises.readdir(readCwd),
    });

    return {
      isGitRepo: inspection.isGitRepo,
      hasRemote: inspection.hasRemote,
      remoteUrl: inspection.repoUrl ?? null,
      isEmpty: inspection.isEmpty,
    };
  }

  private async handleGetGitDiff(
    request: DaemonGetGitDiffRequest
  ): Promise<DaemonGetGitDiffResult> {
    const { sessionId, baseBranch: requestedBaseBranch } = request.params;
    const statsOnly = Boolean(request.params.statsOnly);
    const startTime = Date.now();
    Metrics.addToCounter(Metric.DIFF_VIEWER_GET_GIT_DIFF_COUNT, 1, {
      sessionId,
    });

    logInfo('[Daemon] GetGitDiff received', { sessionId });

    const sessionState = this.droolRegistry.getSessionState(sessionId);
    if (!sessionState?.cwd) {
      const reason = DaemonGetGitDiffUnavailableReason.MissingSessionCwd;
      DroolRequestHandler.recordGitDiffUnavailable(
        sessionId,
        reason,
        startTime
      );
      return DroolRequestHandler.createUnavailableGitDiffResult(
        reason,
        'Session is not ready or does not have a working directory.'
      );
    }

    const sessionCwd = sessionState.cwd;

    logInfo('[Daemon] GetGitDiff executing', { sessionId });

    const gitVersion = await DroolRequestHandler.runGitCommand(
      ['--version'],
      sessionCwd
    );
    if (!gitVersion) {
      const reason = DaemonGetGitDiffUnavailableReason.GitNotAvailable;
      DroolRequestHandler.recordGitDiffUnavailable(
        sessionId,
        reason,
        startTime
      );
      return DroolRequestHandler.createUnavailableGitDiffResult(
        reason,
        'Git is not available in this session environment.'
      );
    }

    const gitDir = await DroolRequestHandler.runGitCommand(
      ['rev-parse', '--git-dir'],
      sessionCwd
    );
    if (!gitDir) {
      const reason = DaemonGetGitDiffUnavailableReason.NotGitRepository;
      DroolRequestHandler.recordGitDiffUnavailable(
        sessionId,
        reason,
        startTime
      );
      return DroolRequestHandler.createUnavailableGitDiffResult(
        reason,
        'This session working directory is not a Git repository.'
      );
    }

    const branchRaw = await DroolRequestHandler.runGitCommand(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      sessionCwd
    );

    let branch: string;
    if (branchRaw && branchRaw !== 'HEAD') {
      branch = branchRaw;
    } else {
      const sha = await DroolRequestHandler.runGitCommand(
        ['rev-parse', '--short', 'HEAD'],
        sessionCwd
      );
      branch = sha || 'HEAD';
    }

    const remoteUrl = await DroolRequestHandler.runGitCommand(
      ['remote', 'get-url', 'origin'],
      sessionCwd
    );

    let baseBranch: string | null;
    if (requestedBaseBranch) {
      const requestedBase = validateGitRef(
        requestedBaseBranch.replace(/^origin\//, ''),
        'baseBranch'
      );

      const originRef = `origin/${requestedBase}`;
      const verified = await DroolRequestHandler.runGitCommand(
        ['rev-parse', '--verify', `refs/remotes/${originRef}`],
        sessionCwd
      );

      if (verified) {
        baseBranch = originRef;
      } else {
        const localVerified = await DroolRequestHandler.runGitCommand(
          ['rev-parse', '--verify', `refs/heads/${requestedBase}`],
          sessionCwd
        );
        baseBranch = localVerified
          ? requestedBase
          : await DroolRequestHandler.determineBaseBranch(sessionCwd);
      }
    } else {
      baseBranch = await DroolRequestHandler.determineBaseBranch(sessionCwd);
    }

    if (!baseBranch) {
      const reason = DaemonGetGitDiffUnavailableReason.NotGitRepository;
      DroolRequestHandler.recordGitDiffUnavailable(
        sessionId,
        reason,
        startTime
      );
      return DroolRequestHandler.createUnavailableGitDiffResult(
        reason,
        'This session working directory is not a Git repository.'
      );
    }

    logInfo('[Daemon] GetGitDiff using base branch', {
      sessionId,
      baseBranch,
      branch,
    });

    const {
      committedDiff,
      committedFiles,
      committedTotalAdditions,
      committedTotalDeletions,
      commits,
      diff,
      files,
      totalAdditions,
      totalDeletions,
      unstagedDiff,
      unstagedFiles,
      unstagedTotalAdditions,
      unstagedTotalDeletions,
    } = await buildGitDiffData({
      baseBranch,
      cwd: sessionCwd,
      maxDiffSize: DroolRequestHandler.MAX_DIFF_SIZE,
      runGitCommand: DroolRequestHandler.runGitCommand,
      runGitCommandWithStderr: DroolRequestHandler.runGitCommandWithStderr,
      statsOnly,
    });

    logInfo('[Daemon] GetGitDiff completed', {
      sessionId,
      branch,
      baseBranch,
      fileCount: files.length,
      // eslint-disable-next-line industry/no-nested-log-metadata -- git diff-stat snapshot consumed as a unit by the diff-viewer dashboard
      value: {
        additions: totalAdditions,
        deletions: totalDeletions,
        commits: commits.length,
        committedFileCount: committedFiles.length,
        committedDiffSize: committedDiff.length,
        diffSize: diff.length,
        unstagedFileCount: unstagedFiles.length,
        unstagedDiffSize: unstagedDiff.length,
      },
    });

    const latency = Date.now() - startTime;
    Metrics.addToCounter(Metric.DIFF_VIEWER_GET_GIT_DIFF_SUCCESS_COUNT, 1, {
      sessionId,
      fileCount: files.length,
      diffSize: diff.length,
    });
    Metrics.recordHistogram(Metric.DIFF_VIEWER_GET_GIT_DIFF_LATENCY, latency, {
      sessionId,
      fileCount: files.length,
    });

    return {
      success: true,
      data: {
        diff,
        branch,
        baseBranch,
        files,
        totalAdditions,
        totalDeletions,
        remoteUrl,
        commits,
        committedDiff,
        committedFiles,
        committedTotalAdditions,
        committedTotalDeletions,
        unstagedDiff,
        unstagedFiles,
        unstagedTotalAdditions,
        unstagedTotalDeletions,
      },
    };
  }

  private async handleGitPush(
    request: DaemonGitPushRequest
  ): Promise<DaemonGitPushResult> {
    const { sessionId } = request.params;
    logInfo('[Daemon] GitPush received', { sessionId });

    const sessionState = this.droolRegistry.getSessionState(sessionId);
    if (!sessionState?.cwd) {
      throw new MetaError('Session not found or has no working directory', {
        sessionId,
      });
    }

    const sessionCwd = sessionState.cwd;

    const branch = await DroolRequestHandler.runGitCommand(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      sessionCwd
    );
    if (!branch) {
      throw new MetaError('Failed to get current branch name', { sessionId });
    }

    const { exitCode, stderr } =
      await DroolRequestHandler.runGitCommandWithStderr(
        ['push', '-u', 'origin', branch],
        sessionCwd
      );

    if (exitCode !== 0) {
      throw new MetaError('Failed to push branch to remote', {
        sessionId,
        value: { branch, exitCode, stderr },
      });
    }

    logInfo('[Daemon] GitPush completed', {
      sessionId,
      branch,
    });

    return { success: true };
  }

  private async handleGitCommit(
    request: DaemonGitCommitRequest
  ): Promise<DaemonGitCommitResult> {
    const { sessionId, message } = request.params;
    logInfo('[Daemon] GitCommit received', { sessionId });

    const sessionState = this.droolRegistry.getSessionState(sessionId);
    if (!sessionState?.cwd) {
      throw new MetaError('Session not found or has no working directory', {
        sessionId,
      });
    }

    const sessionCwd = sessionState.cwd;

    // Stage all changes
    const { exitCode: addExitCode, stderr: addStderr } =
      await DroolRequestHandler.runGitCommandWithStderr(
        ['add', '-A'],
        sessionCwd
      );

    if (addExitCode !== 0) {
      throw new MetaError('Failed to stage changes', {
        sessionId,
        value: { exitCode: addExitCode, stderr: addStderr },
      });
    }

    // Commit with the provided message
    const { exitCode: commitExitCode, stderr: commitStderr } =
      await DroolRequestHandler.runGitCommandWithStderr(
        ['commit', '-m', message],
        sessionCwd
      );

    if (commitExitCode !== 0) {
      throw new MetaError('Failed to commit changes', {
        sessionId,
        value: { exitCode: commitExitCode, stderr: commitStderr },
      });
    }

    logInfo('[Daemon] GitCommit completed', {
      sessionId,
      message,
    });

    return { success: true };
  }

  private static parseRepoFullName(
    repoUrl: string
  ): Pick<PushGitAiPullRequestRequest, 'repoFullName'> {
    const match = repoUrl.match(
      /(?:github\.com[:/]|gitlab\.com[:/])([^/\s:]+\/[^/\s]+?)(?:\.git)?$/
    );
    return match ? { repoFullName: match[1] } : {};
  }

  private static extractLinkedIssueMetadata(params: {
    prBody?: string;
    linkedTicketIds?: string[];
    linkedTicketUrls?: string[];
    jiraIssueKeys?: string[];
    linearIssueIds?: string[];
  }): Pick<
    PushGitAiPullRequestRequest,
    'linkedTicketIds' | 'linkedTicketUrls' | 'jiraIssueKeys' | 'linearIssueIds'
  > {
    const linkedTicketIds = new Set(params.linkedTicketIds ?? []);
    const linkedTicketUrls = new Set<string>();
    for (const rawUrl of params.linkedTicketUrls ?? []) {
      const cleanUrl = rawUrl.replace(/[.,;:!?]+$/, '');
      if (!URL.canParse(cleanUrl)) {
        continue;
      }
      const url = new URL(cleanUrl);
      linkedTicketUrls.add(`${url.origin}${url.pathname}`);
    }
    const jiraIssueKeys = new Set(params.jiraIssueKeys ?? []);
    const linearIssueIds = new Set(params.linearIssueIds ?? []);

    const urls = params.prBody?.match(/https?:\/\/[^\s<>)\]]+/g) ?? [];
    for (const rawUrl of urls) {
      const cleanUrl = rawUrl.replace(/[.,;:!?]+$/, '');
      if (!URL.canParse(cleanUrl)) {
        continue;
      }
      const url = new URL(cleanUrl);
      const persistedUrl = `${url.origin}${url.pathname}`;

      const pathSegments = url.pathname.split('/').filter(Boolean);
      const issueSegmentIndex = pathSegments.findIndex(
        (segment) => segment.toLowerCase() === 'issue'
      );
      const linearIssueId =
        url.hostname === 'linear.app' && issueSegmentIndex >= 0
          ? pathSegments[issueSegmentIndex + 1]
          : undefined;
      if (linearIssueId) {
        linkedTicketIds.add(linearIssueId);
        linearIssueIds.add(linearIssueId);
        linkedTicketUrls.add(persistedUrl);
        continue;
      }

      const browseSegmentIndex = pathSegments.findIndex(
        (segment) => segment.toLowerCase() === 'browse'
      );
      const candidateJiraKey =
        browseSegmentIndex >= 0
          ? pathSegments[browseSegmentIndex + 1]
          : undefined;
      const jiraIssueKey =
        candidateJiraKey && /^[A-Z][A-Z0-9_]*-\d+$/.test(candidateJiraKey)
          ? candidateJiraKey
          : undefined;
      if (jiraIssueKey) {
        linkedTicketIds.add(jiraIssueKey);
        jiraIssueKeys.add(jiraIssueKey);
        linkedTicketUrls.add(persistedUrl);
      }
    }

    return {
      ...(linkedTicketIds.size > 0 && {
        linkedTicketIds: [...linkedTicketIds],
      }),
      ...(linkedTicketUrls.size > 0 && {
        linkedTicketUrls: [...linkedTicketUrls],
      }),
      ...(jiraIssueKeys.size > 0 && { jiraIssueKeys: [...jiraIssueKeys] }),
      ...(linearIssueIds.size > 0 && { linearIssueIds: [...linearIssueIds] }),
    };
  }

  private static async tryRunGitCommand(
    args: string[],
    cwd: string
  ): Promise<string | undefined> {
    const { stdout, exitCode } =
      await DroolRequestHandler.runGitCommandWithStderr(args, cwd);
    return exitCode === 0 ? stdout || undefined : undefined;
  }

  private static async getPrCommitShas(
    baseBranch: string,
    cwd: string
  ): Promise<string[] | undefined> {
    const output =
      (await DroolRequestHandler.tryRunGitCommand(
        ['log', '--format=%H', `origin/${baseBranch}..HEAD`],
        cwd
      )) ??
      (await DroolRequestHandler.tryRunGitCommand(
        ['log', '--format=%H', `${baseBranch}..HEAD`],
        cwd
      ));

    const commits = output
      ?.split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return commits && commits.length > 0 ? commits : undefined;
  }

  private async pushGitAiPullRequestMetadata(params: {
    sessionId: string;
    sessionCwd: string;
    prNumber: number;
    prUrl: string;
    title: string;
    normalizedBaseBranch: string;
    draft: boolean;
    createdAt: string;
    body?: string;
    linkedTicketIds?: string[];
    linkedTicketUrls?: string[];
    jiraIssueKeys?: string[];
    linearIssueIds?: string[];
  }): Promise<void> {
    try {
      const token = await getAuthToken(this.runtimeAuthConfig);
      if (!token) return;

      const [headBranch, repoUrl, commitShas] = await Promise.all([
        DroolRequestHandler.tryRunGitCommand(
          ['rev-parse', '--abbrev-ref', 'HEAD'],
          params.sessionCwd
        ),
        DroolRequestHandler.tryRunGitCommand(
          ['remote', 'get-url', 'origin'],
          params.sessionCwd
        ),
        DroolRequestHandler.getPrCommitShas(
          params.normalizedBaseBranch,
          params.sessionCwd
        ),
      ]);

      const sanitizedRepoUrl =
        repoUrl &&
        (repoUrl.startsWith('http://') || repoUrl.startsWith('https://'))
          ? sanitizeGitRemoteUrl(repoUrl)
          : repoUrl;
      const body: PushGitAiPullRequestRequest = {
        prNumber: params.prNumber,
        prUrl: params.prUrl,
        prTitle: params.title,
        prState: 'open',
        prDraft: params.draft,
        prCreatedAt: params.createdAt,
        prMergedAt: null,
        prClosedAt: null,
        isMerged: false,
        isAccepted: false,
        ...(sanitizedRepoUrl && { repoUrl: sanitizedRepoUrl }),
        ...(sanitizedRepoUrl &&
          DroolRequestHandler.parseRepoFullName(sanitizedRepoUrl)),
        baseBranch: params.normalizedBaseBranch,
        ...(headBranch && { headBranch }),
        ...(commitShas && { commitShas }),
        ...DroolRequestHandler.extractLinkedIssueMetadata({
          ...(params.body && { prBody: params.body }),
          ...(params.linkedTicketIds && {
            linkedTicketIds: params.linkedTicketIds,
          }),
          ...(params.linkedTicketUrls && {
            linkedTicketUrls: params.linkedTicketUrls,
          }),
          ...(params.jiraIssueKeys && { jiraIssueKeys: params.jiraIssueKeys }),
          ...(params.linearIssueIds && {
            linearIssueIds: params.linearIssueIds,
          }),
        }),
      };

      const response = await fetch(
        `${this.apiBaseUrl}/api/sessions/${params.sessionId}/git-ai/pull-requests`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }
      );

      if (!response.ok) {
        logWarn('[Daemon] Git-AI PR metadata persistence returned non-OK', {
          sessionId: params.sessionId,
          statusCode: response.status,
        });
      }
    } catch (error) {
      logWarn('[Daemon] Failed to persist Git-AI PR metadata', {
        sessionId: params.sessionId,
        cause: error,
      });
    }
  }

  private async handleCreatePR(
    request: DaemonCreatePRRequest
  ): Promise<DaemonCreatePRResult> {
    const {
      sessionId,
      title,
      body,
      baseBranch,
      draft,
      linkedTicketIds,
      linkedTicketUrls,
      jiraIssueKeys,
      linearIssueIds,
    } = request.params;
    const createPRStartTime = Date.now();
    Metrics.addToCounter(Metric.DIFF_VIEWER_CREATE_PR_COUNT, 1, { sessionId });
    logInfo('[Daemon] CreatePR received', { sessionId });

    const sessionState = this.droolRegistry.getSessionState(sessionId);
    if (!sessionState?.cwd) {
      throw new MetaError('Session not found or has no working directory', {
        sessionId,
      });
    }

    const sessionCwd = sessionState.cwd;

    // Sanitize user-controlled inputs to prevent argument injection (CWE-88)
    const sanitizedTitle = validateCLIValue(title, 'title');
    const sanitizedBody = validateCLIValue(body ?? '', 'body');
    // Strip origin/ prefix from baseBranch since gh CLI expects bare branch names
    const normalizedBaseBranch = validateGitRef(
      baseBranch.replace(/^origin\//, ''),
      'baseBranch'
    );

    const args = [
      'pr',
      'create',
      '--title',
      sanitizedTitle,
      '--body',
      sanitizedBody,
      '--base',
      normalizedBaseBranch,
    ];

    if (draft) {
      args.push('--draft');
    }

    try {
      const proc = Bun.spawn(['gh', ...args], {
        cwd: sessionCwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      await proc.exited;

      if (proc.exitCode !== 0) {
        throw new MetaError('gh pr create failed', {
          sessionId,
          value: { exitCode: proc.exitCode, stderr: stderr.trim() },
        });
      }

      const prUrl = stdout
        .split('\n')
        .map((line) => line.trim())
        .find(
          (line) => line.startsWith('https://') || line.startsWith('http://')
        );

      if (!prUrl) {
        throw new MetaError('gh pr create returned no PR URL', {
          sessionId,
          value: { stdout: stdout.trim(), stderr: stderr.trim() },
        });
      }

      const prNumberMatch = prUrl.match(/\/pull\/(\d+)(?:$|[/?#])/);
      if (!prNumberMatch) {
        throw new MetaError('Unable to parse PR number from gh output', {
          sessionId,
          value: { prUrl },
        });
      }

      const prNumber = Number(prNumberMatch[1]);
      const prCreatedAt = new Date().toISOString();

      await this.pushGitAiPullRequestMetadata({
        sessionId,
        sessionCwd,
        prNumber,
        prUrl,
        title,
        normalizedBaseBranch,
        draft: draft ?? false,
        createdAt: prCreatedAt,
        ...(body && { body }),
        ...(linkedTicketIds && { linkedTicketIds }),
        ...(linkedTicketUrls && { linkedTicketUrls }),
        ...(jiraIssueKeys && { jiraIssueKeys }),
        ...(linearIssueIds && { linearIssueIds }),
      });

      logInfo('[Daemon] CreatePR completed', {
        sessionId,
        prNumber,
        url: prUrl,
      });

      Metrics.addToCounter(Metric.DIFF_VIEWER_CREATE_PR_SUCCESS_COUNT, 1, {
        sessionId,
      });
      Metrics.recordHistogram(
        Metric.DIFF_VIEWER_CREATE_PR_LATENCY,
        Date.now() - createPRStartTime,
        { sessionId }
      );

      return {
        number: prNumber,
        title,
        url: prUrl,
        state: 'open',
        draft: draft ?? false,
      };
    } catch (error) {
      if (error instanceof MetaError) throw error;
      throw new MetaError('Failed to create pull request', {
        sessionId,
        cause: error,
      });
    }
  }

  // ============================================================
  // Generate Semantic Diff (Agent Flow)
  // ============================================================

  private static readonly SEMANTIC_DIFF_MAX_DIFF_SIZE = 150000;

  private static readonly SEMANTIC_DIFF_AGENT_TIMEOUT_MS = 180000;

  private async handleGenerateSemanticDiff(
    context: IAuthedDaemonConnection,
    request: DaemonGenerateSemanticDiffRequest
  ): Promise<DaemonGenerateSemanticDiffResult> {
    const { params } = request;
    const parentSessionId = params.sessionId;
    const semanticDiffStartTime = Date.now();
    Metrics.addToCounter(Metric.DIFF_VIEWER_SEMANTIC_DIFF_GENERATE_COUNT, 1, {
      sessionId: parentSessionId,
      diffSize: params.diff.length,
    });

    const parentState = this.droolRegistry.getSessionState(parentSessionId);
    const cwd = parentState?.cwd;
    if (!cwd) {
      throw new MetaError(
        'Parent session not found or has no working directory',
        { sessionId: parentSessionId }
      );
    }

    const modelId = params.modelId;

    const maxDiffSize = DroolRequestHandler.SEMANTIC_DIFF_MAX_DIFF_SIZE;
    let truncated = false;
    let truncatedDiff = params.diff;
    if (params.diff.length > maxDiffSize) {
      truncatedDiff = params.diff.slice(0, maxDiffSize);
      truncated = true;
      Metrics.addToCounter(
        Metric.DIFF_VIEWER_SEMANTIC_DIFF_TRUNCATED_COUNT,
        1,
        { sessionId: parentSessionId, diffSize: params.diff.length }
      );
      logInfo('[SemanticDiff] Diff truncated due to size', {
        sizeBytes: maxDiffSize,
        originalSize: params.diff.length,
      });
    }

    // Truncate unstagedDiff with remaining budget
    let truncatedUnstagedDiff = '';
    const unstagedDiff = params.unstagedDiff;
    if (typeof unstagedDiff === 'string' && unstagedDiff.trim()) {
      const remainingBudget = Math.max(0, maxDiffSize - truncatedDiff.length);
      if (remainingBudget > 0) {
        if (unstagedDiff.length > remainingBudget) {
          truncatedUnstagedDiff = unstagedDiff.slice(0, remainingBudget);
          truncated = true;
          logInfo('[SemanticDiff] Unstaged diff truncated due to size', {
            budget: remainingBudget,
            originalSize: unstagedDiff.length,
          });
        } else {
          truncatedUnstagedDiff = unstagedDiff;
        }
      } else {
        truncated = true;
        logInfo(
          '[SemanticDiff] Unstaged diff skipped, no remaining budget',
          {}
        );
      }
    }

    const { generateSemanticDiffPrompt } = await import(
      './semantic-diff-prompt'
    );
    const basePrompt = generateSemanticDiffPrompt(
      params.baseBranch,
      params.currentBranch
    );
    const truncationNote = truncated
      ? '\n\nNOTE: The diff was truncated due to size. Focus on the changes shown.'
      : '';
    const unstagedSection = truncatedUnstagedDiff
      ? `\n\n<unstaged_changes>\nThe following changes are uncommitted (unstaged) working tree changes. Include them in your analysis but tag their diff blocks with "(unstaged)" next to the file name.\n\n${truncatedUnstagedDiff}\n</unstaged_changes>`
      : '';
    const fullPrompt = `${basePrompt}\n\n<git_diff>\n${truncatedDiff}\n</git_diff>${unstagedSection}${truncationNote}`;

    const sessionId = crypto.randomUUID();

    const transport = new ProcessTransport({
      cwd,
      droolExecPath: this.droolExecPath,
      isDevelopment: this.isDevelopment,
      droolExecExtraArgs: ['--skip-permissions-unsafe'],
      env: this.buildSpawnEnv(
        context.user,
        { DROOL_DISABLE_SOUNDS: 'true' },
        context.caller
      ),
      enableIpc: this.attachChildIpc !== undefined,
    });
    const client = new DroolClient({ transport });

    try {
      await this.connectProcessTransport({
        transport,
        context,
        sourceSessionId: sessionId,
      });

      const response = await client.initializeSession({
        machineId: LOCAL_MACHINE_ID,
        sessionId,
        cwd,
        ...(modelId ? { modelId } : {}),
        tags: [{ name: 'semantic-diff' }],
      });

      if (response.error) {
        throw new MetaError('Failed to initialize semantic diff session', {
          code: response.error.code,
          message: response.error.message,
        });
      }

      const result = InitializeSessionResultSchema.parse(response.result);
      const actualSessionId = result.sessionId;

      const agentContent = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new MetaError('Semantic diff agent timed out', {
              sessionId: actualSessionId,
            })
          );
        }, DroolRequestHandler.SEMANTIC_DIFF_AGENT_TIMEOUT_MS);

        let assistantText = '';

        const notificationHandler = (event: SessionNotificationEvent) => {
          const { notification } = event.params;

          if (
            notification.type === SessionNotificationType.ASSISTANT_TEXT_DELTA
          ) {
            assistantText += notification.textDelta;
          }

          if (
            notification.type ===
            SessionNotificationType.DROOL_WORKING_STATE_CHANGED
          ) {
            if (notification.newState === DroolWorkingState.Idle) {
              clearTimeout(timeout);
              client.off(
                DroolClientEvent.SESSION_NOTIFICATION,
                notificationHandler
              );
              resolve(assistantText);
            }
          }

          if (notification.type === SessionNotificationType.ERROR) {
            clearTimeout(timeout);
            client.off(
              DroolClientEvent.SESSION_NOTIFICATION,
              notificationHandler
            );
            reject(
              new MetaError('Semantic diff agent error', {
                message: notification.message,
              })
            );
          }
        };

        client.on(DroolClientEvent.SESSION_NOTIFICATION, notificationHandler);

        // NOTE: The agent runs with full tool access. Tool restrictions are enforced
        // via the system reminder prompt only. The CLI's initializeSession API does
        // not currently support a restrictive tool allowlist.
        const systemReminder = [
          SYSTEM_REMINDER_START,
          'You are generating a semantic diff summary. This is a non-interactive execution.',
          'Do NOT use the AskUser tool. The user is not present and cannot respond.',
          'Do NOT use any file editing or execution tools. Only analyze the diff and produce markdown output.',
          'Respond with ONLY the semantic diff markdown content, nothing else.',
          SYSTEM_REMINDER_END,
        ].join('\n');

        client
          .addUserMessage({
            text: `${systemReminder}\n${fullPrompt}`,
          })
          .catch((err: unknown) => {
            clearTimeout(timeout);
            client.off(
              DroolClientEvent.SESSION_NOTIFICATION,
              notificationHandler
            );
            reject(err);
          });
      });

      if (!agentContent.trim()) {
        throw new MetaError('Semantic diff agent returned empty content', {
          sessionId: actualSessionId,
        });
      }

      logInfo('[SemanticDiff] Agent generation completed', {
        sessionId: actualSessionId,
        baseSessionId: parentSessionId,
        currentContentLength: agentContent.length,
        truncated,
      });

      Metrics.addToCounter(
        Metric.DIFF_VIEWER_SEMANTIC_DIFF_GENERATE_SUCCESS_COUNT,
        1,
        { sessionId: parentSessionId }
      );
      Metrics.recordHistogram(
        Metric.DIFF_VIEWER_SEMANTIC_DIFF_GENERATE_LATENCY,
        Date.now() - semanticDiffStartTime,
        { sessionId: parentSessionId, diffSize: params.diff.length }
      );

      await client.close().catch((closeError: unknown) => {
        logException(
          closeError,
          'Failed to close client after semantic diff completion'
        );
      });

      return {
        content: agentContent,
        truncated,
        sessionId: actualSessionId,
      };
    } catch (error) {
      await client.close().catch((closeError: unknown) => {
        logException(
          closeError,
          'Failed to close client after semantic diff error'
        );
      });
      throw error instanceof MetaError
        ? error
        : new MetaError('Failed to generate semantic diff', {
            cause: error,
          });
    }
  }

  // ============================================================
  // Semantic Diff Cache
  // ============================================================

  private static readonly SEMANTIC_DIFFS_DIR_NAME = 'semantic_diffs';

  private static sanitizeBranchName(branch: string): string {
    return branch
      .replace(/[/\\:*?"<>|]/g, '-')
      .replace(/\.\./g, '__')
      .replace(/^\./, '_')
      .replace(/\.$/, '_')
      .replace(/-+/g, '-')
      .replace(/^-/, '')
      .replace(/-$/, '');
  }

  private static getSemanticDiffCachePath(
    currentBranch: string,
    baseBranch: string
  ): string {
    const sanitizedCurrent =
      DroolRequestHandler.sanitizeBranchName(currentBranch);
    const sanitizedBase = DroolRequestHandler.sanitizeBranchName(baseBranch);
    return path.join(
      getIndustryHome(),
      getIndustryDirName(),
      DroolRequestHandler.SEMANTIC_DIFFS_DIR_NAME,
      sanitizedCurrent,
      `${sanitizedBase}.json`
    );
  }

  private static handleGetSemanticDiffCache(
    request: DaemonGetSemanticDiffCacheRequest
  ): DaemonGetSemanticDiffCacheResult {
    const { currentBranch, baseBranch } = request.params;

    const cachePath = DroolRequestHandler.getSemanticDiffCachePath(
      currentBranch,
      baseBranch
    );

    try {
      if (!fs.existsSync(cachePath)) {
        Metrics.addToCounter(
          Metric.DIFF_VIEWER_SEMANTIC_DIFF_CACHE_MISS_COUNT,
          1
        );
        return { content: null, commitHash: null, truncated: false };
      }

      const raw = fs.readFileSync(cachePath, 'utf-8');
      const data = DaemonGetSemanticDiffCacheResultSchema.parse(
        JSON.parse(raw)
      );

      if (data.content) {
        Metrics.addToCounter(
          Metric.DIFF_VIEWER_SEMANTIC_DIFF_CACHE_HIT_COUNT,
          1
        );
      } else {
        Metrics.addToCounter(
          Metric.DIFF_VIEWER_SEMANTIC_DIFF_CACHE_MISS_COUNT,
          1
        );
      }

      return {
        content: data.content,
        commitHash: data.commitHash,
        truncated: data.truncated ?? false,
      };
    } catch (error) {
      Metrics.addToCounter(
        Metric.DIFF_VIEWER_SEMANTIC_DIFF_CACHE_MISS_COUNT,
        1
      );
      logWarn('[Daemon] Failed to read semantic diff cache', {
        branch: currentBranch,
        baseBranch,
        error: error instanceof Error ? error.message : String(error),
      });
      return { content: null, commitHash: null, truncated: false };
    }
  }

  private static handleSaveSemanticDiffCache(
    request: DaemonSaveSemanticDiffCacheRequest
  ): DaemonSaveSemanticDiffCacheResult {
    const { currentBranch, baseBranch, commitHash, content, truncated } =
      request.params;

    const cachePath = DroolRequestHandler.getSemanticDiffCachePath(
      currentBranch,
      baseBranch
    );

    try {
      const dir = path.dirname(cachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = {
        content,
        commitHash,
        truncated,
        generatedAt: new Date().toISOString(),
      };

      fs.writeFileSync(cachePath, JSON.stringify(data), 'utf-8');

      logInfo('[Daemon] Saved semantic diff cache', {
        branch: currentBranch,
        baseBranch,
        commitSha: commitHash,
        currentContentLength: content.length,
      });

      return { success: true };
    } catch (error) {
      logWarn('[Daemon] Failed to save semantic diff cache', {
        branch: currentBranch,
        baseBranch,
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false };
    }
  }

  /** Returns the auth token used by the localhost port proxy. */
  private static handleGetProxyToken(): DaemonGetProxyTokenResult {
    return { token: getOrCreateDaemonProxyToken() };
  }

  /**
   * Reads the contents of a workspace file for renderer-side preview.
   * Always anchors reads to the session cwd: relative inputs are resolved
   * against cwd, absolute inputs are required to live under cwd. Both the
   * cwd and the target are realpath-canonicalized first so symlinked path
   * components cannot escape the workspace. Caps reads at 15 MB.
   */
  private async handleGetWorkspaceFileContent(
    request: DaemonGetWorkspaceFileContentRequest
  ): Promise<DaemonGetWorkspaceFileContentResult> {
    const { sessionId, filePath } = request.params;
    const trimmedPath = filePath.trim();
    // Workspace paths and cwds are user-generated content and must stay
    // out of telemetry per packages/logging/src/metadata/types.ts. We
    // only attach sessionId / cause / size to errors thrown from here.
    if (!trimmedPath) {
      throw new MetaError('filePath is required', { sessionId });
    }

    const sessionState = this.droolRegistry.getSessionState(sessionId);
    const cwd = sessionState?.cwd;
    if (!cwd) {
      throw new MetaError('Cannot read workspace file without session cwd', {
        sessionId,
      });
    }

    let canonicalCwd: string;
    try {
      canonicalCwd = await fs.promises.realpath(cwd);
    } catch (error) {
      throw new MetaError('Failed to resolve session cwd', {
        sessionId,
        cause: error,
      });
    }

    const candidatePath = path.isAbsolute(trimmedPath)
      ? trimmedPath
      : path.resolve(canonicalCwd, trimmedPath);

    let canonicalTarget: string;
    try {
      canonicalTarget = await fs.promises.realpath(candidatePath);
    } catch (error) {
      throw new MetaError('Failed to stat file', {
        sessionId,
        cause: error,
      });
    }

    const relativeFromCwd = path.relative(canonicalCwd, canonicalTarget);
    if (relativeFromCwd.startsWith('..') || path.isAbsolute(relativeFromCwd)) {
      throw new MetaError('Refusing to read file outside session cwd', {
        sessionId,
      });
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(canonicalTarget);
    } catch (error) {
      throw new MetaError('Failed to stat file', {
        sessionId,
        cause: error,
      });
    }

    if (!stat.isFile()) {
      throw new MetaError('Path is not a file', {
        sessionId,
      });
    }

    const MAX_BYTES = 15 * 1024 * 1024;
    if (stat.size > MAX_BYTES) {
      throw new MetaError('File exceeds 15MB preview cap', {
        sessionId,
        size: stat.size,
      });
    }

    const buffer = await fs.promises.readFile(canonicalTarget);
    const encoding = request.params.encoding ?? 'utf8';
    const mimeType = this.detectPreviewMimeType(canonicalTarget);

    if (encoding === 'base64') {
      return {
        content: buffer.toString('base64'),
        byteLength: buffer.byteLength,
        encoding: 'base64',
        mimeType,
      };
    }

    if (this.isProbablyBinaryBuffer(buffer)) {
      return {
        content: '',
        byteLength: buffer.byteLength,
        encoding: 'utf8',
        mimeType,
        isBinary: true,
      };
    }

    return {
      content: buffer.toString('utf-8'),
      byteLength: buffer.byteLength,
      encoding: 'utf8',
      mimeType,
    };
  }

  private detectPreviewMimeType(filePath: string): string | undefined {
    const ext = path.extname(filePath).toLowerCase();
    return PREVIEW_MIME_BY_EXTENSION[ext];
  }

  private isProbablyBinaryBuffer(buffer: Buffer): boolean {
    // A NUL byte in the leading sample is a reliable signal that the file is
    // binary rather than UTF-8 text. We only inspect the start to stay cheap
    // on large files.
    const sampleLength = Math.min(buffer.byteLength, 8000);
    for (let i = 0; i < sampleLength; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  }

  private async handleGetRewindInfo(
    request: DaemonGetRewindInfoRequest
  ): Promise<DaemonGetRewindInfoResult> {
    const { sessionId, messageId } = request.params;
    logInfo('[Daemon] GetRewindInfo received', { sessionId, messageId });

    const client = this.droolRegistry.getDroolClient(sessionId);
    if (!client) {
      throw new MetaError('No active session found for ID', { sessionId });
    }

    const response = await client.getRewindInfo({ messageId });
    if (response.error) {
      throw new MetaError('Failed to get rewind info', {
        code: response.error.code,
        message: response.error.message,
      });
    }

    return DaemonGetRewindInfoResultSchema.parse(response.result);
  }

  private async handleExecuteRewind(
    request: DaemonExecuteRewindRequest
  ): Promise<DaemonExecuteRewindResult> {
    const { sessionId, messageId, filesToRestore, filesToDelete, forkTitle } =
      request.params;
    logInfo('[Daemon] ExecuteRewind received', { sessionId, messageId });

    const client = this.droolRegistry.getDroolClient(sessionId);
    if (!client) {
      throw new MetaError('No active session found for ID', { sessionId });
    }

    const response = await client.executeRewind({
      messageId,
      filesToRestore,
      filesToDelete,
      forkTitle,
    });
    if (response.error) {
      throw new MetaError('Failed to execute rewind', {
        code: response.error.code,
        message: response.error.message,
      });
    }

    return DaemonExecuteRewindResultSchema.parse(response.result);
  }

  private async handleCompactSession(
    request: DaemonCompactSessionRequest
  ): Promise<DaemonCompactSessionResult> {
    const { sessionId, customInstructions } = request.params;
    logInfo('[Daemon] CompactSession received', { sessionId });

    const client = this.droolRegistry.getDroolClient(sessionId);
    if (!client) {
      throw new MetaError('No active session found for ID', { sessionId });
    }

    const response = await client.compactSession({ customInstructions });
    if (response.error) {
      throw new MetaError('Failed to compact session', {
        code: response.error.code,
        message: response.error.message,
      });
    }

    return DaemonCompactSessionResultSchema.parse(response.result);
  }

  private async handleForkSession(
    request: DaemonForkSessionRequest
  ): Promise<DaemonForkSessionResult> {
    const { sessionId, title, tags } = request.params;
    logInfo('[Daemon] ForkSession received', { sessionId });

    const client = this.droolRegistry.getDroolClient(sessionId);
    if (!client) {
      throw new MetaError('No active session found for ID', { sessionId });
    }

    const forkParams = title || tags ? { title, tags } : undefined;
    const response = await client.forkSession(forkParams);
    if (response.error) {
      throw new MetaError('Failed to fork session', {
        code: response.error.code,
        message: response.error.message,
      });
    }

    const result = DaemonForkSessionResultSchema.parse(response.result);

    // Mirror the fork's on-disk tags into the in-memory registry so
    // listOpenedSessions filtering (e.g. btw-fork exclusion) works
    // before any updateSessionSettings RPC is issued for the new
    // session.
    if (tags && tags.length > 0) {
      this.droolRegistry.setSessionTags(result.newSessionId, tags);
    }

    return result;
  }

  private async handleWarmupCache(
    request: DaemonWarmupCacheRequest
  ): Promise<Record<string, never>> {
    const { sessionId } = request.params;
    logInfo('[Daemon] Ignoring deprecated WarmupCache request', { sessionId });

    return {};
  }

  private async handleGetContextBreakdown(
    request: DaemonGetContextBreakdownRequest
  ): Promise<DaemonGetContextBreakdownResult> {
    const { sessionId } = request.params;
    logInfo('[Daemon] GetContextBreakdown received', { sessionId });

    const client = this.droolRegistry.getDroolClient(sessionId);
    if (!client) {
      throw new MetaError('No active session found for ID', { sessionId });
    }

    const response = await client.getContextBreakdown();
    if (response.error) {
      throw new MetaError('Failed to get context breakdown', {
        code: response.error.code,
        message: response.error.message,
      });
    }

    return DaemonGetContextBreakdownResultSchema.parse(response.result);
  }
}
