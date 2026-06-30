import { promises as fs } from 'fs';
import path from 'path';

import { MetaError } from '@industry/logging/errors';

import type { AppendSystemPromptArgs } from '@/utils/types';

export function extractAppendSystemPromptArgs(
  argv: string[]
): AppendSystemPromptArgs {
  const filteredArgv: string[] = [];
  let appendSystemPrompt: string | null = null;
  let appendSystemPromptFile: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--append-system-prompt') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --append-system-prompt <text>');
      }
      appendSystemPrompt = next;
      i += 1;
      continue;
    }

    if (arg.startsWith('--append-system-prompt=')) {
      const inlineValue = arg.slice('--append-system-prompt='.length).trim();
      if (!inlineValue) {
        throw new Error('Missing value for --append-system-prompt <text>');
      }
      appendSystemPrompt = inlineValue;
      continue;
    }

    if (arg === '--append-system-prompt-file') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --append-system-prompt-file <path>');
      }
      appendSystemPromptFile = next;
      i += 1;
      continue;
    }

    if (arg.startsWith('--append-system-prompt-file=')) {
      const inlineValue = arg
        .slice('--append-system-prompt-file='.length)
        .trim();
      if (!inlineValue) {
        throw new Error('Missing value for --append-system-prompt-file <path>');
      }
      appendSystemPromptFile = inlineValue;
      continue;
    }

    filteredArgv.push(arg);
  }

  return { appendSystemPrompt, appendSystemPromptFile, filteredArgv };
}

export async function resolveAppendSystemPromptText(
  args: Pick<
    AppendSystemPromptArgs,
    'appendSystemPrompt' | 'appendSystemPromptFile'
  >
): Promise<string | null> {
  const parts: string[] = [];

  if (args.appendSystemPromptFile) {
    const filePath = path.resolve(args.appendSystemPromptFile);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      parts.push(content.trim());
    } catch (error) {
      throw new MetaError('Failed to read --append-system-prompt-file:', {
        filePath,
        cause: error,
      });
    }
  }

  if (args.appendSystemPrompt) {
    parts.push(args.appendSystemPrompt);
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}
