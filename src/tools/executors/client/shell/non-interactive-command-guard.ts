import type {
  InteractiveCommandMatch,
  InteractiveWaitMatch,
} from '@/tools/executors/client/shell/types';

const editors = new Set(['vim', 'vi', 'nvim', 'nano', 'emacs', 'pico', 'joe']);
const commandWrappers = new Set(['sudo', 'env', 'command', 'nice', 'nohup']);

const INTERACTIVE_WAIT_PATTERNS: Array<{
  pattern: RegExp;
  desc: string;
}> = [
  {
    pattern: /^\[sudo\]\s+password for [^\n:]+:[\t\r ]*$/iu,
    desc: 'sudo password prompt',
  },
  {
    pattern: /^enter passphrase for key .+:[\t\r ]*$/iu,
    desc: 'SSH key passphrase prompt',
  },
  {
    pattern: /^(?:password|passphrase):[\t\r ]*$/iu,
    desc: 'password prompt',
  },
  {
    pattern:
      /^are you sure you want to continue connecting \(yes\/no(?:\/\[fingerprint\])?\)\?[\t\r ]*$/iu,
    desc: 'SSH host verification prompt',
  },
];

function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const next = command[i + 1];

    if (quote) {
      current += char;
      if (char === quote && command[i - 1] !== '\\') {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === ';' || char === '|') {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = '';
      if (char === '|' && (next === '|' || next === '&')) {
        i += 1;
      }
      continue;
    }

    if (char === '&' && next === '&') {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = '';
      i += 1;
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
}

function extractExecutableFromSegment(segment: string): {
  executable: string;
  segment: string;
} | null {
  let remaining = segment.trim();
  if (!remaining) {
    return null;
  }

  const leadingEnvAssignment =
    /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']+)\s+/;
  while (leadingEnvAssignment.test(remaining)) {
    remaining = remaining.replace(leadingEnvAssignment, '').trimStart();
  }

  const tokenMatch = remaining.match(/^(\S+)/);
  if (!tokenMatch) {
    return null;
  }

  const executable = tokenMatch[1].split('/').pop() || tokenMatch[1];

  // Unwrap common command wrappers (sudo vim, env less, etc.)
  if (commandWrappers.has(executable.toLowerCase())) {
    const afterWrapper = remaining.slice(tokenMatch[0].length).trimStart();
    // Skip flags (e.g. sudo -u root vim, env -i less)
    const innerMatch = afterWrapper.match(/^(?:-\S+\s+)*(\S+)/);
    if (innerMatch) {
      const inner = innerMatch[1].split('/').pop() || innerMatch[1];
      return { executable: inner, segment: afterWrapper };
    }
  }

  return { executable, segment: remaining };
}

export function detectPreflightInteractiveCommand(
  command: string
): InteractiveCommandMatch | null {
  const segments = splitCommandSegments(command);

  for (const segment of segments) {
    const extracted = extractExecutableFromSegment(segment);
    if (!extracted) {
      continue;
    }

    const { executable, segment: executableSegment } = extracted;
    const lowerExecutable = executable.toLowerCase();

    if (editors.has(lowerExecutable)) {
      return { executable, desc: 'terminal editor' };
    }
    if (lowerExecutable === 'less' || lowerExecutable === 'more') {
      return { executable, desc: 'pager' };
    }
    if (lowerExecutable === 'top' || lowerExecutable === 'htop') {
      return { executable, desc: 'interactive process viewer' };
    }
    if (lowerExecutable === 'man') {
      return { executable, desc: 'manual page viewer' };
    }
    if (lowerExecutable === 'python' || lowerExecutable === 'python3') {
      if (/^python3?\s*$/u.test(executableSegment)) {
        return { executable, desc: 'interactive Python REPL' };
      }
    }
    if (lowerExecutable === 'node') {
      if (/^node\s*$/u.test(executableSegment)) {
        return { executable, desc: 'interactive Node REPL' };
      }
    }
    if (lowerExecutable === 'irb') {
      if (/^irb\s*$/u.test(executableSegment)) {
        return { executable, desc: 'interactive Ruby REPL' };
      }
    }
  }

  return null;
}

export function detectInteractiveWaitFromOutput(
  output: string
): InteractiveWaitMatch | null {
  const tail = output.slice(-1000);
  const lastLine = tail.split('\n').at(-1)?.replace(/\r$/, '') ?? '';
  if (!lastLine.trim()) {
    return null;
  }

  for (const { pattern, desc } of INTERACTIVE_WAIT_PATTERNS) {
    if (pattern.test(lastLine)) {
      return { desc };
    }
  }

  return null;
}

export function formatInteractiveCommandBlockedMessage(
  match: InteractiveCommandMatch
): string {
  return `Interactive command detected (${match.desc}: ${match.executable}). Commands run without a TTY in Drool. Use non-interactive alternatives instead.`;
}

export function formatInteractiveWaitMessage(
  match: InteractiveWaitMatch
): string {
  return `Command was auto-stopped because it appears to be waiting for interactive input (${match.desc}), which is not supported in Drool. Use a non-interactive alternative or configure authentication ahead of time.`;
}
