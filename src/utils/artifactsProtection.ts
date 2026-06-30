import * as fs from 'fs';
import * as path from 'path';

import { logException } from '@industry/logging';

import { getArtifactsDir } from '@/utils/getArtifactsDir';

/**
 * Checks if a given file path is within the artifacts directory.
 * Uses realpath to resolve symlinks and prevent bypasses.
 */
export function isPathInArtifactsDir(filePath: string): boolean {
  try {
    const artifactsDir = getArtifactsDir();

    // Resolve to absolute paths, handling symlinks
    let resolvedFilePath: string;
    try {
      // If file exists, use realpath to resolve symlinks
      resolvedFilePath = fs.realpathSync(filePath);
    } catch {
      // If file doesn't exist, resolve parent directory and append basename
      const dir = path.dirname(filePath);
      const base = path.basename(filePath);
      try {
        const resolvedDir = fs.realpathSync(dir);
        resolvedFilePath = path.join(resolvedDir, base);
      } catch {
        // If parent doesn't exist either, just use absolute path
        resolvedFilePath = path.resolve(filePath);
      }
    }

    const resolvedArtifactsDir = path.resolve(artifactsDir);

    // Check if the resolved file path is within artifacts directory
    return (
      resolvedFilePath.startsWith(resolvedArtifactsDir + path.sep) ||
      resolvedFilePath === resolvedArtifactsDir
    );
  } catch (error) {
    logException(error, 'Error checking path in artifacts directory', {
      filePath,
    });
    // On any error, be conservative and block the operation
    return true;
  }
}
