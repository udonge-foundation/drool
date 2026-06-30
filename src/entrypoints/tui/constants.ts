import { Option } from 'commander';

export const tuiOptions: Option[] = [
  new Option(
    '--settings <path>',
    'Path to runtime settings file merged for this process only'
  ),
  new Option(
    '--append-system-prompt <text>',
    'Append custom text to the end of the system prompt'
  ),
  new Option(
    '--append-system-prompt-file <path>',
    'Append file contents to the end of the system prompt'
  ),
  new Option(
    '-r, --resume [sessionId]',
    'Resume a session (defaults to last modified)'
  ),
  new Option('--fork <sessionId>', 'Fork and resume a session'),
  new Option('--cwd <path>', 'Working directory path'),
  new Option('-w, --worktree [name]', 'Run in a git worktree'),
  new Option('--worktree-dir <path>', 'Directory for worktree creation'),
  new Option('--auto <level>', 'Autonomy level: low|medium|high'),
  new Option('--use-spec', 'Start in spec mode'),
];
