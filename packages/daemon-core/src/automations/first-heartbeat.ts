/**
 * Heartbeat execution module.
 *
 * This module handles executing automation heartbeats, including:
 * - First-run execution when an automation is created
 * - Manual runs triggered via `/automations run`
 *
 * Each execution:
 * 1. Validates the automation directory and HEARTBEAT.md
 * 2. Executes the automation (placeholder - in real impl this would invoke AI)
 * 3. Updates VISUAL.html with the latest output
 * 4. Appends a report artifact in reports/
 * 5. Updates memory state in memory/state.json
 */
import * as fs from 'fs';
import * as path from 'path';

import { AutomationRunStatus } from '@industry/common/api/v0/automations';
import {
  AUTOMATION_HEARTBEAT_FILE,
  AUTOMATION_MEMORY_DIR,
  AUTOMATION_REPORTS_DIR,
  AUTOMATION_STATE_FILE,
  AUTOMATION_VISUAL_FILE,
} from '@industry/common/automations';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { isWithinAutomationDirectory } from './automation-loader';
import { writeAutomationState } from './automation-state';
import { generateVisualContent } from './generateVisualContent';
import { AutomationStateSchema } from './schemas';

import type { AutomationState } from './schemas';
import type {
  ExecuteFirstHeartbeatOptions,
  ExecuteHeartbeatOptions,
  FirstHeartbeatResult,
  HeartbeatResult,
} from './types';

// =============================================================================
// Internal Types
// =============================================================================

interface ParsedHeartbeat {
  name: string;
  description?: string;
  schedule: string;
  prompt: string;
}

// =============================================================================
// Utility Functions (defined before use)
// =============================================================================

// =============================================================================
// File System Helpers
// =============================================================================

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isFile();
  } catch (err) {
    logWarn('Heartbeat file existence check failed', { cause: err });
    return false;
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(dirPath);
    return stats.isDirectory();
  } catch (err) {
    logWarn('Heartbeat directory existence check failed', { cause: err });
    return false;
  }
}

/**
 * Write a file safely, ensuring it's within the automation directory.
 */
async function safeWriteFile(
  filePath: string,
  content: string,
  automationPath: string
): Promise<void> {
  if (!isWithinAutomationDirectory(filePath, automationPath)) {
    throw new MetaError(
      'Security violation: Attempted write outside automation directory',
      { filePath, path: automationPath }
    );
  }

  // Ensure parent directory exists
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });

  await fs.promises.writeFile(filePath, content, 'utf-8');
}

// =============================================================================
// Heartbeat Parsing
// =============================================================================

/**
 * Parse the HEARTBEAT.md file to extract metadata and prompt.
 */
async function parseHeartbeatFile(
  heartbeatPath: string
): Promise<ParsedHeartbeat | null> {
  try {
    const content = await fs.promises.readFile(heartbeatPath, 'utf-8');

    // Parse frontmatter
    const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
    const match = frontmatterRegex.exec(content);

    if (!match) {
      return null;
    }

    const frontmatterContent = match[1];
    const prompt = content.substring(match[0].length).trim();

    // Simple YAML-like parsing for frontmatter
    const lines = frontmatterContent.split('\n');
    const metadata: Record<string, string> = {};

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        let value = line.substring(colonIndex + 1).trim();
        // Remove quotes if present
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        metadata[key] = value;
      }
    }

    if (!metadata.name || !metadata.schedule) {
      return null;
    }

    return {
      name: metadata.name,
      description: metadata.description,
      schedule: metadata.schedule,
      prompt,
    };
  } catch (err) {
    logWarn('Failed to parse heartbeat config', { cause: err });
    return null;
  }
}

// =============================================================================
// Report Generation
// =============================================================================

/**
 * Generate a filename-safe timestamp.
 */
function getTimestampForFilename(): string {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

/**
 * Generate report content for a run.
 */
function generateReportContent(
  runId: string,
  automationName: string,
  startedAt: string,
  completedAt: string,
  status: AutomationRunStatus,
  durationMs: number,
  runCount: number,
  isFirstRun: boolean
): string {
  const statusEmoji = status === AutomationRunStatus.Success ? '✅' : '❌';

  const summary = isFirstRun
    ? `This is the first run of the automation "${automationName}".

The automation has been initialized with the following state:
- VISUAL.html updated with initial output
- Memory state initialized
- Run count: 1`
    : `This is run #${runCount} of the automation "${automationName}".

Run artifacts updated:
- VISUAL.html refreshed with latest output
- Memory state updated
- Run count: ${runCount}`;

  return `# Automation Run Report

## Run Details

- **Run ID:** ${runId}
- **Automation:** ${automationName}
- **Status:** ${statusEmoji} ${status}
- **Started At:** ${startedAt}
- **Completed At:** ${completedAt}
- **Duration:** ${durationMs}ms
- **Run Count:** ${runCount}

## Summary

${summary}

## Next Steps

The automation will run according to its configured schedule.
`;
}

// =============================================================================
// Memory State
// =============================================================================

/**
 * Generate or update memory state content.
 */
function generateMemoryState(
  runId: string,
  startedAt: string,
  status: AutomationRunStatus,
  previousRunCount: number = 0
): AutomationState {
  return {
    lastRunAt: startedAt,
    runCount: previousRunCount + 1,
    lastRunId: runId,
    lastRunStatus: status,
  };
}

/**
 * Load existing memory state from file.
 */
async function loadMemoryState(
  automationPath: string
): Promise<AutomationState | null> {
  try {
    const memoryPath = path.join(
      automationPath,
      AUTOMATION_MEMORY_DIR,
      AUTOMATION_STATE_FILE
    );
    const content = await fs.promises.readFile(memoryPath, 'utf-8');
    return AutomationStateSchema.parse(JSON.parse(content));
  } catch (err) {
    logWarn('Failed to load automation state', { cause: err });
    return null;
  }
}

// =============================================================================
// Heartbeat Execution
// =============================================================================

/**
 * Execute a heartbeat for an automation.
 *
 * This function handles both first-run and subsequent manual runs:
 * 1. Validates the automation directory exists
 * 2. Reads the HEARTBEAT.md file
 * 3. Loads existing memory state (if any)
 * 4. Executes the automation (placeholder - in real impl this would invoke AI)
 * 5. Updates VISUAL.html with the latest output
 * 6. Appends a report artifact in reports/
 * 7. Updates memory state in memory/state.json
 *
 * @param options - Execution options
 * @returns Result of the heartbeat execution
 */
export async function executeHeartbeat(
  options: ExecuteHeartbeatOptions
): Promise<HeartbeatResult> {
  const { automationId, automationPath } = options;
  const startedAt = new Date().toISOString();
  const runId = `run-${automationId}-${Date.now()}`;

  try {
    // Step 1: Validate automation directory exists
    if (!(await directoryExists(automationPath))) {
      return {
        success: false,
        runId,
        status: AutomationRunStatus.Failure,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: 0,
        error: `Automation directory not found: ${automationPath}`,
      };
    }

    // Step 2: Validate HEARTBEAT.md exists and is valid
    const heartbeatPath = path.join(automationPath, AUTOMATION_HEARTBEAT_FILE);
    if (!(await fileExists(heartbeatPath))) {
      return {
        success: false,
        runId,
        status: AutomationRunStatus.Failure,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: 0,
        error: `HEARTBEAT.md not found in automation directory`,
      };
    }

    const heartbeat = await parseHeartbeatFile(heartbeatPath);
    if (!heartbeat) {
      return {
        success: false,
        runId,
        status: AutomationRunStatus.Failure,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: 0,
        error: `Failed to parse HEARTBEAT.md: invalid frontmatter`,
      };
    }

    // Step 3: Load existing memory state
    const existingState = await loadMemoryState(automationPath);
    const previousRunCount = existingState?.runCount ?? 0;
    const isFirstRun = previousRunCount === 0;

    // Step 4: "Execute" the automation
    // In the skeleton/initial implementation, we simulate a successful execution.
    // Real implementation would invoke the AI/drool to process the heartbeat prompt.
    const status = AutomationRunStatus.Success;
    const completedAt = new Date().toISOString();
    const durationMs =
      new Date(completedAt).getTime() - new Date(startedAt).getTime();

    const newRunCount = previousRunCount + 1;

    // Step 5: Update VISUAL.html
    const visualPath = path.join(automationPath, AUTOMATION_VISUAL_FILE);
    const visualContent = generateVisualContent(
      heartbeat.name,
      startedAt,
      status,
      newRunCount,
      isFirstRun
    );
    await safeWriteFile(visualPath, visualContent, automationPath);

    // Step 6: Write report artifact
    const timestamp = getTimestampForFilename();
    const reportFilename = isFirstRun
      ? `${timestamp}-first-run.md`
      : `${timestamp}-run-${newRunCount}.md`;
    const reportPath = path.join(
      automationPath,
      AUTOMATION_REPORTS_DIR,
      reportFilename
    );
    const reportContent = generateReportContent(
      runId,
      heartbeat.name,
      startedAt,
      completedAt,
      status,
      durationMs,
      newRunCount,
      isFirstRun
    );
    await safeWriteFile(reportPath, reportContent, automationPath);

    // Step 7: Update memory state via the shared writer, which merges with
    // any existing fields on disk (preserving persisted `id` and other
    // passthrough fields) and uses a symlink-safe atomic write.
    const memoryState = generateMemoryState(
      runId,
      startedAt,
      status,
      previousRunCount
    );
    writeAutomationState(automationPath, memoryState);

    return {
      success: true,
      runId,
      status,
      startedAt,
      completedAt,
      durationMs,
      runCount: newRunCount,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const durationMs =
      new Date(completedAt).getTime() - new Date(startedAt).getTime();

    logWarn('[first-heartbeat] Heartbeat execution failed', { cause: error });

    return {
      success: false,
      runId,
      status: AutomationRunStatus.Failure,
      startedAt,
      completedAt,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Execute the first heartbeat for a newly created automation.
 *
 * This is a wrapper around executeHeartbeat that maintains backward
 * compatibility with the original API.
 *
 * @param options - Execution options
 * @returns Result of the first heartbeat execution
 */
export async function executeFirstHeartbeat(
  options: ExecuteFirstHeartbeatOptions
): Promise<FirstHeartbeatResult> {
  const result = await executeHeartbeat(options);
  // Return without runCount to maintain backward compatibility
  return {
    success: result.success,
    runId: result.runId,
    status: result.status,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    error: result.error,
  };
}
