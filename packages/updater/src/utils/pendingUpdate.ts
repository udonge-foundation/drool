/**
 * Utilities for managing pending Windows updates.
 *
 * On Windows, running executables cannot be renamed or deleted.
 * This module provides functions to write/read a marker file that tracks
 * staged updates, which are then applied on next startup when the
 * binary is no longer locked.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import { z } from 'zod';

import { logInfo, logWarn } from '@industry/logging';
import { getErrorCode } from '@industry/utils/errors';

import { PENDING_UPDATE_MARKER_FILENAME } from './constants';

import type { PendingUpdateMarker } from '../types';

const PendingUpdateMarkerSchema = z.object({
  version: z.string(),
  stagedPath: z.string(),
  targetPath: z.string(),
  createdAt: z.string(),
});

/**
 * Write a pending update marker file to track a staged Windows update.
 */
export async function writePendingUpdateMarker(
  updatesDir: string,
  marker: PendingUpdateMarker
): Promise<void> {
  const markerPath = path.join(updatesDir, PENDING_UPDATE_MARKER_FILENAME);
  await fs.writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf-8');
  logInfo('Wrote pending update marker', {
    version: marker.version,
    markerPath,
  });
}

/**
 * Read a pending update marker file if it exists.
 * Returns null if no marker exists or if the marker is invalid.
 */
export async function readPendingUpdateMarker(
  updatesDir: string
): Promise<PendingUpdateMarker | null> {
  const markerPath = path.join(updatesDir, PENDING_UPDATE_MARKER_FILENAME);

  try {
    const content = await fs.readFile(markerPath, 'utf-8');
    const result = PendingUpdateMarkerSchema.safeParse(JSON.parse(content));

    if (!result.success) {
      logWarn('Invalid pending update marker - missing required fields', {
        markerPath,
      });
      return null;
    }

    logInfo('Found pending update marker', {
      version: result.data.version,
      markerPath,
    });
    return result.data;
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      // No marker file exists - this is normal
      return null;
    }
    logWarn('Failed to read pending update marker', {
      markerPath,
      cause: error,
    });
    return null;
  }
}

/**
 * Delete the pending update marker file.
 */
export async function deletePendingUpdateMarker(
  updatesDir: string
): Promise<void> {
  const markerPath = path.join(updatesDir, PENDING_UPDATE_MARKER_FILENAME);

  try {
    await fs.unlink(markerPath);
    logInfo('Deleted pending update marker', { markerPath });
  } catch (error) {
    if (getErrorCode(error) !== 'ENOENT') {
      logWarn('Failed to delete pending update marker', {
        markerPath,
        cause: error,
      });
    }
  }
}

/**
 * Verify that a staged binary file exists and is accessible.
 */
export async function verifyStagedBinaryExists(
  stagedPath: string
): Promise<boolean> {
  try {
    const stats = await fs.stat(stagedPath);
    return stats.isFile();
  } catch (err) {
    logWarn('Staged binary not found or inaccessible', { cause: err });
    return false;
  }
}
