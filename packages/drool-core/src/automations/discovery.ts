/**
 * Top-level automation discovery across user and project directories.
 */
import * as path from 'path';

import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import {
  discoverAutomations,
  discoverAutomationsFromDir,
} from './discoverAutomations';
import { getAutomationsPath } from './getAutomationsPath';
import { directoryExists } from './loadAutomation';

import type { AutomationDiscoveryResult } from '@industry/common/automations';

/**
 * Discover automations from both user-level and project-level directories.
 *
 * User-level: ~/<INDUSTRY_DIR_NAME>/automations/ (.industry-dev in dev, .industry in prod)
 * Project-level: <cwd>/.industry/automations/ (always .industry, never .industry-dev)
 *
 * This mirrors how skills and drools are discovered from multiple settings levels.
 *
 * @param cwd - The current working directory (project root)
 * @returns Merged discovery result from both user and project locations
 */
export async function discoverAllAutomations(
  cwd: string
): Promise<AutomationDiscoveryResult> {
  const homeDir = getIndustryHome();
  const userAutomationsPath = getAutomationsPath(homeDir, getIndustryDirName());

  const results: AutomationDiscoveryResult['automations'] = [];
  const seen = new Set<string>();

  // Skip project-level discovery when cwd is the home directory. Otherwise
  // the "project" path resolves to ~/.industry/automations/, which is the
  // production user-level directory and would cross-contaminate dev/prod
  // (e.g., the dev daemon would surface prod automations as "project" ones).
  // This matches dev-vs-prod dir isolation used by sessions, skills, plugins,
  // and settings (user dirs use getIndustryDirName(); project dirs always use
  // .industry and are only meaningful inside a real project).
  const isCwdHome = path.resolve(cwd) === path.resolve(homeDir);
  const projectAutomationsPath = getAutomationsPath(cwd);
  const isUserSameAsProject =
    path.resolve(userAutomationsPath) === path.resolve(projectAutomationsPath);

  // Project-level is meaningful only when:
  //   - cwd is NOT the home directory, AND
  //   - the project path differs from the user path (otherwise we'd
  //     double-discover the same dir and wrongly attribute it as a project).
  if (!isCwdHome && !isUserSameAsProject) {
    const projectResult = await discoverAutomations(cwd);
    for (const automation of projectResult.automations) {
      results.push(automation);
      seen.add(automation.id);
    }
  }

  // Discover from user-level (lower priority, skip duplicates)
  if (await directoryExists(userAutomationsPath)) {
    const userResult = await discoverAutomationsFromDir(
      userAutomationsPath,
      homeDir
    );
    for (const automation of userResult.automations) {
      if (!seen.has(automation.id)) {
        results.push(automation);
      }
    }
  }

  return {
    basePath: cwd,
    automations: results,
    validCount: results.filter((a) => a.isValid).length,
    invalidCount: results.filter((a) => !a.isValid).length,
  };
}
