import * as fs from 'fs';
import * as path from 'path';

import { logException, logInfo, logWarn } from '@industry/logging';
import { SettingsManager } from '@industry/runtime/settings';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import {
  SCRUTINY_FEATURE_REVIEWER_PROMPT,
  USER_TESTING_FLOW_VALIDATOR_PROMPT,
} from '@/skills/builtin/constants';

const DROOLS_DIR = 'drools';

interface BuiltInDrool {
  fileName: string;
  content: string;
}

const BUILT_IN_DROOLS: BuiltInDrool[] = [
  {
    fileName: 'worker.md',
    content: `---
name: worker
description: >-
  General-purpose worker drool for delegating tasks. Use for non-trivial tasks
  that benefit from parallel execution, such as code exploration, Q&A, research,
  analysis.
model: inherit
---
# Worker Drool

You are a general-purpose worker agent. Complete your assigned task precisely and report results.

Key guidelines:
- Complete the task and return what the caller asked for, in the format they specified.
- Report concrete actions taken and their outcomes
- Note any blockers or required follow-ups
`,
  },
  {
    fileName: 'scrutiny-feature-reviewer.md',
    content: `---
name: scrutiny-feature-reviewer
description: >-
  Code review for a single feature during mission validation. Used only within missions.
model: inherit
---
${SCRUTINY_FEATURE_REVIEWER_PROMPT}`,
  },
  {
    fileName: 'user-testing-flow-validator.md',
    content: `---
name: user-testing-flow-validator
description: >-
  Test validation contract assertions through designated contract surfaces during mission validation. Used only within missions.
model: inherit
---
${USER_TESTING_FLOW_VALIDATOR_PROMPT}`,
  },
];

/**
 * Ensure built-in drools exist in ~/.industry/drools/.
 * Only creates files that don't already exist, so user customizations are preserved.
 */
export async function ensureBuiltInDrools(): Promise<void> {
  const droolsDir = path.join(
    getIndustryHome(),
    getIndustryDirName(),
    DROOLS_DIR
  );

  try {
    const droolsDirStat = await fs.promises.lstat(droolsDir).catch(() => null);
    if (droolsDirStat && !droolsDirStat.isDirectory()) {
      logWarn(
        'Skipping built-in drools: expected directory at drools path but found a different file type. Move or remove the file to enable built-in drools.',
        {
          path: droolsDir,
        }
      );
      return;
    }

    await fs.promises.mkdir(droolsDir, { recursive: true });

    let created = false;

    await Promise.all(
      BUILT_IN_DROOLS.map(async (drool) => {
        const filePath = path.join(droolsDir, drool.fileName);
        const existing = await fs.promises
          .readFile(filePath, 'utf-8')
          .catch(() => null);
        if (existing !== drool.content) {
          await fs.promises.writeFile(filePath, drool.content, 'utf-8');
          logInfo('Updated built-in drool', { path: filePath });
          created = true;
        }
      })
    );

    if (created) {
      SettingsManager.getInstance().refresh();
    }
  } catch (error) {
    logException(error, 'Failed to ensure built-in drools');
  }
}
