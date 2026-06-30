import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import shellQuote from 'shell-quote';

import {
  SYSTEM_NOTIFICATION_START,
  SYSTEM_NOTIFICATION_END,
} from '@industry/drool-sdk-ext/protocol/drool';
import { parseFrontmatter } from '@industry/utils/frontmatter';

import type { CommandResult } from '@/commands/types';
import { escapeUserMessageSystemTags } from '@/utils/escapeUserMessageSystemTags';

import type { CustomCommand } from '@industry/common/settings';

interface ExecuteCustomCommandOptions {
  allowExecutable?: boolean;
  rawArgs?: string;
}

function getCodeFenceLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.sh') return 'bash';
  if (ext === '.ts') return 'ts';
  if (ext === '.js') return 'js';
  if (ext === '.py') return 'python';
  return '';
}

function parseExecutableRawArgs(rawArgs: string): string[] {
  return shellQuote.parse(rawArgs).map((part) => {
    if (typeof part === 'string') return part;
    if ('op' in part) {
      return part.op === 'glob' ? part.pattern : part.op;
    }
    if ('comment' in part) return `#${part.comment}`;
    return String(part);
  });
}

async function runExecutableCustomCommand(
  meta: CustomCommand,
  args: string[],
  rawArgs: string | undefined,
  rawContent: string
): Promise<string> {
  const firstLine = rawContent.split(/\r?\n/, 1)[0] || '';
  const lang = getCodeFenceLanguage(meta.filePath);

  let stdout = '';
  let stderr = '';
  try {
    const shebang = firstLine.replace(/^#!\s*/, '').trim();
    const parts = shebang.split(/\s+/);
    const interpreter = parts[0];
    const interpArgs = parts.slice(1);
    const scriptArgs = rawArgs != null ? parseExecutableRawArgs(rawArgs) : args;
    stdout = execFileSync(
      interpreter,
      [...interpArgs, meta.filePath, ...scriptArgs],
      {
        cwd: process.cwd(),
        maxBuffer: 64 * 1024,
        env: { ...process.env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  } catch (err) {
    const anyErr = err as {
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    stdout =
      (typeof anyErr.stdout === 'string'
        ? anyErr.stdout
        : (anyErr.stdout as Buffer | undefined)?.toString?.()) ?? '';
    stderr =
      (typeof anyErr.stderr === 'string'
        ? anyErr.stderr
        : (anyErr.stderr as Buffer | undefined)?.toString?.()) ??
      (anyErr.message ? String(anyErr.message) : '');
  }

  const escapedFilePath = escapeUserMessageSystemTags(meta.filePath);
  const escapedRawContent = escapeUserMessageSystemTags(rawContent);
  const escapedOutput = escapeUserMessageSystemTags(
    `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`
  );

  return (
    `${SYSTEM_NOTIFICATION_START}\n` +
    `Command file: ${escapedFilePath}\n\n` +
    `Script contents:\n\n\`\`\`${lang}\n${escapedRawContent}\n\`\`\`\n\n` +
    `Execution output:\n\n\`\`\`\n${escapedOutput}\n\`\`\`\n` +
    `${SYSTEM_NOTIFICATION_END}`
  );
}

export async function executeCustomCommand(
  meta: CustomCommand,
  args: string[],
  options: ExecuteCustomCommandOptions = {}
): Promise<CommandResult> {
  const raw = await fs.promises.readFile(meta.filePath, 'utf8');

  if (meta.isExecutable) {
    if (options.allowExecutable === false) {
      throw new Error(
        'Executable custom commands are not allowed in this context.'
      );
    }

    const messageText = await runExecutableCustomCommand(
      meta,
      args,
      options.rawArgs,
      raw
    );
    return {
      handled: true,
      shouldRunAgent: true,
      messageText,
    };
  }

  const { body } = parseFrontmatter(raw);
  const argsText = escapeUserMessageSystemTags(
    options.rawArgs ?? args.join(' ')
  );
  const text = body.replaceAll('$ARGUMENTS', argsText);
  return {
    handled: true,
    shouldRunAgent: true,
    messageText: `${SYSTEM_NOTIFICATION_START}\n${text}\n${SYSTEM_NOTIFICATION_END}`,
  };
}
