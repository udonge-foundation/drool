import {
  access,
  constants as fsConstants,
  realpath,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

import { logWarn } from '@industry/logging';
import { isErrnoException } from '@industry/utils/errors';
import { expandTilde } from '@industry/utils/shell/node';

import type { ValidateWorkingDirectoryResult } from '@industry/drool-sdk-ext/protocol/drool';
/**
 * Trim, expand `~`, and normalize a user-provided working directory path
 * into an absolute filesystem path.
 *
 * Does NOT touch the filesystem. Pair with `validateWorkingDirectory` when
 * existence/permission checks are also required.
 */
export function resolveWorkingDirectory(input: string): string {
  return path.resolve(expandTilde(input.trim()));
}

/**
 * Resolve an optional base path to an absolute filesystem path, falling back
 * to `process.cwd()` when the input is missing/empty. Centralizes the
 * `basePath ? resolveWorkingDirectory(basePath) : process.cwd()` pattern
 * used by many daemon request handlers.
 */
export function resolveBasePathOrCwd(basePath: string | undefined): string {
  return basePath ? resolveWorkingDirectory(basePath) : process.cwd();
}

/**
 * Validates that a working directory path exists, is accessible, and is a
 * directory. Handles path expansion (~), normalization, and symlink
 * resolution so that two paths pointing at the same physical directory
 * (e.g. via a symlinked alias) yield the same `resolvedPath` — useful for
 * preventing duplicate "project" entries in persistence.
 *
 * @param workingDirectory - The directory path to validate
 * @returns Result object with `isValid`, optional `error`, and (on success)
 *   the canonical absolute path as `resolvedPath` (symlinks resolved).
 */
export async function validateWorkingDirectory(
  workingDirectory: string
): Promise<ValidateWorkingDirectoryResult> {
  try {
    const trimmedPath = workingDirectory.trim();

    if (trimmedPath.length === 0) {
      return {
        isValid: false,
        error: 'Directory path is empty',
      };
    }

    const normalizedPath = resolveWorkingDirectory(trimmedPath);

    // Check if path is accessible
    await access(normalizedPath, fsConstants.R_OK);

    // Resolve symlinks to the canonical path. This dedupes aliases like
    // `/Users/me/projects/foo` vs `/Users/me/symlink/foo` and macOS
    // `/tmp` vs `/private/tmp`.
    const canonicalPath = await realpath(normalizedPath);

    // Check if path is a directory (after symlink resolution)
    const stats = await stat(canonicalPath);
    if (!stats.isDirectory()) {
      return {
        isValid: false,
        error: 'Path is not a directory',
      };
    }

    return {
      isValid: true,
      resolvedPath: canonicalPath,
    };
  } catch (error) {
    logWarn('Working directory validation failed', { cause: error });
    if (isErrnoException(error)) {
      if (error.code === 'ENOENT') {
        return {
          isValid: false,
          error: 'Directory not found',
        };
      }
      if (error.code === 'EACCES') {
        return {
          isValid: false,
          error: 'Permission denied',
        };
      }
    }
    if (error instanceof Error) {
      return {
        isValid: false,
        error: error.message || 'Unknown error',
      };
    }

    return {
      isValid: false,
      error: 'Failed to validate directory',
    };
  }
}
