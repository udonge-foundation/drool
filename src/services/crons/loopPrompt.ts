import fs from 'fs';
import os from 'os';
import path from 'path';

const MAX_LOOP_PROMPT_BYTES = 25_000;

const LOOP_PROMPT_DIRS = ['.industry', '.agents', '.claude'] as const;

const BUILT_IN_LOOP_PROMPT = [
  'You are running on a recurring loop with no specific task assigned.',
  'Continue any unfinished work from this conversation, ask the user what to focus on,',
  'or reply with a single line stating you are idle. Be brief.',
  'Do not start new tasks, load new tools, or invoke skills unless the user explicitly asked.',
].join('\n');

function readLoopFile(filePath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return null;
  }

  const buffer = fs.readFileSync(filePath);
  return buffer.subarray(0, MAX_LOOP_PROMPT_BYTES).toString('utf-8').trim();
}

function resolveFromRoot(root: string): string | null {
  for (const dir of LOOP_PROMPT_DIRS) {
    const candidate = readLoopFile(path.join(root, dir, 'loop.md'));
    if (candidate) return candidate;
  }
  return null;
}

export function resolveDefaultLoopPrompt(cwd = process.cwd()): string {
  const projectPrompt = resolveFromRoot(cwd);
  if (projectPrompt) return projectPrompt;

  const userPrompt = resolveFromRoot(os.homedir());
  if (userPrompt) return userPrompt;

  return BUILT_IN_LOOP_PROMPT;
}
