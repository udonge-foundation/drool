/**
 * Default settings constants for hierarchical settings resolution
 */
import { ModelID, ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import { AutonomyMode } from '@industry/drool-sdk-ext/protocol/shared';

import {
  BuiltInThemeName,
  DiffMode,
  SoundFocusMode,
  SubagentSoundMode,
  TodoDisplayMode,
} from './enums';
import { LogoAnimationMode, ToolResultDisplay } from '../cli/enums';
import {
  DEFAULT_COMMAND_BLOCKLIST,
  DEFAULT_COMMAND_DENYLIST,
} from '../policy/constants';

import type { GeneralSettings, RegistryServer } from './types';

export const CURRENT_COMPACTION_MODEL = 'current-model';

/** Sized comparably to a trimmed user message in the classifier context budget. */
export const INDUSTRY_ROUTER_GUIDANCE_MAX_LENGTH = 2000;
export const INDUSTRY_ROUTER_RULES_MAX_COUNT = 20;
export const INDUSTRY_ROUTER_RULE_WHEN_MAX_LENGTH = 300;
export const INDUSTRY_ROUTER_RULE_GUIDANCE_MAX_LENGTH = 600;

/** Former default value retained only for the existing daemon request adapter. */
export const LEGACY_INDUSTRY_DEFAULT_COMPACTION_MODEL =
  ModelID.CLAUDE_SONNET_4_5;

/**
 * Hard upper bound on a custom notification sound's byte size. Shared by
 * the renderer (IndexedDB blob store) and the desktop main process
 * (audioBridge allow-list) so both platforms reject the same files.
 */
export const CUSTOM_SOUND_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Allowed extensions for user-provided notification sounds. The leading
 * dot is included so callers can compare against `path.extname(...)` /
 * `'.' + ext` without re-prepending it.
 */
export const CUSTOM_SOUND_EXTENSIONS = [
  '.wav',
  '.mp3',
  '.ogg',
  '.m4a',
  '.aac',
  '.flac',
] as const;

/** MIME type for each allowed extension. */
export const CUSTOM_SOUND_MIME_BY_EXT: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

/**
 * Default AWS region for Bedrock-routed BYOK custom models when neither
 * `customModels[].bedrock.awsRegion` nor the standard AWS_* env vars supply
 * one. Set to `us-west-1` rather than the Anthropic SDK's own `us-east-1`
 * default because Anthropic models on Bedrock are hosted in
 * `us-west-2`/`us-west-1` for most accounts.
 */
export const LLM_BEDROCK_DEFAULT_REGION = 'us-west-1';

/**
 * Default allowed commands - minimal safe commands
 */
export const DEFAULT_COMMAND_ALLOWLIST = [
  'ls',
  'pwd',
  'dir',
  'git status',
  'git diff',
  'git log',
  'git show',
  'git blame',
  'git ls-files',
];

// =============================================================================
// Default General Settings
// =============================================================================

/**
 * MCP registry servers available in the CLI and enterprise controls UI.
 * This is the single source of truth; CLI helpers and frontend derive from this.
 */
export const REGISTRY_SERVERS: RegistryServer[] = [
  {
    name: 'sentry',
    description: 'Error tracking and performance monitoring.',
    type: 'http',
    url: 'https://mcp.sentry.dev/mcp',
  },
  {
    name: 'socket',
    description: 'Security analysis for dependencies.',
    type: 'http',
    url: 'https://mcp.socket.dev/',
  },
  {
    name: 'hugging-face',
    description:
      'Access Hugging Face Hub information and Gradio AI Applications.',
    type: 'http',
    url: 'https://huggingface.co/mcp',
  },
  {
    name: 'jam',
    description:
      'Debug faster with AI agents that can access Jam recordings like video, console logs, network requests, and errors.',
    type: 'http',
    url: 'https://mcp.jam.dev/mcp',
  },
  {
    name: 'context7',
    description: 'Up-to-date code documentation.',
    type: 'http',
    url: 'https://mcp.context7.com/mcp',
  },
  {
    name: 'braintrust',
    description:
      'Access to the documentation, experiments, and logs in Braintrust.',
    type: 'http',
    url: 'https://api.braintrust.dev/mcp',
  },
  {
    name: 'honeycomb',
    description: 'Query observability data and SLOs.',
    type: 'http',
    url: 'https://mcp.honeycomb.io/mcp',
  },
  {
    name: 'playwright',
    description: 'End-to-end browser testing.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    note: "Requires npx (Node.js) to be installed. In Mission mode, add '--isolated' manually to args to prevent session intervention",
  },
  {
    name: 'endor-labs',
    description: 'Security risk insights for code.',
    type: 'stdio',
    command: 'endorctl',
    args: ['ai-tools', 'mcp-server'],
    note: 'Requires endorctl CLI to be installed',
  },
  {
    name: 'semgrep',
    description: 'Scan code for security vulnerabilities.',
    type: 'http',
    url: 'https://mcp.semgrep.ai/mcp',
  },
  {
    name: 'snyk',
    description: 'Vulnerability scanning of your codebase.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'snyk@latest', 'mcp', '-t', 'stdio'],
    note: 'Requires npx (Node.js) to be installed',
  },
  {
    name: 'intercom',
    description:
      'Access real-time customer conversations, tickets, and user data.',
    type: 'http',
    url: 'https://mcp.intercom.com/mcp',
  },
  {
    name: 'linear',
    description: 'Issue tracking and project management for development teams.',
    type: 'http',
    url: 'https://mcp.linear.app/mcp',
  },
  {
    name: 'notion',
    description:
      'All-in-one workspace for notes, docs, and project management.',
    type: 'http',
    url: 'https://mcp.notion.com/mcp',
  },
  {
    name: 'box',
    description:
      'Ask questions about your enterprise content, get insights from unstructured data, automate content workflows.',
    type: 'http',
    url: 'https://mcp.box.com/',
  },
  {
    name: 'fireflies',
    description:
      'Extract valuable insights from meeting transcripts and summaries.',
    type: 'http',
    url: 'https://api.fireflies.ai/mcp',
  },
  {
    name: 'monday',
    description:
      'Manage monday.com boards by creating items, updating columns, assigning owners, setting timelines, adding CRM activities, and writing summaries.',
    type: 'http',
    url: 'https://mcp.monday.com/mcp',
  },
  {
    name: 'axiom',
    description:
      'Query observability data stored in Axiom, inspect metrics, traces, and logs.',
    type: 'http',
    url: 'https://mcp.axiom.co/mcp',
  },
  {
    name: 'clickup',
    description: 'Project management and collaboration for teams & agents.',
    type: 'http',
    url: 'https://mcp.clickup.com/mcp',
  },
  {
    name: 'astro-docs',
    description:
      'This server provides up-to-date access to the official Astro documentation.',
    type: 'http',
    url: 'https://mcp.docs.astro.build/mcp',
  },
  {
    name: 'apify',
    description:
      'Extract data from any website with thousands of scrapers, crawlers, and automations.',
    type: 'http',
    url: 'https://mcp.apify.com',
  },
  {
    name: 'atlassian',
    description:
      'Project management and collaboration tools including Jira and Confluence.',
    type: 'http',
    url: 'https://mcp.atlassian.com/v1/mcp',
  },
  {
    name: 'daloopa',
    description:
      'Supplies high quality fundamental financial data sourced from SEC Filings, investor presentations.',
    type: 'http',
    url: 'https://mcp.daloopa.com/server/mcp',
  },
  {
    name: 'supabase',
    description: 'Create and manage Supabase projects.',
    type: 'http',
    url: 'https://mcp.supabase.com/mcp',
  },
  {
    name: 'prisma',
    description:
      'Manage Prisma Postgres databases, including creating new instances and running schema migrations.',
    type: 'http',
    url: 'https://mcp.prisma.io/mcp',
  },
  {
    name: 'mongodb',
    description: 'Manage MongoDB data and deployments.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mongodb-mcp-server'],
    note: 'Requires npx (Node.js) to be installed',
  },
  {
    name: 'instantdb',
    description: 'Query and manage InstantDB.',
    type: 'http',
    url: 'https://mcp.instantdb.com/mcp',
  },
  {
    name: 'neon',
    description: 'Manage Neon Postgres.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://mcp.neon.tech/mcp'],
    note: 'Requires npx (Node.js) to be installed',
  },
  {
    name: 'adyen',
    description:
      'Payment processing, merchant management, terminals, and webhooks for Adyen.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@adyen/mcp', '--adyenApiKey=ADYEN_API_KEY', '--env=TEST'],
    note: "Requires npx (Node.js) to be installed. Replace ADYEN_API_KEY before use; for LIVE also add '--livePrefix=YOUR_PREFIX_URL'.",
  },
  {
    name: 'paypal',
    description: 'Payment APIs.',
    type: 'http',
    url: 'https://mcp.paypal.com/mcp',
  },
  {
    name: 'stripe',
    description: 'Payment processing APIs.',
    type: 'http',
    url: 'https://mcp.stripe.com',
  },
  {
    name: 'shopify',
    description: 'Shopify app development tools.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@shopify/dev-mcp@latest'],
    note: 'Requires npx (Node.js) to be installed',
  },
  {
    name: 'figma',
    description: 'Design and collaboration platform for teams.',
    type: 'http',
    url: 'https://mcp.figma.com/mcp',
  },
  {
    name: 'canva',
    description:
      'Browse, summarize, autofill, and even generate new Canva designs.',
    type: 'http',
    url: 'https://mcp.canva.com/mcp',
  },
  {
    name: 'wix',
    description: 'Build and manage Wix sites.',
    type: 'http',
    url: 'https://mcp.wix.com/mcp',
  },
  {
    name: 'sanity',
    description:
      'Create, query, and manage Sanity content, releases, datasets, and schemas.',
    type: 'http',
    url: 'https://mcp.sanity.io',
  },
  {
    name: 'netlify',
    description: 'Build and deploy web projects.',
    type: 'http',
    url: 'https://netlify-mcp.netlify.app/mcp',
  },
  {
    name: 'stytch',
    description:
      'Configure and manage Stytch authentication services, redirect URLs, email templates, and workspace settings.',
    type: 'http',
    url: 'http://mcp.stytch.dev/mcp',
  },
  {
    name: 'railway',
    description: 'Deploy apps, databases, and services.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@railway/mcp-server'],
    note: 'Requires npx (Node.js) to be installed',
  },
  {
    name: 'graphite',
    description: 'Create and manage stacked PRs.',
    type: 'stdio',
    command: 'gt',
    args: ['mcp'],
    note: 'Requires Graphite CLI (gt) to be installed',
  },
  {
    name: 'vercel',
    description: 'Manage projects and deployments on Vercel.',
    type: 'http',
    url: 'https://mcp.vercel.com/',
  },
  {
    name: 'amplitude',
    description:
      'Behavior analytics and experimentation platform for product data insights.',
    type: 'http',
    url: 'https://mcp.amplitude.com/mcp',
  },
  {
    name: 'microsoft-learn',
    description: 'Search Microsoft docs.',
    type: 'http',
    url: 'https://learn.microsoft.com/api/mcp',
  },
  {
    name: 'azure',
    description:
      'Manage Azure resources including storage, cosmos DB, app config, and more.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@azure/mcp@latest', 'server', 'start'],
    note: 'Requires npx (Node.js) to be installed',
  },
  {
    name: 'chrome-devtools',
    description:
      'Control and inspect a live Chrome browser for automation and debugging.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
    note: "Requires npx (Node.js) to be installed. In Mission mode, add '--isolated' manually to args to prevent session intervention",
  },
  {
    name: 'granola',
    description:
      'Access meeting notes and transcripts from the Granola notepad platform.',
    type: 'http',
    url: 'https://mcp.granola.ai/mcp',
  },
  {
    name: 'couchbase',
    description:
      'Interact with Couchbase clusters - query data, manage documents, and analyze performance.',
    type: 'stdio',
    command: 'uvx',
    args: ['couchbase-mcp-server'],
    note: 'Requires uvx (uv) and Couchbase cluster credentials (CB_CONNECTION_STRING, CB_USERNAME, CB_PASSWORD env vars)',
  },
];

/**
 * Default general settings
 */
export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  sessionDefaultSettings: {
    reasoningEffort: ReasoningEffort.High,
    autonomyMode: AutonomyMode.Normal,
  },
  missionOrchestratorReasoningEffort: ReasoningEffort.High,
  modelFavorites: [
    ModelID.CLAUDE_OPUS_4_8,
    ModelID.GPT_5_5,
    ModelID.KIMI_K2_6,
    ModelID.GLM_5_1,
  ],
  missionModelSettings: {
    validationWorkerModel: ModelID.GPT_5_3_CODEX,
    validationWorkerReasoningEffort: ReasoningEffort.High,
  },
  subagentModelSettings: {},
  cloudSessionSync: true,
  diffMode: DiffMode.Github,
  ideExtensionPromptedAt: {},
  ideActivationNudgedForVersion: {},
  enableCompletionBell: false,
  completionSound: 'fx-ok01',
  awaitingInputSound: 'fx-ack01',
  soundFocusMode: SoundFocusMode.Always,
  commandAllowlist: DEFAULT_COMMAND_ALLOWLIST,
  commandDenylist: [...DEFAULT_COMMAND_DENYLIST],
  commandBlocklist: [...DEFAULT_COMMAND_BLOCKLIST],
  includeCoAuthoredByDrool: true,
  enableDroolShield: true,
  todoDisplayMode: TodoDisplayMode.Pinned,
  toolResultDisplay: ToolResultDisplay.Expanded,
  logoAnimation: LogoAnimationMode.Always,
  showThinkingInMainView: false,
  keepSystemAwakeDuringMissions: true,
  ideAutoConnect: false,
  theme: BuiltInThemeName.Auto,
  overrideTerminalColors: false,
  subagentSounds: SubagentSoundMode.Off,
};
