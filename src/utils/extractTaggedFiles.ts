import fs from 'node:fs';
import path from 'node:path';

import { isPathInsideDirectory } from '@/tools/executors/client/file-tools/utils';
import { TaggedFileRef } from '@/utils/types';

function isWordChar(c: string): boolean {
  return /[A-Za-z0-9_.\-+]/.test(c);
}

function isStopChar(c: string): boolean {
  return /[\s)\]}:,;>]/.test(c);
}

function normalizePosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function extractTaggedFiles(
  input: string,
  cwd: string
): TaggedFileRef[] {
  const results: TaggedFileRef[] = [];
  const seenAbs = new Set<string>();

  for (let i = 0; i < input.length; i += 1) {
    if (input[i] !== '@') continue;

    const prev = i > 0 ? input[i - 1] : undefined;
    if (prev && isWordChar(prev)) continue;

    const next = input[i + 1];
    if (!next) continue;

    let relativePath = '';

    if (next === '"' || next === "'") {
      const quote = next;
      let j = i + 2;
      while (j < input.length && input[j] !== quote) j += 1;
      if (j >= input.length) {
        i = j;
        continue;
      }
      relativePath = input.slice(i + 2, j);
      i = j;
    } else {
      let j = i + 1;
      while (j < input.length && !isStopChar(input[j])) j += 1;
      relativePath = input.slice(i + 1, j);
      i = j - 1;
    }

    if (!relativePath) continue;
    if (relativePath.includes('\n')) continue;
    if (relativePath.startsWith('"') || relativePath.startsWith("'")) continue;

    // Strip trailing slashes to normalize directory paths
    const normalizedRelativePath = relativePath.replace(/\/+$/, '');
    if (!normalizedRelativePath) continue;

    try {
      const absolutePath = path.resolve(cwd, normalizedRelativePath);
      if (
        !isPathInsideDirectory({ targetPath: absolutePath, directory: cwd })
      ) {
        continue;
      }
      if (!fs.existsSync(absolutePath)) continue;
      const stats = fs.statSync(absolutePath);

      // Accept both files and directories
      const isDirectory = stats.isDirectory();
      const isFile = stats.isFile();
      if (!isFile && !isDirectory) continue;

      const absNorm = normalizePosix(absolutePath);
      if (seenAbs.has(absNorm)) continue;
      seenAbs.add(absNorm);

      results.push({
        relativePath: normalizePosix(normalizedRelativePath),
        absolutePath: absNorm,
        isDirectory,
      });
    } catch {
      continue;
    }
  }

  return results;
}
