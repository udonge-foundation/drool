import { DeploymentEnv, IndustryEnv } from '@industry/common/environment';

/**
 * Directory name for Industry config/data based on environment.
 */
export const INDUSTRY_ENV_DIRS: Record<IndustryEnv, string> = {
  [IndustryEnv.Development]: '.industry-dev',
  [IndustryEnv.Production]: '.industry',
};

/**
 * Runtime environment variable names.
 */
export const EnvironmentVariable = {
  // Core Industry environment
  INDUSTRY_ENV: 'INDUSTRY_ENV',
  INDUSTRY_DEPLOYMENT_ENV: 'INDUSTRY_DEPLOYMENT_ENV',
  INDUSTRY_API_BASE_URL: 'INDUSTRY_API_BASE_URL',
  INDUSTRY_API_BASE_URL_EU: 'INDUSTRY_API_BASE_URL_EU',
  INDUSTRY_APP_BASE_URL: 'INDUSTRY_APP_BASE_URL',
  INDUSTRY_DOWNLOADS_BUCKET: 'INDUSTRY_DOWNLOADS_BUCKET',
  INDUSTRY_DOWNLOADS_PREFIX: 'INDUSTRY_DOWNLOADS_PREFIX',
  INDUSTRY_PUBLIC_DOWNLOADS_BASE_URL: 'INDUSTRY_PUBLIC_DOWNLOADS_BASE_URL',
  INDUSTRY_DROOL_AUTO_UPDATE_ENABLED: 'INDUSTRY_DROOL_AUTO_UPDATE_ENABLED',
  // Force-disable Ink incremental rendering in the CLI regardless of
  // deployment environment or feature flag state. Used by e2e tests and as a
  // runtime escape hatch. Consumed via apps/cli getEnv().extras.
  INDUSTRY_DISABLE_INCREMENTAL_RENDERING:
    'INDUSTRY_DISABLE_INCREMENTAL_RENDERING',
  INDUSTRY_RUNTIME_SETTINGS_PATH: 'INDUSTRY_RUNTIME_SETTINGS_PATH',
  INDUSTRY_APPEND_SYSTEM_PROMPT: 'INDUSTRY_APPEND_SYSTEM_PROMPT',
  // Override path to an external rg/rg.exe binary. Used in locked-down
  // environments (e.g. corporate machines) where the bundled binary under
  // ~/.industry/bin is blocked by AV/EDR; point this at an allowlisted rg
  // (typically @vscode/ripgrep's rgPath under node_modules).
  INDUSTRY_RIPGREP_PATH: 'INDUSTRY_RIPGREP_PATH',
  // Override path to an external agent-browser binary/package root.
  // Accepts an absolute path to either the binary itself or the package root
  // directory (e.g. <node_modules>/agent-browser).
  INDUSTRY_AGENT_BROWSER_PATH: 'INDUSTRY_AGENT_BROWSER_PATH',
  // Override path to an external keytar.node native module.
  // Accepts an absolute path to either the .node file itself or the package
  // root directory (e.g. <node_modules>/keytar).
  INDUSTRY_KEYTAR_PATH: 'INDUSTRY_KEYTAR_PATH',
  // Path to a node_modules directory containing pre-installed versions of
  // Industry's packaged dependencies (@vscode/ripgrep, agent-browser, keytar).
  // When set, each dependency is resolved at its canonical sub-path under
  // this directory. Per-dep overrides (INDUSTRY_RIPGREP_PATH, etc.) take
  // precedence when set.
  INDUSTRY_NPM_MODULES_DIR: 'INDUSTRY_NPM_MODULES_DIR',

  // Auth
  INDUSTRY_API_KEY: 'INDUSTRY_API_KEY', // API key authentication
  INDUSTRY_WORKOS_BASE_URL: 'INDUSTRY_WORKOS_BASE_URL', // Override WorkOS API base URL (testing)

  // Keyring
  INDUSTRY_DISABLE_KEYRING: 'INDUSTRY_DISABLE_KEYRING',

  // Logging / Telemetry
  // Override the on-disk destination for the CLI telemetry log
  // (`drool-log-single.log`). When set, rotation still applies to the
  // resolved path: the engine archives sibling `<path>.YYYY-MM-DD[.N]`
  // files alongside the target. Point this at a dedicated log file,
  // not at a shared/important file.
  INDUSTRY_LOG_FILE: 'INDUSTRY_LOG_FILE',
  // Per-fragment size cap (bytes). When the active log file crosses
  // this threshold within a single day it is rotated to a new
  // within-day fragment. Falsy / non-numeric / negative input falls
  // back to the per-file default (25 MB for `console.log`, 100 MB for
  // `drool-log-single.log`).
  INDUSTRY_LOG_MAX_BYTES: 'INDUSTRY_LOG_MAX_BYTES',
  // Maximum number of distinct days of logs to retain. Cleanup prunes
  // the oldest day's fragments in full. Default: 30.
  INDUSTRY_LOG_MAX_DAYS: 'INDUSTRY_LOG_MAX_DAYS',
  // Maximum total bytes of logs (active + archives) to retain on disk.
  // Cleanup prunes oldest-day-first, never partial days, so the
  // retained window has no gaps inside a day. Default: 1 GB.
  INDUSTRY_LOG_MAX_TOTAL_BYTES: 'INDUSTRY_LOG_MAX_TOTAL_BYTES',
  INDUSTRY_TELEMETRY_INGEST_BASE_URL: 'INDUSTRY_TELEMETRY_INGEST_BASE_URL',
  // When set (truthy or a file path), @industry/drool-sdk appends all
  // JSON-RPC traffic flowing to/from spawned `drool exec` processes to a
  // `drool-transport.log` file under the active logs directory.
  INDUSTRY_DROOL_SDK_TRANSPORT_LOG: 'INDUSTRY_DROOL_SDK_TRANSPORT_LOG',

  // Upstream client type: when the daemon spawns a worker process, it
  // forwards the caller's ClientType (e.g. 'web-desktop', 'web-app') so the
  // worker sets the correct X-Industry-Client header on backend API calls.
  INDUSTRY_UPSTREAM_CLIENT_TYPE: 'INDUSTRY_UPSTREAM_CLIENT_TYPE',

  // Desktop CDP (Chrome DevTools Protocol) port and agent-browser endpoint for embedded browser pane
  INDUSTRY_DESKTOP_CDP_PORT: 'INDUSTRY_DESKTOP_CDP_PORT',
  AGENT_BROWSER_CDP: 'AGENT_BROWSER_CDP',
  AGENT_BROWSER_SESSION: 'AGENT_BROWSER_SESSION',

  // Daemon-specific
  INDUSTRYD_VERSION: 'INDUSTRYD_VERSION',
  INDUSTRYD_DISABLE_AUTO_UPDATE: 'INDUSTRYD_DISABLE_AUTO_UPDATE',
  INDUSTRY_OTEL_ENABLED: 'INDUSTRY_OTEL_ENABLED',
  ROLLBACK_ENABLED: 'ROLLBACK_ENABLED',
  REMOTE_MACHINE_ID: 'REMOTE_MACHINE_ID',
  INDUSTRY_MACHINE_TYPE: 'INDUSTRY_MACHINE_TYPE',

  // Relay-specific
  INDUSTRY_RELAY_PORT: 'INDUSTRY_RELAY_PORT',
  INDUSTRY_RELAY_HOST: 'INDUSTRY_RELAY_HOST',
  INDUSTRY_RELAY_DEBUG: 'INDUSTRY_RELAY_DEBUG',
  INDUSTRY_RELAY_BASE_URL: 'INDUSTRY_RELAY_BASE_URL',
  INDUSTRY_RELAY_AUTH_TIMEOUT_MS: 'INDUSTRY_RELAY_AUTH_TIMEOUT_MS',

  // Set by systemd when launching a unit with `Type=notify`. Its
  // presence indicates the process should emit `sd_notify` state
  // (READY=1, STOPPING=1, ...) via `systemd-notify(1)`. See
  // `apps/cli/src/services/daemon/notifyReady.ts`.
  NOTIFY_SOCKET: 'NOTIFY_SOCKET',

  // System environment variables (for centralized access)
  HOME: 'HOME',
  USERPROFILE: 'USERPROFILE',
  SHELL: 'SHELL',
  COMSPEC: 'COMSPEC',
  TERMINAL_SHELL: 'TERMINAL_SHELL',
  NODE_ENV: 'NODE_ENV',
  TMUX: 'TMUX',

  // Mission worker
  MISSION_WORKER_INACTIVITY_TIMEOUT_MS: 'MISSION_WORKER_INACTIVITY_TIMEOUT_MS',

  // Host-app override for Local/Computer daemon session timeout.
  OVERRIDE_DROOL_SESSION_TIMEOUT_MS: 'OVERRIDE_DROOL_SESSION_TIMEOUT_MS',

  // Vercel / Next.js
  VERCEL_ENV: 'VERCEL_ENV',
  VERCEL_URL: 'VERCEL_URL',
  VERCEL_GIT_COMMIT_SHA: 'VERCEL_GIT_COMMIT_SHA',
  VERCEL_GIT_COMMIT_REF: 'VERCEL_GIT_COMMIT_REF',
  NEXT_RUNTIME: 'NEXT_RUNTIME',
  NEXT_PUBLIC_ENV: 'NEXT_PUBLIC_ENV',

  // Vite
  VITE_VERCEL_ENV: 'VITE_VERCEL_ENV',
  VITE_BACKEND_API_HOST: 'VITE_BACKEND_API_HOST',
  VITE_DAEMON_PORT: 'VITE_DAEMON_PORT',
  VITE_WORKOS_CLIENT_ID: 'VITE_WORKOS_CLIENT_ID',
  VITE_GA_MEASUREMENT_ID: 'VITE_GA_MEASUREMENT_ID',

  // AWS
  AWS_ACCESS_KEY_ID: 'AWS_ACCESS_KEY_ID',
  AWS_SECRET_ACCESS_KEY: 'AWS_SECRET_ACCESS_KEY',
  AWS_DROOL_EXECUTE_QUEUE_URL: 'AWS_DROOL_EXECUTE_QUEUE_URL',
  AWS_ORG_EVENTS_QUEUE_URL: 'AWS_ORG_EVENTS_QUEUE_URL',

  // GCP / Firebase
  GCLOUD_PROJECT: 'GCLOUD_PROJECT',
  GCP_PROJECT: 'GCP_PROJECT',
  GCP_PROJECT_ID: 'GCP_PROJECT_ID',
  GCP_BIGQUERY_SERVICE_ACCOUNT_EMAIL: 'GCP_BIGQUERY_SERVICE_ACCOUNT_EMAIL',
  GOOGLE_APPLICATION_CREDENTIALS: 'GOOGLE_APPLICATION_CREDENTIALS',
  FIRESTORE_EMULATOR_HOST: 'FIRESTORE_EMULATOR_HOST',
  INDUSTRY_FIRESTORE_ORG_ID: 'INDUSTRY_FIRESTORE_ORG_ID',
  NEXT_PUBLIC_FIREBASE_API_KEY: 'NEXT_PUBLIC_FIREBASE_API_KEY',
  NEXT_PUBLIC_FIREBASE_APP_ID: 'NEXT_PUBLIC_FIREBASE_APP_ID',
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID: 'NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID',
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:
    'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
  NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'NEXT_PUBLIC_USE_FIREBASE_EMULATOR',

  // Integrations
  GITHUB_APP_ID: 'GITHUB_APP_ID',
  GITHUB_APP_ID_INTERNAL: 'GITHUB_APP_ID_INTERNAL',
  NEXT_PUBLIC_GITHUB_ENTERPRISE_WEBHOOK:
    'NEXT_PUBLIC_GITHUB_ENTERPRISE_WEBHOOK',
  NEXT_PUBLIC_GITLAB_CLIENT_ID: 'NEXT_PUBLIC_GITLAB_CLIENT_ID',
  GITLAB_WEBHOOK_URL: 'GITLAB_WEBHOOK_URL',
  NEXT_PUBLIC_SLACK_CLIENT_ID: 'NEXT_PUBLIC_SLACK_CLIENT_ID',
  SLACK_CLIENT_SECRET: 'SLACK_CLIENT_SECRET',
  SLACK_SIGNING_SECRET: 'SLACK_SIGNING_SECRET',
  SLACK_WEBHOOK_URL: 'SLACK_WEBHOOK_URL',
  NEXT_PUBLIC_LINEAR_CLIENT_ID: 'NEXT_PUBLIC_LINEAR_CLIENT_ID',
  LINEAR_CLIENT_SECRET: 'LINEAR_CLIENT_SECRET',
  LINEAR_WEBHOOK_SECRET: 'LINEAR_WEBHOOK_SECRET',
  NEXT_PUBLIC_JIRA_CLIENT_ID: 'NEXT_PUBLIC_JIRA_CLIENT_ID',
  JIRA_WEBHOOK_URL: 'JIRA_WEBHOOK_URL',
  NEXT_PUBLIC_CONFLUENCE_CLIENT_ID: 'NEXT_PUBLIC_CONFLUENCE_CLIENT_ID',
  NEXT_PUBLIC_NOTION_CLIENT_ID: 'NEXT_PUBLIC_NOTION_CLIENT_ID',
  NEXT_PUBLIC_PAGERDUTY_CLIENT_ID: 'NEXT_PUBLIC_PAGERDUTY_CLIENT_ID',

  // Sentry
  NEXT_PUBLIC_ENABLE_SENTRY: 'NEXT_PUBLIC_ENABLE_SENTRY',
  NEXT_PUBLIC_SENTRY_ENV: 'NEXT_PUBLIC_SENTRY_ENV',
  NEXT_PUBLIC_SENTRY_CLIENT_ID: 'NEXT_PUBLIC_SENTRY_CLIENT_ID',

  // Third-party services
  LOOPS_API_KEY: 'LOOPS_API_KEY',
  PROXY_FUNCTION_URL: 'PROXY_FUNCTION_URL',
  TICKET_TO_PR_WORKFLOW_ID: 'TICKET_TO_PR_WORKFLOW_ID',
  VOYAGE_API_KEY: 'VOYAGE_API_KEY',
  OPENAI_API_KEY: 'OPENAI_API_KEY',
  SENTRY_DSN: 'SENTRY_DSN',
  ALGOLIA_APP_ID: 'ALGOLIA_APP_ID',
  ALGOLIA_API_KEY: 'ALGOLIA_API_KEY',
  NEXT_PUBLIC_GIT_PROXY_ADDRESS: 'NEXT_PUBLIC_GIT_PROXY_ADDRESS',
  NEXT_PUBLIC_STATSIG_SDK_KEY: 'NEXT_PUBLIC_STATSIG_SDK_KEY',
  NEXT_PUBLIC_WORKOS_CLIENT_ID: 'NEXT_PUBLIC_WORKOS_CLIENT_ID',

  // Weaviate
  WEAVIATE_URL: 'WEAVIATE_URL',
  WEAVIATE_API_KEY: 'WEAVIATE_API_KEY',
  WEAVIATE_COLLECTION_NAME: 'WEAVIATE_COLLECTION_NAME',

  // SendGrid
  SENDGRID_INVITE_USER_TEMPLATE_ID: 'SENDGRID_INVITE_USER_TEMPLATE_ID',
  SENDGRID_CREATE_ORG_ADMIN_TEMPLATE_ID:
    'SENDGRID_CREATE_ORG_ADMIN_TEMPLATE_ID',
  SENDGRID_INVITE_ORG_TEMPLATE_ID: 'SENDGRID_INVITE_ORG_TEMPLATE_ID',
  SENDGRID_VERIFY_EMAIL_TEMPLATE_ID: 'SENDGRID_VERIFY_EMAIL_TEMPLATE_ID',
  SENDGRID_PASSWORD_RESET_TEMPLATE_ID: 'SENDGRID_PASSWORD_RESET_TEMPLATE_ID',

  // Twilio
  TWILIO_ACCOUNT_SID: 'TWILIO_ACCOUNT_SID',
  TWILIO_VERIFY_SERVICE_SID: 'TWILIO_VERIFY_SERVICE_SID',

  // Admin-specific
  ADMIN_VERIFY_TIMEOUT_MS: 'ADMIN_VERIFY_TIMEOUT_MS',
  EXPORT_API_SECRET: 'EXPORT_API_SECRET',
  CRON_SECRET: 'CRON_SECRET',
  FRAUD_DETECTION_PRODUCTION_PROJECT_ID:
    'FRAUD_DETECTION_PRODUCTION_PROJECT_ID',
  FRAUD_DETECTION_PRODUCTION_CLIENT_EMAIL:
    'FRAUD_DETECTION_PRODUCTION_CLIENT_EMAIL',
  FRAUD_DETECTION_PRODUCTION_PRIVATE_KEY:
    'FRAUD_DETECTION_PRODUCTION_PRIVATE_KEY',

  // Signal-specific
  BQ_DATASET_ID: 'BQ_DATASET_ID',

  // Axiom
  AXIOM_API_TOKEN: 'AXIOM_API_TOKEN',
  AXIOM_DATASET_LOGS: 'AXIOM_DATASET_LOGS',
  AXIOM_DATASET_LOGS_V2: 'AXIOM_DATASET_LOGS_V2',
  AXIOM_DATASET_METRICS: 'AXIOM_DATASET_METRICS',
  AXIOM_DATASET_METRICS_V2: 'AXIOM_DATASET_METRICS_V2',
  AXIOM_DATASET_TRACES: 'AXIOM_DATASET_TRACES',

  // WorkOS (server-side)
  WORKOS_CLIENT_ID: 'WORKOS_CLIENT_ID',

  // E2E / Test
  E2E_MOCK_LLM: 'E2E_MOCK_LLM',
  VITEST_WORKER_ID: 'VITEST_WORKER_ID',
  TESTING_BYPASS_TOKEN_PASSWORD: 'TESTING_BYPASS_TOKEN_PASSWORD',
  INDUSTRY_DISABLE_DYNAMIC_CONFIG: 'INDUSTRY_DISABLE_DYNAMIC_CONFIG',
  INDUSTRY_FEATURE_FLAGS_SNAPSHOT_PATH: 'INDUSTRY_FEATURE_FLAGS_SNAPSHOT_PATH',
  INDUSTRY_FEATURE_FLAGS_OVERRIDES: 'INDUSTRY_FEATURE_FLAGS_OVERRIDES',

  // Agent readiness
  // Enables the store_agent_readiness_report tool even when the current
  // drool is not AGENT_READINESS and enabledToolIds does not include it.
  // Consumed by @industry/services/app/config via AppConfig.enableReadinessReport.
  // Set by apps/scripts/src/readiness-benchmarks (consistency tests) and
  // apps/backend sandbox creation when the readiness flow is requested.
  ENABLE_READINESS_REPORT: 'ENABLE_READINESS_REPORT',
} as const;

/**
 * Default values for test environments.
 * Used when NODE_ENV=test and no explicit values are provided.
 * @public
 */
export const TEST_DEFAULTS = {
  env: IndustryEnv.Development,
  deploymentEnv: DeploymentEnv.Development,
  apiBaseUrl: 'https://test.api.example.com',
  apiBaseUrlEu: 'https://test.api.eu.example.com',
  appBaseUrl: 'https://test.example.com',
  downloadsBucket: 'test-downloads.example.com',
  downloadsPathPrefix: '',
} as const;
