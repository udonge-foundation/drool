export const READINESS_REPORT_COMMAND_NAME = 'readiness-report';
export const AGENT_EFFECTIVENESS_REPORT_COMMAND_NAME =
  'agent-effectiveness-report';

export const READINESS_FIX_COMMAND_NAME = 'readiness-fix';

export const INSTALL_WIKI_COMMAND_NAME = 'install-wiki';
export const AUTOMATIONS_COMMAND_METRIC = 'automations_command_count';

export const WIKI_COMMAND_NAME = 'wiki';

// ---------------------------------------------------------------------------
// Subcommand registry
// ---------------------------------------------------------------------------
// Non-interactive subcommands registered in entrypoints/subcommands.ts.
// `exec` and `daemon` have their own dedicated entrypoints and are routed
// directly by the dispatcher in index.ts — they do not appear here.
// A unit test in index.test.ts verifies this set stays in sync.

export const CLI_SUBCOMMANDS = new Set([
  'computer',
  'git-ai-checkpoint-hook',
  'mcp',
  'plugin',
  'push-git-ai-notes',
  'search',
  'update',
  'wiki-read',
  'wiki-search',
  'wiki-upload',
]);

// ---------------------------------------------------------------------------
// Wiki video overview (Phase 3.6 — Hyperframes)
// ---------------------------------------------------------------------------

/** Maximum render attempts (initial + one retry). */
export const RENDER_MAX_ATTEMPTS = 2;
