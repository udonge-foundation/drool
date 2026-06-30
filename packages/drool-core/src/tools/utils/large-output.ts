import * as fs from 'fs';
import path from 'path';

import { logException } from '@industry/logging';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import { scrubSecrets } from '@industry/utils/secretScrubber';

import { truncateOutput } from './truncate';
import {
  getOutputTruncationThresholdForTool,
  shouldTruncateToolOutput,
} from './truncation-whitelist';

const OUTPUT_SUBDIR = 'tool-outputs';

function sanitizeSegment(segment: string): string {
  const safe = segment.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 200);
  return safe.length > 0 ? safe : 'unknown';
}

function setSecureDirectoryPermissionsSync(dirPath: string): void {
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch (error) {
    logException(error, 'Failed to set directory permissions');
  }
}

function setSecureFilePermissionsSync(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    logException(error, 'Failed to set file permissions');
  }
}

/**
 * Persists large output to file system and returns truncated output with file path.
 */
async function persistLargeOutput(
  content: string,
  ctx: { toolId: string; toolCallId: string },
  threshold: number
): Promise<string> {
  const scrubbed = scrubSecrets(content);
  const truncated = truncateOutput(scrubbed, threshold);

  const baseDir = path.join(getIndustryHome(), getIndustryDirName(), 'artifacts');
  const outputDir = path.join(baseDir, OUTPUT_SUBDIR);

  try {
    await fs.promises.mkdir(baseDir, { recursive: true });
    await fs.promises.mkdir(outputDir, { recursive: true });

    setSecureDirectoryPermissionsSync(baseDir);
    setSecureDirectoryPermissionsSync(outputDir);

    const timestamp = Date.now().toString().slice(-8);
    const fileName = `${sanitizeSegment(ctx.toolId)}-${sanitizeSegment(ctx.toolCallId)}-${timestamp}.log`;
    const filePath = path.join(outputDir, fileName);

    await fs.promises.writeFile(filePath, scrubbed, 'utf8');
    setSecureFilePermissionsSync(filePath);

    return `<system-reminder> CRITICAL: This output was truncated. The full, untruncated result is saved to ${filePath}. You MUST access this artifact file to see the full output if needed to complete the user's request. </system-reminder>

${truncated}

<system-reminder>
CRITICAL: This output was truncated. The complete untruncated result is saved to an artifact file:
${filePath}

If you need the rest of tool result to fulfill the user's intent, you MUST access the artifact file.
To access the full output, you can:
• Use the Read tool (id: read-cli) with offset/limit parameters to view specific sections
• Use the Grep tool (id: grep_tool_cli) to search for patterns within the file
• Use the Execute tool (id: execute-cli) for advanced text processing (awk, sed, etc.)

DO NOT proceed without checking the artifact if the truncated output is insufficient for the task.
</system-reminder>`;
  } catch (error) {
    logException(error, '[large-output] Failed to persist tool output');
    return truncated;
  }
}

/**
 * Processes a string tool result and applies truncation/persistence when needed.
 * - Only whitelisted tools will have truncation applied.
 * - Large outputs are automatically persisted to disk and a truncated version with file path is returned.
 */
export async function handleLargeStringOutput(
  value: string,
  ctx: { toolId: string; toolCallId: string },
  threshold?: number
): Promise<string> {
  // Skip tools not in whitelist (they handle their own truncation)
  if (!shouldTruncateToolOutput(ctx.toolId)) return value;

  const effectiveThreshold =
    threshold ?? getOutputTruncationThresholdForTool(ctx.toolId);

  // Skip if under threshold
  if (value.length <= effectiveThreshold) return value;

  return persistLargeOutput(value, ctx, effectiveThreshold);
}
