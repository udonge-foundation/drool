import { z } from 'zod';

import { ApiProvider } from '@industry/drool-sdk-ext/protocol/llm';

import { IndustryFeatureFlag } from './types';
import { IndustryTier } from '../organization/enums';
import { ManagedSettingsSchema } from '../settings/schema';
import { IndustryRegion } from '../shared/enums';

export const FEATURE_FLAG_ENABLED_EXPLANATION =
  'Determines whether the feature flag is enabled for your user. When not overriden, this value is determined by statsig.';
export const FEATURE_FLAG_OVERRIDE_EXPLANATION =
  'Determines whether to override the feature flag value returned by statsig. This will only affect your user on this browser/device combo.';

export const IndustryFeatureFlags: Record<string, IndustryFeatureFlag> = {
  MissionUiEntrypoints: {
    displayName: 'Mission UI Entrypoints',
    statsigName: 'mission_ui_entrypoints',
    defaultValue: false,
  },
  WorkspacesEnabled: {
    displayName: 'Cloud Workspaces (Sandboxes)',
    statsigName: 'workspaces_enabled',
    defaultValue: false,
  },
  DesktopWorktrees: {
    displayName: 'Desktop Worktrees',
    statsigName: 'desktop_worktrees',
    defaultValue: false,
  },
  DesktopTiling: {
    displayName: 'Desktop Tiling',
    statsigName: 'desktop_tiling',
    defaultValue: false,
  },
  AnalyticsDashboards: {
    displayName: 'Analytics Dashboards',
    statsigName: 'analytics_dashboards',
    defaultValue: false,
  },
  AgentEffectivenessReport: {
    displayName: 'Agent Effectiveness Report',
    statsigName: 'agent_effectiveness_report',
    defaultValue: false,
  },
  AdvancedAnalytics: {
    displayName: 'Advanced Analytics',
    statsigName: 'advanced_analytics',
    defaultValue: false,
  },
  AnalyticsV2: {
    displayName: 'Analytics V2',
    statsigName: 'analytics_v2',
    defaultValue: false,
  },
  Titan0212: {
    displayName: 'Titan 02/12 (Preview)',
    statsigName: 'titan_0212',
    defaultValue: false,
  },
  Aspen0515: {
    displayName: 'Aspen 05/15 (Preview)',
    statsigName: 'aspen_0515',
    defaultValue: false,
  },
  Almond0527: {
    displayName: 'Almond 05/27 (Preview)',
    statsigName: 'almond_0527',
    defaultValue: false,
  },
  Anise0616: {
    displayName: 'Anise 06/16 (Preview)',
    statsigName: 'anise_0616',
    defaultValue: false,
  },
  ClaudeOpus48: {
    displayName: 'Claude Opus 4.8',
    statsigName: 'claude_opus_4_8',
    defaultValue: false,
  },
  ClaudeOpus48Fast: {
    displayName: 'Claude Opus 4.8 Fast Mode',
    statsigName: 'claude_opus_4_8_fast',
    defaultValue: false,
  },
  ClaudeFable5: {
    displayName: 'Claude Fable 5',
    statsigName: 'claude_fable_5',
    defaultValue: false,
  },
  Orbit0409: {
    displayName: 'Orbit 04/09 (Preview)',
    statsigName: 'orbit_0409',
    defaultValue: false,
  },
  Oxide0601: {
    displayName: 'Oxide 06/01 (Preview)',
    statsigName: 'oxide_0601',
    defaultValue: false,
  },
  Oxbow0601: {
    displayName: 'Oxbow 06/01 Code Mode (Preview)',
    statsigName: 'oxbow_0601',
    defaultValue: false,
  },
  Owl0621: {
    displayName: 'Owl 06/21 (Preview)',
    statsigName: 'owl_0621',
    defaultValue: false,
  },
  Gantry0507: {
    displayName: 'Gantry 05/07 (Preview)',
    statsigName: 'gantry_0507',
    defaultValue: false,
  },
  Gemini35Flash: {
    displayName: 'Gemini 3.5 Flash',
    statsigName: 'gemini_3_5_flash',
    defaultValue: false,
  },
  Nemotron3Ultra: {
    displayName: 'Drool Core (Nemotron 3 Ultra)',
    statsigName: 'nemotron_3_ultra',
    defaultValue: false,
  },
  KimiK27Code: {
    displayName: 'Drool Core (Kimi K2.7 Code)',
    statsigName: 'kimi_k2_7_code',
    defaultValue: false,
  },
  Glm52: {
    displayName: 'Drool Core (GLM-5.2)',
    statsigName: 'glm_5_2',
    defaultValue: false,
  },
  DeprecateGlm47: {
    displayName: 'Deprecate Drool Core (GLM-4.7)',
    statsigName: 'deprecate_glm_4_7',
    defaultValue: false,
  },
  DeprecateGlm5: {
    displayName: 'Deprecate Drool Core (GLM-5)',
    statsigName: 'deprecate_glm_5',
    defaultValue: false,
  },
  DeprecateKimiK25: {
    displayName: 'Deprecate Drool Core (Kimi K2.5)',
    statsigName: 'deprecate_kimi_k2_5',
    defaultValue: false,
  },
  DeprecateGpt5Codex: {
    displayName: 'Deprecate GPT-5-Codex',
    statsigName: 'deprecate_gpt_5_codex',
    defaultValue: false,
  },
  DeprecateGpt51Codex: {
    displayName: 'Deprecate GPT-5.1-Codex',
    statsigName: 'deprecate_gpt_5_1_codex',
    defaultValue: false,
  },
  DeprecateGpt51CodexMax: {
    displayName: 'Deprecate GPT-5.1-Codex-Max',
    statsigName: 'deprecate_gpt_5_1_codex_max',
    defaultValue: false,
  },
  DeprecateGpt52Codex: {
    displayName: 'Deprecate GPT-5.2-Codex',
    statsigName: 'deprecate_gpt_5_2_codex',
    defaultValue: false,
  },
  Olm0305: {
    displayName: 'Olm 03/05 (Preview)',
    statsigName: 'olm_0305',
    defaultValue: false,
  },
  // Keep this flag in the active registry. It is intentionally used by
  // feature-flag UI tests and stories as a stable test fixture.
  DummyFrontendFeatureFlag: {
    displayName: 'Dummy Frontend Feature Flag',
    statsigName: 'dummy_frontend_feature_flag',
    defaultValue: false,
  },
  EnableBaseten: {
    displayName: 'Enable Baseten',
    statsigName: 'enable_baseten',
    defaultValue: false,
  },
  UseYouSearchApi: {
    displayName: 'Use You Search API',
    statsigName: 'use_you_search_api',
    defaultValue: false,
  },
  UseParallelSearchApi: {
    displayName: 'Use Parallel Search API',
    statsigName: 'use_parallel_search_api',
    defaultValue: false,
  },
  ParallelBasicMode: {
    displayName: 'Parallel Basic Mode',
    statsigName: 'parallel_basic_mode',
    defaultValue: false,
  },
  LogFailedLLMRequestsToS3: {
    displayName: 'Log Failed LLM Requests to S3',
    statsigName: 'log_failed_llm_requests_to_s3',
    defaultValue: false,
  },
  ReportBYOKUsageToOrb: {
    displayName: 'Report BYOK Usage to Orb',
    statsigName: 'report_byok_usage_to_orb',
    defaultValue: false,
  },
  UltraPlan: {
    displayName: 'Ultra Plan',
    statsigName: 'ultra_plan',
    defaultValue: false,
  },
  HideBillableTokens: {
    displayName: 'Hide Billable Tokens',
    statsigName: 'hide_billable_tokens',
    defaultValue: false,
  },
  ImprovedAnalytics: {
    displayName: 'Improved Analytics',
    statsigName: 'improved_analytics',
    defaultValue: false,
  },

  ForceEnterpriseControls: {
    displayName: 'Force Enterprise Controls',
    statsigName: 'force_enterprise_controls',
    defaultValue: false,
  },
  DisableAutoUpdateControl: {
    displayName: 'Disable Auto Update Control',
    statsigName: 'disable_auto_update_control',
    defaultValue: false,
  },
  SelfServeExplicitOptInDefaultAllow: {
    displayName: 'Self-Serve Explicit Opt-In Default Allow',
    statsigName: 'self_serve_explicit_opt_in_default_allow',
    defaultValue: false,
  },
  HideOrgDisabledModels: {
    displayName: 'Hide Org Disabled Models',
    statsigName: 'hide_org_disabled_models',
    defaultValue: false,
  },
  NewModelSelector: {
    displayName: 'New Model Selector',
    statsigName: 'new_model_selector',
    defaultValue: false,
  },
  AdminUsageAlerts: {
    displayName: 'Admin Usage Alerts',
    statsigName: 'admin_usage_alerts',
    defaultValue: false,
  },
  SubOrganizations: {
    displayName: 'Sub Organizations',
    statsigName: 'sub_organizations',
    defaultValue: false,
  },
  // eslint-disable-next-line industry/no-unused-feature-flags
  ManagedComputers: {
    displayName: 'Managed Computers',
    statsigName: 'managed_computers',
    defaultValue: true,
  },
  AppDebugMode: {
    displayName: 'App Debug Mode',
    statsigName: 'app_debug_mode',
    defaultValue: false,
  },
  DesktopDaemonIpc: {
    displayName: 'Desktop Daemon IPC',
    statsigName: 'desktop_daemon_ipc',
    defaultValue: false,
  },
  TuiUseComposableDaemonCore: {
    displayName: 'TUI Use Composable Daemon Core',
    statsigName: 'tui_use_composable_daemon_core',
    defaultValue: false,
  },
  ComputerTemplatesApi: {
    displayName: 'Computer Templates API',
    statsigName: 'computer_templates_api',
    defaultValue: false,
  },
  Automations: {
    displayName: 'Automations',
    statsigName: 'automations',
    defaultValue: false,
  },
  ServiceAccounts: {
    displayName: 'Service Accounts',
    statsigName: 'service_accounts',
    defaultValue: false,
  },
  AutomationsV2: {
    displayName: 'Automations V2',
    statsigName: 'automations_v2',
    defaultValue: false,
  },
  TriageAutomation: {
    displayName: 'Triage Automation',
    statsigName: 'triage_automation',
    defaultValue: false,
  },
  SlackAutomationsMigration: {
    displayName: 'Slack Automations Migration',
    statsigName: 'slack_automations_migration',
    defaultValue: false,
  },
  SoftwareIndustry: {
    displayName: 'Software Industry',
    statsigName: 'software_industry',
    defaultValue: false,
  },
  SlackAssistantThreadSetStatus: {
    displayName: 'Slack Assistant Thread Set Status',
    statsigName: 'slack_assistant_thread_set_status',
    defaultValue: false,
  },
  SlackAskUser: {
    displayName: 'Slack AskUser',
    statsigName: 'slack_ask_user',
    defaultValue: false,
  },
  SlackPullRequestCiMonitoringPrompt: {
    displayName: 'Slack Pull Request CI Monitoring Prompt',
    statsigName: 'slack_pull_request_ci_monitoring_prompt',
    defaultValue: false,
  },
  Wiki: {
    displayName: 'Wiki',
    statsigName: 'wiki',
    defaultValue: false,
  },
  Academy: {
    displayName: 'Industry Academy',
    statsigName: 'industry_academy',
    defaultValue: false,
  },
  EnableKeyringForNewLogins: {
    displayName: 'Enable Keyring For New Logins',
    statsigName: 'enable_keyring_for_new_logins',
    defaultValue: false,
  },
  GitAi: {
    displayName: 'Git AI',
    statsigName: 'git_ai',
    defaultValue: false,
  },
  GitAiAutoSetup: {
    displayName: 'Git AI Auto Setup',
    statsigName: 'git_ai_auto_setup',
    defaultValue: false,
  },
  // Still in progress as of 2026-04-27. Keep gated until launch.
  Squad: {
    displayName: 'Squad',
    statsigName: 'squad',
    defaultValue: false,
  },
  SubAgentsV2: {
    displayName: 'Sub-Agents V2',
    statsigName: 'sub_agents_v2',
    defaultValue: false,
  },
  CliIncrementalRendering: {
    displayName: 'CLI Incremental Rendering',
    statsigName: 'cli_incremental_rendering',
    defaultValue: false,
  },
  LoopCommand: {
    displayName: 'Loop Command',
    statsigName: 'loop_command',
    defaultValue: false,
  },
  CliQueuedMessages: {
    displayName: 'CLI Queued Messages',
    statsigName: 'cli_queued_messages',
    defaultValue: false,
  },
  AppQueuedMessages: {
    displayName: 'App Queued Messages',
    statsigName: 'app_queued_messages',
    defaultValue: false,
  },
  ByokIncludeStreamUsage: {
    displayName: 'BYOK Include Stream Usage',
    statsigName: 'byok_include_stream_usage',
    defaultValue: false,
  },
  BedrockByok: {
    displayName: 'Bedrock BYOK Custom Models',
    statsigName: 'bedrock_byok',
    defaultValue: false,
  },
  SpecNewSessionHandoff: {
    displayName: 'Spec New Session Handoff',
    statsigName: 'spec_new_session_handoff',
    defaultValue: false,
  },
  IncidentResponse: {
    displayName: 'Incident Response',
    statsigName: 'incident_response',
    defaultValue: false,
  },
  DisableSlackAutoRunRetryBudget: {
    displayName: 'Disable Slack Auto-Run Retry Budget',
    statsigName: 'disable_slack_auto_run_retry_budget',
    defaultValue: false,
  },
  SlackUserSessionDefaults: {
    displayName: 'Slack User Session Defaults',
    statsigName: 'slack_user_session_defaults',
    defaultValue: false,
  },
  SlackAutoRunBlockOnMcpLoad: {
    displayName: 'Slack Auto-Run Block On MCP Load',
    statsigName: 'slack_auto_run_block_on_mcp_load',
    defaultValue: false,
  },
  McpToolSearch: {
    displayName: 'MCP Tool Search',
    statsigName: 'mcp_tool_search',
    defaultValue: false,
  },
  ValidateMissionArtifactWrites: {
    displayName: 'Validate Mission Artifact Writes',
    statsigName: 'validate_mission_artifact_writes',
    defaultValue: false,
  },
  // Retained so apps/backend can continue serving this flag to older desktop
  // clients that still branch on it. Safe to remove once all such clients
  // have been upgraded off the legacy chat composer fork.
  ChatInputV1Point1: {
    displayName: 'Chat Input v1.1',
    statsigName: 'chat_input_v1.1',
    defaultValue: false,
  },
  IndustryRouter: {
    displayName: 'Auto Model',
    // Keep the existing Statsig key so rollout state is preserved.
    statsigName: 'alloy',
    defaultValue: false,
  },
  FigmaIntegration: {
    displayName: 'Figma Integration',
    statsigName: 'figma_integration',
    defaultValue: false,
  },
  RichFilePreviews: {
    displayName: 'Rich File Previews',
    statsigName: 'rich_file_previews',
    defaultValue: false,
  },
  MinimaxM3: {
    displayName: 'Drool Core (MiniMax M3)',
    statsigName: 'minimax_m3',
    defaultValue: false,
  },
  Connectors: {
    displayName: 'Connectors',
    statsigName: 'connectors',
    defaultValue: false,
  },
  AuditLogViewer: {
    displayName: 'Audit Log Viewer',
    statsigName: 'audit_log_viewer',
    defaultValue: false,
  },
  FolderTrustPrompt: {
    displayName: 'CLI Folder Trust Prompt',
    statsigName: 'folder_trust_prompt',
    defaultValue: false,
  },
  SessionSidebarV2: {
    displayName: 'Session Sidebar V2',
    statsigName: 'session_sidebar_v2',
    defaultValue: false,
  },
  SandboxEnterpriseControls: {
    displayName: 'Sandbox Enterprise Controls',
    statsigName: 'sandbox_enterprise_controls',
    defaultValue: false,
  },
};

/**
 * Recently retired feature flags whose CLI/UI gating has been removed but whose
 * `statsigName` must still be served (with the post-launch default) so older
 * clients in the wild keep treating the flag as launched. The backend feature
 * flag route iterates this map alongside `IndustryFeatureFlags`, and the
 * `industry/no-unused-feature-flags` ESLint rule only inspects
 * `IndustryFeatureFlags`, so entries here do not need an eslint-disable.
 *
 * Once all clients have rolled past the version that referenced the flag, the
 * entry can be deleted from this map outright.
 */
export const DEPRECATED_FEATURE_FLAGS: Record<string, IndustryFeatureFlag> = {
  // Launched in production; desktop browser pane gating has been removed.
  // Retained so older clients continue to receive the post-launch default.
  EmbeddedBrowserPane: {
    displayName: 'Embedded Browser Pane',
    statsigName: 'embedded_browser_pane',
    defaultValue: true,
  },
  // Launched in production; frontend pre-launch branches were removed in this
  // PR. Kept here so the backend `/feature-flags` route keeps returning the
  // post-launch default to older clients that still consult this flag.
  DiffViewer: {
    displayName: 'Diff Viewer',
    statsigName: 'diff_viewer',
    defaultValue: true,
  },
  // Launched in production; frontend pre-launch branches were removed in this
  // PR. Kept here so the backend `/feature-flags` route keeps returning the
  // post-launch default to older clients that still consult this flag.
  DesktopReskin: {
    displayName: 'Desktop Reskin',
    statsigName: 'desktop_reskin',
    defaultValue: true,
  },
  // Re-added after removal in #11933. The reskin is now the only UI, so this
  // flag defaults to true. Kept so the backend continues returning it for
  // older CLI versions that still gate on it.
  CliReskinV1: {
    displayName: 'CLI Reskin V1',
    statsigName: 'cli_reskin_v1',
    defaultValue: true,
  },
  // Launched in production; defaulted to true in CLI v0.104.0 (2026-04-27).
  // Backend gate retained until older CLI clients have upgraded past this version.
  Gpt53CodexFast: {
    displayName: 'GPT-5.3-Codex Fast Mode',
    statsigName: 'gpt_5_3_codex_fast',
    defaultValue: true,
  },
  Gpt54Fast: {
    displayName: 'GPT-5.4 Fast Mode',
    statsigName: 'gpt_5_4_fast',
    defaultValue: true,
  },
  Gpt54Mini: {
    displayName: 'GPT-5.4 Mini',
    statsigName: 'gpt_5_4_mini',
    defaultValue: true,
  },
  // Launched in production; defaulted to true in CLI v0.104.0 (2026-04-27).
  // Backend gate retained until older CLI clients have upgraded past this version.
  Glm51: {
    displayName: 'Drool Core (GLM-5.1)',
    statsigName: 'glm_5_1',
    defaultValue: true,
  },
  // Launched in production; defaulted to true in CLI v0.104.0 (2026-04-27).
  // Backend gate retained until older CLI clients have upgraded past this version.
  MinimaxM27: {
    displayName: 'Drool Core (MiniMax M2.7)',
    statsigName: 'minimax_m2_7',
    defaultValue: true,
  },
  // Launched in production; pre-launch branch removed from the Slack event
  // processor in this PR. Kept here so the backend `/feature-flags` route
  // keeps returning the post-launch default to any older clients that still
  // surface this flag value (CLI/web telemetry snapshots, settings UIs).
  SlackAutobacklinking: {
    displayName: 'Slack Auto-backlinking',
    statsigName: 'slack_autobacklinking',
    defaultValue: true,
  },
  // Launched in production; pre-launch branch removed from the Slack event
  // processor in this PR. Kept here so the backend `/feature-flags` route
  // keeps returning the post-launch default to any older clients that still
  // surface this flag value.
  SlackAutoRunHeadless: {
    displayName: 'Slack Auto-Run Headless Sessions',
    statsigName: 'slack_auto_run_headless',
    defaultValue: true,
  },
  // Launched in production; defaulted to true in CLI v0.104.0 (2026-04-27).
  // Pre-launch branch removed from `delegationHandler` in this PR (the
  // workspace selection modal is now always shown). Kept here so the backend
  // `/feature-flags` route keeps returning the post-launch default to any
  // older clients that still surface this flag value.
  SlackAlwaysShowWorkspaceModal: {
    displayName: 'Slack Always Show Workspace Modal',
    statsigName: 'slack_always_show_workspace_modal',
    defaultValue: true,
  },
  // Launched in production; `defaultValue` was flipped to true in CLI
  // v0.105.1 (PR #12377, 2026-04-21). Latest CLI on main as of this PR is
  // v0.112.0. Model registry no longer carries a `featureFlag`, but the
  // entry is retained here so the backend `/feature-flags` route keeps
  // returning the post-launch default to any older client that might still
  // consult this flag (e.g. fresh installs that haven't yet refreshed
  // remote flags from Statsig).
  ClaudeOpus47: {
    displayName: 'Claude Opus 4.7',
    statsigName: 'claude_opus_4_7',
    defaultValue: true,
  },
  // Launched in production; model registry no longer carries a `featureFlag`.
  // Retained so the backend `/feature-flags` route keeps returning the
  // post-launch default to older clients that still consult this flag.
  ClaudeOpus47Fast: {
    displayName: 'Claude Opus 4.7 Fast Mode',
    statsigName: 'claude_opus_4_7_fast',
    defaultValue: true,
  },
  // Launched in production; model registry no longer carries a `featureFlag`.
  // Retained so older clients continue to receive the post-launch default.
  Gpt55: {
    displayName: 'GPT-5.5',
    statsigName: 'gpt_5_5',
    defaultValue: true,
  },
  // Launched in production; model registry no longer carries a `featureFlag`.
  // Retained so older clients continue to receive the post-launch default.
  Gpt55Fast: {
    displayName: 'GPT-5.5 Fast Mode',
    statsigName: 'gpt_5_5_fast',
    defaultValue: true,
  },
  // Launched in production; model registry no longer carries a `featureFlag`.
  // Retained so older clients continue to receive the post-launch default.
  Gpt55Pro: {
    displayName: 'GPT-5.5 Pro',
    statsigName: 'gpt_5_5_pro',
    defaultValue: true,
  },
  // Launched in production; model registry no longer carries a `featureFlag`.
  // Retained so older clients continue to receive the post-launch default.
  KimiK26: {
    displayName: 'Drool Core (Kimi K2.6)',
    statsigName: 'kimi_k2_6',
    defaultValue: true,
  },
  // Launched in production; model registry no longer carries a `featureFlag`.
  // Retained so older clients continue to receive the post-launch default.
  DeepSeekV4Pro: {
    displayName: 'Drool Core (DeepSeek V4 Pro)',
    statsigName: 'deepseek_v4_pro',
    defaultValue: true,
  },
  // Launched in production; no runtime consumers remain. Retained so older
  // clients continue to receive the post-launch default.
  AnalyticsApi: {
    displayName: 'Analytics API',
    statsigName: 'analytics_api',
    defaultValue: true,
  },
  // Launched in production; no runtime consumers remain. Retained so older
  // clients continue to receive the post-launch default.
  DroolComputers: {
    displayName: 'Drool Computers',
    statsigName: 'drool_computers',
    defaultValue: true,
  },
  // Launched in production; Slack status messages now always include session
  // view buttons. Retained so older clients continue to receive the
  // post-launch default.
  SlackSessionViewButtons: {
    displayName: 'Slack Session View Buttons',
    statsigName: 'slack_session_view_buttons',
    defaultValue: true,
  },
  // Legacy provider-routing rollout flags. Provider selection now comes from
  // the assembled provider_routing dynamic config, but older clients still ask
  // for these flag names and should receive the previous safe defaults.
  UseAnthropicBedrock: {
    displayName: 'Use Anthropic Bedrock',
    statsigName: 'use_anthropic_bedrock',
    defaultValue: false,
  },
  UseAnthropicVertex: {
    displayName: 'Use Anthropic Vertex',
    statsigName: 'use_anthropic_vertex',
    defaultValue: false,
  },
  UseAzureGPT51: {
    displayName: 'Use Azure GPT-5.1',
    statsigName: 'use_azure_gpt-5.1',
    defaultValue: false,
  },
  UseAzureGPT51Codex: {
    displayName: 'Use Azure GPT-5.1-Codex',
    statsigName: 'use_azure_gpt-5.1-codex',
    defaultValue: false,
  },
  // Launched in production; defaulted to true in CLI v0.104.0 (2026-04-27).
  // Pre-launch CLI/web gating removed; the backend gate is retained for
  // older clients that still consult it.
  PluginsCommand: {
    displayName: 'Plugins Command',
    statsigName: 'plugins_command',
    defaultValue: true,
  },
  // Launched in production; defaulted to true in CLI v0.104.0 (2026-04-27).
  // CLI-side gate replaced with OTEL_CUSTOMER_ENABLED-aware always-on init.
  // Backend gate retained for older CLI clients.
  OtelTelemetryCollection: {
    displayName: 'OTEL Telemetry Collection',
    statsigName: 'otel_telemetry_collection',
    defaultValue: true,
  },
  // Launched in production; defaulted to true in CLI v0.104.0 (2026-04-27).
  // CLI-side gate removed so repo metadata is always emitted alongside OTEL.
  // Backend gate retained for older CLI clients.
  RepoMetadataTelemetry: {
    displayName: 'Repo Metadata Telemetry',
    statsigName: 'repo_metadata_telemetry',
    defaultValue: true,
  },
  // Launched in production; defaulted to true in CLI v0.104.0 (2026-04-27).
  // CLI-side gate removed so the install-qa skill is always advertised.
  // Backend gate retained for older CLI clients.
  InstallQa: {
    displayName: 'Install QA',
    statsigName: 'install_qa',
    defaultValue: true,
  },
  // Launched in production; defaulted to true in CLI v0.104.0 (2026-04-27).
  // CLI-side gate removed so the security-review skill is always advertised.
  // Backend gate retained for older CLI clients.
  SecurityReview: {
    displayName: 'Security Review',
    statsigName: 'security_review',
    defaultValue: true,
  },
  // Launched in production; defaulted to true in CLI v0.104.0 (2026-04-27).
  // CLI-side flag fetch removed; the freeform path is always taken from CLI.
  // Backend gate retained for older clients.
  ApplyPatchFreeform: {
    displayName: 'Apply Patch Freeform',
    statsigName: 'apply_patch_freeform',
    defaultValue: true,
  },
};

// Dynamic Config
const AllowedDroolModeToolsSchema = z.object({
  enableAll: z.boolean().default(false),
  enabledTools: z.array(z.string()).default([]),
});

const IndustryPsaBannerSchema = z.object({
  message: z.string().default(''),
  severity: z.enum(['info', 'warning']).default('info'),
  link: z.string().default(''),
  linkText: z.string().default(''),
});

const ModelDeprecationSchema = z.object({
  deprecatedModelId: z.string(),
  deprecationDate: z.string().default(''),
  replacementModelId: z.string().default(''),
});

const ModelDeprecationsSchema = z.object({
  deprecations: z.array(ModelDeprecationSchema).default([]),
});

const DefaultModelOverrideSchema = z.object({
  modelId: z.string().optional(),
  reasoningEffort: z
    .enum(['none', 'dynamic', 'off', 'low', 'medium', 'high'])
    .optional(),
});

const BannedSubstringsSchema = z.object({
  substrings: z.array(z.string()).default([]),
});

const MinIdeExtensionVersionSchema = z.object({
  version: z.string().default('0.2.0'),
});

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

const WorkspaceRebuildCutoffSchema = z.object({
  // Unix timestamp in milliseconds - workspaces built before this need rebuild
  // Default: 60 days ago
  cutoffMilliseconds: z.number().default(Date.now() - SIXTY_DAYS_MS),
});

const PerUserSandboxLimitsSchema = z.record(
  z.nativeEnum(IndustryTier),
  z.number().int().positive().default(20)
);

const ALLOWED_DROOL_MODE_TOOLS = 'allowed_drool_mode_tools' as const;
export const INDUSTRY_PSA_BANNER = 'industry_psa_banner' as const;
export const MODEL_DEPRECATIONS = 'model_deprecations' as const;
const DEFAULT_MODEL_OVERRIDE = 'default_model_override' as const;
export const BANNED_SUBSTRINGS = 'banned_substrings' as const;
export const MIN_IDE_EXTENSION_VERSION = 'min_ide_extension_version' as const;
export const WORKSPACE_REBUILD_CUTOFF_UTC_MILLISECONDS =
  'workspace_rebuild_cutoff_utc_milliseconds' as const;
export const PER_USER_SANDBOX_LIMITS =
  'per_user_sandbox_limits_by_tier' as const;
export const MAX_STANDARD_OVERAGE_LIMIT_OVERRIDE =
  'max_standard_overage_limit_override' as const;
export const DESKTOP_VERSION_REQUIREMENTS =
  'desktop_version_requirements' as const;
export const CLI_DEFAULT_SETTINGS = 'cli_default_settings' as const;
export const INDUSTRY_CLI_BANNER = 'industry_cli_banner' as const;
const DesktopVersionRequirementsSchema = z.object({
  minimumVersion: z.string().default('0.0.0'),
});

const IndustryCliBannerSchema = z.object({
  headerTitle: z.string().default(''),
  headerBody: z.string().default(''),
  footerTitle: z.string().default(''),
  footerBody: z.string().default(''),
});

const MinCliVersionSchema = z.object({
  version: z.string().default(''),
});

const MaxStandardOverageLimitOverrideSchema = z.record(
  z.string(),
  z.number().int().nonnegative()
);

/**
 * Schema for individual provider routing configs (provider_routing_anthropic, etc.).
 * Each config returns an ordered list of API providers for that family or model.
 * The first provider is the primary; the rest are fallbacks for error rotation.
 */
const ProviderRoutingConfigSchema = z.object({
  providers: z.array(z.nativeEnum(ApiProvider)).default([]),
});

/**
 * Assembled provider routing config returned to the CLI.
 * The backend evaluates per-family and per-model Statsig dynamic configs
 * (with percentage-based rollouts), then assembles this unified map.
 * The client never sees the underlying ratios.
 */
const ProviderRoutingSchema = z.object({
  version: z.number().default(1),
  defaults: z
    .record(z.string(), z.array(z.nativeEnum(ApiProvider)))
    .default({}),
  models: z.record(z.string(), z.array(z.nativeEnum(ApiProvider))).default({}),
});

export const PROVIDER_ROUTING = 'provider_routing' as const;
export const PROVIDER_ROUTING_ANTHROPIC = 'provider_routing_anthropic' as const;
export const PROVIDER_ROUTING_OPENAI = 'provider_routing_openai' as const;
export const PROVIDER_ROUTING_DROOL_CORE =
  'provider_routing_drool_core' as const;

/**
 * Maps ModelProvider to the corresponding provider_routing family key.
 * Used by both the backend (assembleProviderRouting) and CLI (resolveProviders)
 * to ensure family names stay in sync.
 */
export const PROVIDER_FAMILY_KEYS = {
  anthropic: 'anthropic',
  openai: 'openai',
  industry: 'industry',
} as const;

export const IP_OWNERSHIP_CLAIMS = 'ip_ownership_claims' as const;

// Each `ips` entry may be a literal IPv4 or a CIDR.
const IpOwnershipClaimSchema = z.object({
  orgId: z.string(),
  ips: z.array(z.string()),
});

export const IpOwnershipClaimsSchema = z.object({
  claims: z.array(IpOwnershipClaimSchema).default([]),
});

export const BACKEND_EGRESS_IPS = 'backend_egress_ips' as const;

// The Industry backend's own Vercel static egress IPs, keyed by IndustryRegion.
// These are always allowed through an org's IP allowlist so backend-to-backend
// traffic (e.g. automations calling the sessions API) is not blocked by a
// customer's network policy. Region keys are validated against IndustryRegion;
// IP entries are plain strings validated and matched by `compileIpRanges`
// (literal IPv4 or CIDR), which skips malformed entries per-entry rather than
// failing the whole config (mirrors `ip_ownership_claims`).
export const BackendEgressIpsSchema = z.object({
  byRegion: z
    .record(z.nativeEnum(IndustryRegion), z.array(z.string()))
    .default({}),
});

export const MIN_CLI_VERSION = 'min_cli_version' as const;
export const DYNAMIC_CONFIG_SCHEMAS = {
  [ALLOWED_DROOL_MODE_TOOLS]: AllowedDroolModeToolsSchema,
  [INDUSTRY_PSA_BANNER]: IndustryPsaBannerSchema,
  [MODEL_DEPRECATIONS]: ModelDeprecationsSchema,
  [DEFAULT_MODEL_OVERRIDE]: DefaultModelOverrideSchema,
  [BANNED_SUBSTRINGS]: BannedSubstringsSchema,
  [MIN_IDE_EXTENSION_VERSION]: MinIdeExtensionVersionSchema,
  [WORKSPACE_REBUILD_CUTOFF_UTC_MILLISECONDS]: WorkspaceRebuildCutoffSchema,
  [PER_USER_SANDBOX_LIMITS]: PerUserSandboxLimitsSchema,
  [MAX_STANDARD_OVERAGE_LIMIT_OVERRIDE]: MaxStandardOverageLimitOverrideSchema,
  [DESKTOP_VERSION_REQUIREMENTS]: DesktopVersionRequirementsSchema,
  [CLI_DEFAULT_SETTINGS]: ManagedSettingsSchema,
  [INDUSTRY_CLI_BANNER]: IndustryCliBannerSchema,
  [MIN_CLI_VERSION]: MinCliVersionSchema,
  [PROVIDER_ROUTING]: ProviderRoutingSchema,
  [PROVIDER_ROUTING_ANTHROPIC]: ProviderRoutingConfigSchema,
  [PROVIDER_ROUTING_OPENAI]: ProviderRoutingConfigSchema,
  [PROVIDER_ROUTING_DROOL_CORE]: ProviderRoutingConfigSchema,
  [IP_OWNERSHIP_CLAIMS]: IpOwnershipClaimsSchema,
  [BACKEND_EGRESS_IPS]: BackendEgressIpsSchema,
} as const;
