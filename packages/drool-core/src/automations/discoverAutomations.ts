import * as fs from 'fs';
import * as path from 'path';

import { logWarn } from '@industry/logging';

import { getAutomationsPath } from './getAutomationsPath';
import { directoryExists, loadAutomation } from './loadAutomation';

import type { AutomationDiscoveryResult } from '@industry/common/automations';

/**
 * Discover automations from a specific automations directory path.
 *
 * This is the low-level function that scans a single directory for automation
 * subdirectories. Used internally by discoverAutomations and discoverAllAutomations.
 *
 * @param automationsPath - Direct path to the automations directory (e.g., /path/.industry/automations)
 * @param basePath - The base path for the result (used in AutomationDiscoveryResult)
 * @returns Discovery result with all found automations and counts
 */
export async function discoverAutomationsFromDir(
  automationsPath: string,
  basePath: string
): Promise<AutomationDiscoveryResult> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(automationsPath, {
      withFileTypes: true,
    });
  } catch (err) {
    logWarn('Failed to read automations directory', { cause: err });
    return {
      basePath,
      automations: [],
      validCount: 0,
      invalidCount: 0,
    };
  }

  const automationDirs = entries.filter((entry) => entry.isDirectory());

  const automations = await Promise.all(
    automationDirs.map((dir) =>
      loadAutomation(path.join(automationsPath, dir.name))
    )
  );

  const validCount = automations.filter((a) => a.isValid).length;
  const invalidCount = automations.filter((a) => !a.isValid).length;

  return {
    basePath,
    automations,
    validCount,
    invalidCount,
  };
}

/**
 * Discover all automations in a directory.
 *
 * This function implements tolerant discovery - it will return all found
 * automations, both valid and invalid, allowing callers to handle invalid
 * automations appropriately (e.g., display warnings) without failing entirely.
 *
 * @param basePath - The base path containing .industry/automations/
 * @returns Discovery result with all found automations and counts
 */
export async function discoverAutomations(
  basePath: string
): Promise<AutomationDiscoveryResult> {
  const automationsPath = getAutomationsPath(basePath);

  if (!(await directoryExists(automationsPath))) {
    return {
      basePath,
      automations: [],
      validCount: 0,
      invalidCount: 0,
    };
  }

  return discoverAutomationsFromDir(automationsPath, basePath);
}
