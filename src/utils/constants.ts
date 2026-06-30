/**
 * Custom model blocking message
 */
export const CUSTOM_MODELS_BLOCKED_MESSAGE =
  'Custom models are not allowed by your organization policy';

export const CUSTOM_MODEL_BASE_URL_BLOCKED_MESSAGE =
  'Custom model base URL is not allowed by your organization policy';
/** Fallback cache TTL: 7 days in milliseconds (used when count check fails) */
export const CERTIFICATE_CACHE_FALLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Cache file name */
export const CERTIFICATE_CACHE_FILE = 'system-certs-cache.json';
/** Current cache schema version - increment when cache structure changes */
export const CERTIFICATE_CACHE_VERSION = 3;

export const SHUTDOWN_HOOK_PRIORITY = {
  // Runs first so it can still emit logs/telemetry through the intact
  // transport stack before downstream hooks start tearing things down.
  UpdateDrain: 1,
  ToolProcesses: 5,
  SessionEnd: 10,
  IdeContext: 20,
  ImageStorage: 30,
  TerminalResizing: 40,
  KittyProtocol: 50,
  ThemeRestore: 55,
  GhosttyProgress: 60,
  Default: 100,
} as const;

/**
 * Maximum time the shutdown coordinator will hold the process open to let an
 * in-flight non-blocking auto-update finish. Sized to cover a typical
 * download+install on a slow connection; SIGKILL still bypasses it.
 */
export const UPDATE_DRAIN_TIMEOUT_MS = 60_000;

/** Delay in ms for TUI to settle after editor command fails */
export const TUI_SETTLE_DELAY_MS = 50;

// Approximate tokens for system prompt and tools that are always present
export const SYSTEM_PROMPT_TOKENS = 11_000;

// Default limit for UI messages to render in <Static> after compaction
export const UI_MESSAGE_RENDER_LIMIT = 500;

export const SPEC_APPROVAL_NOTIFICATION_ID_SUFFIX = '-saved-to-notification';
export const SPEC_APPROVAL_COMMENT_ID_SUFFIX = '-approval-comment';

/**
 * Environment variables that prevent interactive prompts from launching in
 * child processes. Commands run without a TTY so interactive programs would
 * hang indefinitely.
 */
export const NON_INTERACTIVE_ENV = {
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  SSH_ASKPASS: '',
  GIT_ASKPASS: '',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  SUDO_ASKPASS: '',
} as const satisfies Record<string, string>;

/**
 * On Windows, when Python's stdio is redirected to a pipe (the subprocess
 * case we hit through Execute / hooks), Python defaults to the locale's
 * preferred encoding — typically the active Windows code page (cp1252,
 * cp936/GBK, etc.) — which crashes with UnicodeEncodeError/UnicodeDecodeError
 * on Unicode characters.
 *
 * Note: Python 3.6+ uses UTF-8 for an *interactive* console on Windows
 * (PEP 528), but redirected stdio still falls back to the codepage. PEP 540
 * (Python 3.7+) introduced PYTHONUTF8 to force UTF-8 in all cases.
 * PYTHONIOENCODING is honored back to Python 2.6 as a fallback.
 */
export const WINDOWS_PYTHON_UTF8_ENV = {
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
} as const satisfies Record<string, string>;

export const STUCK_WINDOW_TURNS = 5;
export const STUCK_THRESHOLD = 3;
export const STUCK_PHRASE_NUDGE_TEXT =
  'You have recently expressed difficulty multiple times ' +
  '(phrases like "let me try a different approach", "actually, wait", ' +
  '"this isn\'t working"). The UpgradeSessionModel tool is available. ' +
  'Call it now if your current approach is not working, or continue only ' +
  'if you have a concrete new approach distinct from your prior attempts.';

export const SECURITY_WORK_UPGRADE_NUDGE_TEXT =
  'The recent conversation may require security or vulnerability analysis. ' +
  'If the current task is to find, validate, exploit, triage, patch, fix, or review ' +
  'a security vulnerability, call UpgradeSessionModel before doing substantive analysis. ' +
  'If this is only a definition, planning discussion, model-routing discussion, or non-security mention, do not call it.';
