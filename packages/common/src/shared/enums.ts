/**
 * OTel service.name values. Identifies the deployable process/binary,
 * not the user interaction mode (see ClientUiSurface for that).
 */
export enum ServiceName {
  WebDesktop = 'web-desktop', // Electron Desktop
  WebApp = 'web-app', // Assembly V3
  WebWorkspace = 'web-workspace',
  Daemon = 'daemon',
  CLI = 'cli', // both interactive and exec mode
  Backend = 'backend', // Next.js backend API
}

/** @deprecated Use {@link ServiceName} instead. */
export enum ClientType {
  WebDesktop = 'web-desktop',
  WebApp = 'web-app',
  WebWorkspace = 'web-workspace',
  Daemon = 'daemon',
  CLI = 'cli',
  Backend = 'backend',
}

export enum DroolMode {
  TerminalUI = 'terminal-ui',
  NonInteractiveCLI = 'non-interactive-cli',
  InteractiveCLI = 'interactive-cli',
  /** deprecated: headless will soon be decommissioned */
  Headless = 'headless',
}

/**
 * Sub-mode discriminator for InteractiveCLI mode.
 * Used to differentiate between JSON-RPC (daemon/web) and ACP (Zed) protocols.
 */
export enum DroolSubMode {
  JsonRpc = 'json-rpc',
  ACP = 'acp',
}

export enum ExternalDependency {
  ANTHROPIC = 'anthropic',
  BEDROCK = 'bedrock',
  CONFLUENCE = 'confluence',
  FIGMA = 'figma',
  FIRECRAWL = 'firecrawl',
  GEMINI = 'gemini',
  GITHUB = 'github',
  GITHUB_ES = 'github-es',
  GITLAB = 'gitlab',
  GITLAB_SH = 'gitlab-sh',
  GOOGLE_DOCS = 'google-docs',
  GOOGLE_OAUTH = 'google-oauth',
  JIRA = 'jira',
  LINEAR = 'linear',
  LOOPS = 'loops',
  MONGODB = 'mongodb',
  NOTION = 'notion',
  OPENAI = 'openai',
  SLACK = 'slack',
  STATSIG = 'statsig',
  VOYAGE = 'voyage',
  WEAVIATE = 'weaviate',
  SENTRY = 'sentry',
  STRIPE = 'stripe',
  XAI = 'xai',
  PAGERDUTY = 'pagerduty',
  EXA = 'exa',
  WORKOS = 'workos',
  YOU = 'you',
  PARALLEL = 'parallel',
  UNKNOWN = 'unknown',
}

/**
 * WebSocket Close Codes
 * @see https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent/code
 */
export enum WebSocketCloseCode {
  NORMAL_CLOSURE = 1000,
  GOING_AWAY = 1001,
  PROTOCOL_ERROR = 1002,
  UNSUPPORTED_DATA = 1003,
  NO_STATUS_RECEIVED = 1005,
  ABNORMAL_CLOSURE = 1006,
  INVALID_FRAME_PAYLOAD = 1007,
  POLICY_VIOLATION = 1008,
  MESSAGE_TOO_BIG = 1009,
  INTERNAL_ERROR = 1011,
}

/**
 * Relay-specific WebSocket close codes.
 * RFC 6455 reserves 4000-4999 for application use.
 */
export enum RelayCloseCode {
  ComputerOffline = 4000,
  ComputerDisconnected = 4001,
  MalformedEnvelope = 4002,
  DuplicateComputer = 4003,
  AuthTimeout = 4004,
  Unauthorized = 4005,
  RelayShuttingDown = 4006,
  ComputerPongTimeout = 4007,
  ComputerSendStalled = 4008,
}

/**
 * Supported operating system platforms
 */
export enum Platform {
  Darwin = 'darwin',
  Windows = 'win32',
  Linux = 'linux',
}

export enum AppErrorAction {
  CheckNetwork = 'check_network',
}

/**
 * Industry deployment region for data-residency isolation.
 *
 * - Global: combined deployment (cross-region webhooks/login/crons)
 * - Eu: EU-isolated deployment for `eu_`-prefixed orgs
 */
export enum IndustryRegion {
  Global = 'global',
  Eu = 'eu',
}
