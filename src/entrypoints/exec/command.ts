import { Command } from 'commander';

function parseToolList(value: string, previous: string[] = []): string[] {
  const parts = value
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return [...previous, ...parts];
}

function collectTagStrings(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function makeCommand(): Command {
  return new Command('exec')
    .description('Run non-interactively (for scripts/automation)')
    .helpOption(false)
    .option('-h, --help', 'display help for command')
    .argument('[prompt]', 'The prompt to execute')
    .option('-o, --output-format <format>', 'Output format', 'text')
    .option(
      '--input-format <format>',
      'Input format: stream-json for multi-turn sessions; stream-jsonrpc is controlled via JSON-RPC requests'
    )
    .option('-f, --file <path>', 'Read prompt from file')
    .option('--auto <level>', 'Autonomy level: low|medium|high')
    .option(
      '--skip-permissions-unsafe',
      'Skip ALL permission checks - allows all permissions (unsafe)'
    )
    .option(
      '-s, --session-id <id>',
      'Existing session to continue (requires a prompt)'
    )
    .option(
      '--fork <id>',
      'Fork an existing session into a new session (requires a prompt)'
    )
    .option('-m, --model <id>', 'Model ID to use')
    .option(
      '-r, --reasoning-effort <level>',
      'Reasoning effort: one of low, medium, high (defaults per model)'
    )
    .option(
      '--spec-model <id>',
      'Model ID to use for spec mode (optional, defaults to main model)'
    )
    .option(
      '--spec-reasoning-effort <level>',
      'Reasoning effort for spec mode (defaults per spec model)'
    )
    .option('--use-spec', 'Start in spec mode')
    .option(
      '--enabled-tools <ids>',
      'Enable specific tools (comma or space separated list)',
      parseToolList,
      []
    )
    .option(
      '--disabled-tools <ids>',
      'Disable specific tools (comma or space separated list)',
      parseToolList,
      []
    )
    .option('--cwd <path>', 'Working directory path')
    .option('-w, --worktree [name]', 'Run in a git worktree')
    .option(
      '--worktree-dir <path>',
      'Directory for worktree creation (overrides worktreeDirectory setting)'
    )
    .option('--log-group-id <id>', 'Log group ID for filtering logs')
    .option(
      '--list-tools',
      'List available tools for the selected model and exit'
    )
    .option('--request-id <id>')
    .option(
      '--depth <number>',
      'Recursion depth for subagent spawning (internal use)',
      (value: string) => parseInt(value, 10)
    )
    .option(
      '--init-session-id <id>',
      'Create a new session with this specific ID (internal use, for subagent pre-generation)'
    )
    .option(
      '--calling-session-id <id>',
      'Parent session ID for linking child/subagent sessions (internal use)'
    )
    .option(
      '--calling-tool-use-id <id>',
      'Parent tool use ID that spawned this subagent session (internal use)'
    )
    .option('--session-title <title>', 'Session title override (internal use)')
    .option(
      '--tag <spec>',
      'Session tag (name or JSON object, repeatable)',
      collectTagStrings,
      []
    )
    .option(
      '--mission',
      'Run in mission mode (orchestrate a multi-agent mission)'
    )
    .option(
      '--worker-model <id>',
      'Model ID used by mission workers (only valid with --mission)'
    )
    .option(
      '--worker-reasoning-effort <level>',
      'Reasoning effort for mission workers (only valid with --mission)'
    )
    .option(
      '--validator-model <id>',
      'Model ID used by mission validation workers (only valid with --mission)'
    )
    .option(
      '--validator-reasoning-effort <level>',
      'Reasoning effort for mission validation workers (only valid with --mission)'
    )
    .option(
      '--append-system-prompt <text>',
      'Append custom text to the end of the system prompt'
    )
    .option(
      '--append-system-prompt-file <path>',
      'Append file contents to the end of the system prompt'
    )
    .option(
      '--settings <path>',
      'Path to runtime settings file merged for this process only'
    )
    .allowExcessArguments(true)
    .action(async (prompt, options, command) => {
      // Forward root --settings if not specified on exec directly
      if (!options.settings) {
        const rootSettings = command.parent?.opts()?.settings;
        if (rootSettings) options.settings = rootSettings;
      }
      const { run } = await import('./run.ts');
      await run(prompt, options);
    });
}
