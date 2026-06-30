import { logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { scrubSecrets } from '@industry/utils/secretScrubber';

import { ScanUnavailableError } from '@/tools/executors/client/shell/errors';
import { scanGitCommandForSecrets } from '@/tools/executors/client/shell/secret-scanner';

import type {
  PreExecContext,
  CommandHook,
} from '@industry/utils/secretScrubber';

const gitSecretScanHook: CommandHook = {
  id: 'git-secret-scan',
  patterns: [/^git\s+(commit|push)\b/i],
  async handler(matchedCommand, ctx) {
    // Check if Drool Shield is enabled
    if (!ctx.droolShieldEnabled) {
      logInfo('Drool Shield is disabled, skipping secret scan');
      return;
    }

    try {
      const sub = matchedCommand.toLowerCase().startsWith('git ')
        ? matchedCommand.toLowerCase()
        : `git ${matchedCommand.toLowerCase()}`;
      const findings = await scanGitCommandForSecrets({
        normalizedGitSubcommand: sub,
        cwd: ctx.cwd,
      });
      logInfo('Secret scan completed', {
        sub,
        findingsLength: findings.length,
      });
      if (findings.length > 0) {
        // Get unique file paths
        const affectedFiles = [
          ...new Set(findings.map((f) => f.file).filter(Boolean)),
        ].filter((f) => f !== null && f !== undefined) as string[];
        const fileList =
          affectedFiles.length > 0
            ? affectedFiles.map((f) => `  - ${f}`).join('\n')
            : '  - uncommitted changes';

        const detectedPatterns = findings
          .slice(0, 3)
          .map((f) => {
            const location = f.file ? `${f.file}:${f.line || '?'}` : 'unknown';
            const snippet =
              f.snippet.length > 50
                ? `${f.snippet.substring(0, 50)}...`
                : f.snippet;
            return `  - ${location}: ${scrubSecrets(snippet)}`;
          })
          .join('\n');

        const errorMessage = `Drool-Shield detected potential secrets in ${findings.length} location(s):

Files affected:
${fileList}

Detected patterns:
${detectedPatterns}

STOP: Do NOT retry this command or attempt to work around this check.
Tell the user that Drool-Shield detected potential secrets and show them the affected files listed above. The user can:
1. Replace secrets with placeholder values (e.g. YOUR_API_KEY_HERE, changeme, xxxxxxxx)
2. Run the commit/push themselves outside of Drool if these are false positives
3. Disable Drool Shield via /settings (not recommended)`;

        throw new MetaError(errorMessage, {
          count: findings.length,
          filesWithSecrets: affectedFiles,
        });
      }
    } catch (error) {
      if (error instanceof MetaError) {
        throw error; // bubble up to block execution
      }
      if (error instanceof ScanUnavailableError) {
        // Fail-closed path for FAC-18955: the diff was too large to be
        // buffered by the execFile-based scanner. Rather than silently
        // letting the commit/push through (fail-open), block it with an
        // actionable message.
        throw new MetaError(
          `Drool-Shield could not scan a diff this large: ${error.message}

Because Drool-Shield cannot verify that this change is secret-free, the \
command has been blocked. You can:
1. Commit / push this change outside of Drool
2. Split the change into smaller commits so the diff fits the scanner
3. Disable Drool Shield via /settings (not recommended)`,
          { reason: error.reason }
        );
      }
      // Non-fatal issue while scanning; warn and allow
      logWarn('Secret scanning failed; allowing command to proceed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};

const HOOKS: CommandHook[] = [gitSecretScanHook];

export async function runPreExecutionHooks(
  extractedCommands: string[],
  ctx: PreExecContext
): Promise<void> {
  logInfo('Running pre-execution command hooks', {
    extractedCommands,
    droolShieldEnabled: ctx.droolShieldEnabled,
  });
  for (const hook of HOOKS) {
    const matches = extractedCommands.filter((cmd) =>
      hook.patterns.some((re) => re.test(cmd))
    );
    logInfo(`Hook matched command(s)`, {
      matches,
    });
    if (matches.length === 0) continue;
    for (const m of matches) {
      await hook.handler(m, ctx);
    }
  }
}
