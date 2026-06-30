import * as fs from 'fs';
import * as path from 'path';

import { z } from 'zod';

import { logException, logInfo, logWarn } from '@industry/logging';

import type { InFlightRunState } from './types';

const RUN_STATE_DIR = 'run-state';

export const InFlightRunStateSchema: z.ZodType<InFlightRunState> = z.object({
  automationId: z.string(),
  runId: z.string(),
  startedAt: z.string(),
  status: z.literal('in_progress'),
  triggerSource: z.enum(['scheduled', 'manual', 'retry']).optional(),
  triggerContext: z.record(z.unknown()).optional(),
});

export function getRunStateDirPath(basePath: string): string {
  return path.join(basePath, '.industry', RUN_STATE_DIR);
}

export function getRunStateFilePath(
  basePath: string,
  automationId: string
): string {
  return path.join(getRunStateDirPath(basePath), `${automationId}.json`);
}

export function clearInFlightRun(basePath: string, automationId: string): void {
  const stateFilePath = getRunStateFilePath(basePath, automationId);

  try {
    if (fs.existsSync(stateFilePath)) {
      fs.unlinkSync(stateFilePath);
      logInfo('[run-state] Cleared in-flight run state', { automationId });
    }
  } catch (err) {
    logException(err, '[run-state] Failed to clear state file', {
      path: stateFilePath,
    });
  }
}

export function getInFlightRuns(basePath: string): InFlightRunState[] {
  const stateDir = getRunStateDirPath(basePath);

  if (!fs.existsSync(stateDir)) {
    return [];
  }

  const inFlightRuns: InFlightRunState[] = [];

  try {
    const files = fs.readdirSync(stateDir);

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      const filePath = path.join(stateDir, file);

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const state = InFlightRunStateSchema.parse(JSON.parse(content));

        if (state.automationId && state.runId && state.startedAt) {
          inFlightRuns.push(state);
        } else {
          logWarn('[run-state] Invalid state file (missing fields)', {
            filePath,
          });
        }
      } catch (err) {
        logWarn('[run-state] Failed to parse state file', {
          filePath,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logException(err, '[run-state] Failed to read state directory', {
      path: stateDir,
    });
  }

  return inFlightRuns;
}
