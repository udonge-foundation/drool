import { getRemoteUrl } from '@/services/git-operations';
import { getPrService } from '@/services/PrService';
import { sessionConfigService } from '@/services/SessionConfigService';
import { CustomerMetrics } from '@/telemetry/customer/CustomerMetrics';
import { MetricName, AttributeName } from '@/telemetry/customer/enums';

async function getRepoName(): Promise<string | undefined> {
  try {
    const url = await getRemoteUrl();
    const match = url.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Track git operations for customer telemetry.
 * Uses getExtractedCommands to handle chained commands like "git add . && git commit -m x"
 */
export async function trackGitOperations(
  command: string,
  output: string,
  exitCode: number
) {
  if (exitCode !== 0) return;

  // Parse chained commands properly (handles &&, ||, ;, |)
  const extractedCommands = sessionConfigService.getExtractedCommands(command);

  // Track git commits - look for "git commit" in any part of the chain
  const hasGitCommit = extractedCommands.some((cmd) =>
    /^git\s+commit\b/i.test(cmd)
  );

  // Track PR/MR creation (GitHub, GitLab)
  const hasPrCreateCommand = extractedCommands.some(
    (cmd) =>
      /^gh\s+pr\s+create\b/i.test(cmd) || // GitHub CLI
      /^glab\s+mr\s+create\b/i.test(cmd) // GitLab CLI
  );
  const hasGitPush = extractedCommands.some((cmd) =>
    /^git\s+push\b/i.test(cmd)
  );

  // Check output for PR/MR URLs
  const prUrlPatterns = [
    /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/, // GitHub
    /https:\/\/gitlab\.com\/[^/\s]+\/[^/\s]+\/-\/merge_requests\/(\d+)/, // GitLab
  ];

  let prUrl: string | undefined;
  let prNumber: string | undefined;
  for (const pattern of prUrlPatterns) {
    const match = output.match(pattern);
    if (match) {
      prUrl = match[0];
      prNumber = match[1];
      break;
    }
  }

  const shouldTrackCommit = hasGitCommit;
  const shouldTrackPr = hasPrCreateCommand || (hasGitPush && prUrl);

  if (!shouldTrackCommit && !shouldTrackPr) return;

  const repoName = await getRepoName();

  if (shouldTrackCommit) {
    // Standard git commit output: "[branch abc1234] message"
    const commitMatch = output.match(/\[[^\s\]]+\s+([a-f0-9]{7,40})\]/i);
    const commitHash = commitMatch?.[1];

    CustomerMetrics.addToCounter(MetricName.GIT_COMMITS, 1, {
      ...(commitHash && { [AttributeName.COMMIT_HASH]: commitHash }),
      ...(repoName && { [AttributeName.REPO_NAME]: repoName }),
    });
  }

  if (shouldTrackPr) {
    CustomerMetrics.addToCounter(MetricName.GIT_PULL_REQUESTS, 1, {
      ...(prNumber && { [AttributeName.PR_NUMBER]: prNumber }),
      ...(prUrl && { [AttributeName.PR_URL]: prUrl }),
      ...(repoName && { [AttributeName.REPO_NAME]: repoName }),
    });
    void getPrService().refresh();
  }
}
