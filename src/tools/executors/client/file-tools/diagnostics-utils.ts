import path from 'path';
import { pathToFileURL } from 'url';

import { IDE_NOT_CONNECTED_MESSAGES } from '@industry/common/cli';
import { logInfo, logWarn } from '@industry/logging';

import { IdeDiagnostic } from '@/hooks/types';
import { JetBrainsIdeClient } from '@/services/JetBrainsIdeClient';
import { VSCodeIdeClient } from '@/services/VSCodeIdeClient';

type IdeClient = VSCodeIdeClient | JetBrainsIdeClient;

/**
 * Convert a file path to a file URI
 */
function filePathToUri(filePath: string): string {
  const absolutePath = path.resolve(filePath);
  return pathToFileURL(absolutePath).toString();
}

/**
 * Wait for a specified duration
 */
async function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Fetch diagnostics for a file from the IDE
 * Returns empty array if IDE is not available or fetch fails
 *
 * @param ideClient - The IDE client instance
 * @param filePath - Path to the file to fetch diagnostics for
 * @param maxRetries - Optional: Number of retries for delayed diagnostics (default: 0)
 * @param delayMs - Optional: Delay in milliseconds between retries (default: 500)
 */
export async function fetchDiagnostics(
  ideClient: IdeClient | undefined,
  filePath: string,
  maxRetries: number = 0,
  delayMs: number = 500
): Promise<IdeDiagnostic[]> {
  if (!ideClient) {
    return [];
  }

  // If the client object is still around but its underlying MCP connection
  // has dropped (heartbeat timeout, transport close, SDK error), bail out
  // early instead of triggering a guaranteed-to-throw callTool. A stale
  // reference used to generate hundreds of "MCP client not connected" warns
  // per session (FAC-18854).
  if (!ideClient.isConnected()) {
    return [];
  }

  // Helper function to fetch diagnostics once
  const fetchOnce = async (): Promise<IdeDiagnostic[]> => {
    try {
      const uri = filePathToUri(filePath);
      const result = await ideClient.callTool('getIdeDiagnostics', { uri });
      logInfo('Fetched IDE diagnostics', { filePath: uri, result });

      // Parse the JSON response
      const parsed = JSON.parse(result);

      // The response should have a diagnostics array
      if (parsed && Array.isArray(parsed.diagnostics)) {
        return parsed.diagnostics;
      }

      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      // "*not connected" is expected immediately after an IDE disconnect
      // and is handled gracefully by returning []; demote it to an info
      // log so it doesn't dominate error dashboards (FAC-18854).
      if (IDE_NOT_CONNECTED_MESSAGES.has(message)) {
        logInfo('Skipping IDE diagnostics: IDE client not connected', {
          filePath,
          error: message,
        });
      } else {
        logWarn('Failed to fetch IDE diagnostics', {
          filePath,
          error: message,
        });
      }
      return [];
    }
  };

  // If no retries requested, fetch once and return
  if (maxRetries === 0) {
    return fetchOnce();
  }

  // With retries: First attempt after a small delay to let TypeScript service update
  await delay(delayMs);
  let diagnostics = await fetchOnce();

  // If we get diagnostics on first try, return them
  if (diagnostics.length > 0) {
    return diagnostics;
  }

  // Retry logic for when diagnostics might be delayed
  for (let i = 0; i < maxRetries; i++) {
    await delay(delayMs * (i + 1)); // Exponential backoff
    diagnostics = await fetchOnce();

    // Log retry attempts for debugging
    logInfo('Retrying diagnostic fetch', {
      filePath,
      count: diagnostics.length,
    });

    if (diagnostics.length > 0) {
      break;
    }
  }

  return diagnostics;
}

/**
 * Compare diagnostics before and after an edit to find new errors
 * Returns only the new diagnostics that weren't present before
 */
export function compareDiagnostics(
  before: IdeDiagnostic[],
  after: IdeDiagnostic[]
): IdeDiagnostic[] {
  // Only consider errors (severity 0) and warnings (severity 1)
  // VS Code DiagnosticSeverity: Error = 0, Warning = 1, Information = 2, Hint = 3
  const relevantSeverities = [0, 1];

  const beforeErrors = before.filter((d) =>
    relevantSeverities.includes(d.severity)
  );
  const afterErrors = after.filter((d) =>
    relevantSeverities.includes(d.severity)
  );

  // Find new errors by comparing message, line, and severity
  const newErrors = afterErrors.filter(
    (afterError) =>
      !beforeErrors.some(
        (beforeError) =>
          beforeError.message === afterError.message &&
          beforeError.range.start.line === afterError.range.start.line &&
          beforeError.severity === afterError.severity
      )
  );

  return newErrors;
}

/**
 * Format new diagnostics as a system reminder for the LLM
 */
export function formatDiagnosticsForSystemReminder(
  newDiagnostics: IdeDiagnostic[],
  filePath: string
): string | null {
  if (newDiagnostics.length === 0) {
    return null;
  }

  const lines: string[] = [
    '<system-reminder>',
    `New errors detected after editing ${path.basename(filePath)}:`,
  ];

  // Group by severity (VS Code: Error = 0, Warning = 1)
  const errors = newDiagnostics.filter((d) => d.severity === 0);
  const warnings = newDiagnostics.filter((d) => d.severity === 1);

  if (errors.length > 0) {
    lines.push('Errors:');
    errors.forEach((error) => {
      const line = error.range.start.line + 1; // Convert to 1-based line numbers
      const source = error.source ? ` (${error.source})` : '';
      lines.push(`  - Line ${line}: ${error.message}${source}`);
    });
  }

  if (warnings.length > 0) {
    if (errors.length > 0) lines.push('');
    lines.push('Warnings:');
    warnings.forEach((warning) => {
      const line = warning.range.start.line + 1; // Convert to 1-based line numbers
      const source = warning.source ? ` (${warning.source})` : '';
      lines.push(`  - Line ${line}: ${warning.message}${source}`);
    });
  }

  lines.push('</system-reminder>');

  return lines.join('\n');
}
