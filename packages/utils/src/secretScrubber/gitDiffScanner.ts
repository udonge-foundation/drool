/**
 * Pure functions for scanning git diffs for secrets
 * These functions are runtime-agnostic and can be used in any environment
 */

import { SECRET_DETECTION_REGEXES } from './constants';
import { isLikelyRandom, isPlaceholderValue } from './helpers';

import type { SecretFinding, GitExecutor, SecretScanOptions } from './types';

const MAX_GITLEAKS_ALLOWLIST_PATH_PATTERN_LENGTH = 512;

const COMMON_PATH_PROBE_GROUPS = [
  ['src/index.ts', 'src/config.ts'],
  [
    'apps/cli/src/index.ts',
    'apps/web/src/App.tsx',
    'apps/backend/src/server.ts',
  ],
  [
    'packages/utils/src/index.ts',
    'packages/common/src/index.ts',
    'packages/frontend/src/index.ts',
  ],
  ['docs/README.md', 'docs/security/secrets.md'],
  ['.github/workflows/ci.yml', '.github/actions/setup/action.yml'],
] as const;

const SENSITIVE_PATH_PROBES = [
  '.env',
  '.env.local',
  '.env.production',
  'src/.env',
  'apps/backend/.env',
  'apps/backend/.env.production',
  'config/credentials.json',
  'config/secrets.yml',
  'secrets.json',
  'src/credentials.ts',
  'src/secrets.ts',
  '.ssh/id_rsa',
] as const;

const OBVIOUS_MATCH_ALL_PATTERNS = new Set([
  '',
  '.',
  '.*',
  '.*$',
  '^',
  '^.*',
  '^.*$',
  '[\\s\\S]*',
  '^[\\s\\S]*$',
]);

function hasObviousNestedQuantifier(pattern: string): boolean {
  return /\((?:\\.|[^()\\])*[+*](?:\\.|[^()\\])*\)\s*[+*{]/.test(pattern);
}

function tryCreateRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
    // eslint-disable-next-line industry/require-catch-handling
  } catch (error) {
    void error;
    return null;
  }
}

function isSafeAllowlistPathPattern(pattern: string, regex: RegExp): boolean {
  const trimmedPattern = pattern.trim();
  if (trimmedPattern.length === 0) return false;
  if (trimmedPattern.length > MAX_GITLEAKS_ALLOWLIST_PATH_PATTERN_LENGTH) {
    return false;
  }
  if (OBVIOUS_MATCH_ALL_PATTERNS.has(trimmedPattern)) return false;
  if (hasObviousNestedQuantifier(trimmedPattern)) return false;

  if (
    COMMON_PATH_PROBE_GROUPS.some((group) =>
      group.every((path) => regex.test(path))
    )
  ) {
    return false;
  }

  return !SENSITIVE_PATH_PROBES.some((path) => regex.test(path));
}

function filterAllowlistedFindings(
  findings: SecretFinding[],
  options?: SecretScanOptions
): SecretFinding[] {
  const allowlistRegexes = (
    options?.gitleaksAllowlistPathPatterns ?? []
  ).flatMap((pattern) => {
    const regex = tryCreateRegex(pattern);
    return regex && isSafeAllowlistPathPattern(pattern, regex) ? [regex] : [];
  });

  if (allowlistRegexes.length === 0) return findings;

  return findings.filter((finding) => {
    if (!finding.file) return true;
    const normalizedPath = finding.file.replaceAll('\\', '/');
    return !allowlistRegexes.some((regex) => regex.test(normalizedPath));
  });
}

/**
 * Scan git diff text for potential secrets
 * This is a pure function that doesn't depend on any runtime APIs
 */
function scanTextForSecrets(text: string): SecretFinding[] {
  const results: SecretFinding[] = [];
  if (!text) return results;

  const regexes = SECRET_DETECTION_REGEXES();
  // Parse unified diff to associate lines with files and only scan additions
  let currentFile: string | undefined;
  let currentAddLine = 0;
  let inHunk = false;

  const lines = text.split('\n');
  for (const line of lines) {
    // Handle diff --git line first (most reliable source of filename)
    if (line.startsWith('diff --git')) {
      // Format: diff --git a/path/to/file b/path/to/file
      const match = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
      if (match && match[2]) {
        // Use the 'b/' path as it represents the new state
        currentFile = match[2];
      } else {
        currentFile = undefined;
      }
      inHunk = false;
      currentAddLine = 0;
      continue;
    }

    // Combined diff format used for merge commits with `--cc` / `-c`. The
    // header is `diff --combined <file>` or `diff --cc <file>`; both write
    // the canonical filename in the subsequent `+++ b/<file>` line, so we
    // just reset state here and let `+++` populate it.
    if (line.startsWith('diff --combined ') || line.startsWith('diff --cc ')) {
      const match = line.match(/^diff --(?:combined|cc) (.+)$/);
      currentFile = match && match[1] ? match[1] : undefined;
      inHunk = false;
      currentAddLine = 0;
      continue;
    }

    if (line.startsWith('+++ ')) {
      // Only use +++ line if we don't already have a file from diff --git
      // This handles edge cases where diff --git might be missing
      if (currentFile === undefined) {
        const pathMatch = line.replace(/^\+\+\+\s+/, '').trim();
        if (pathMatch !== '/dev/null') {
          // Remove the a/ or b/ prefix if present
          currentFile = pathMatch.replace(/^[ab]\//, '');
        }
      }
      continue;
    }

    if (line.startsWith('@@')) {
      // Hunk header: @@ -a,b +c,d @@
      const plus = line.match(/\+(\d+)(?:,(\d+))?/);
      currentAddLine = plus ? parseInt(plus[1], 10) : 0;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.slice(1);

      for (let i = 0; i < regexes.length; i++) {
        const re = regexes[i];
        const matches = [...content.matchAll(re)];
        for (const match of matches) {
          // If the regex uses a capture group, validate randomness and placeholder patterns
          const captured =
            match.length > 1 && typeof match[1] === 'string' ? match[1] : null;
          if (captured && !isLikelyRandom(captured)) continue;
          if (captured && isPlaceholderValue(captured)) continue;
          results.push({
            file: currentFile,
            line: currentAddLine || undefined,
            snippet: content.slice(0, 200),
            patternIndex: i,
          });
        }
      }
      currentAddLine += 1;
    } else if (line.startsWith(' ') || line.startsWith('-')) {
      // context or removal lines advance counters accordingly
      if (line.startsWith(' ')) currentAddLine += 1;
    }
  }

  return results;
}

/**
 * Scan staged git diff for secrets (for git commit)
 * Requires a GitExecutor function to run git commands
 */
async function scanStagedDiffForSecrets(
  cwd: string,
  execGit: GitExecutor,
  options?: SecretScanOptions
): Promise<SecretFinding[]> {
  const diff = await execGit({
    args: ['diff', '--cached', '--unified=0'],
    cwd,
  });
  return filterAllowlistedFindings(scanTextForSecrets(diff), options);
}

/**
 * Scan push diff for secrets (for git push).
 *
 * Scans only commits reachable from HEAD that are NOT already on any remote
 * tracking ref (refs/remotes/*). This avoids false positives on rebases and
 * branch merges that pick up commits already living on another remote branch
 * (e.g. rebasing a feature branch onto an updated `dev` would otherwise
 * re-flag every commit between the old and new dev tip).
 *
 * Behavior across cases:
 *   - Has upstream + no rebase: diff matches `@{u}..HEAD`, identical to before.
 *   - Rebased on top of another branch already on remote: rebased-in commits
 *     are excluded because they exist on `refs/remotes/origin/dev` (or wherever).
 *   - No upstream / first push of a new branch: scans all of HEAD that isn't
 *     reachable from any remote ref (typically the full local-only history).
 *   - Brand-new repo with no remotes: `--remotes` matches nothing → scans
 *     every commit reachable from HEAD (conservative, fail-safe).
 *   - Merge commits: `--cc` produces a compact combined diff that only
 *     surfaces hunks unique to the merge result (i.e. conflict resolutions
 *     and other content not present in any parent). Clean merges produce no
 *     diff output, so content brought in via merge from a remote-tracked
 *     branch is correctly skipped while a secret pasted into a conflict
 *     resolution is still flagged.
 *
 * Output format from `git log -p` is the same `diff --git ... @@ ... +line`
 * blocks that `scanTextForSecrets` already parses, plus the combined-diff
 * variant (`diff --cc <file>` + `@@@ ... @@@` hunk headers) emitted for
 * merge commits.
 */
async function scanPushDiffForSecrets(
  cwd: string,
  execGit: GitExecutor,
  options?: SecretScanOptions
): Promise<SecretFinding[]> {
  const log = await execGit({
    args: ['log', '-p', '--cc', '--unified=0', 'HEAD', '--not', '--remotes'],
    cwd,
  });
  return filterAllowlistedFindings(scanTextForSecrets(log), options);
}

/**
 * Scan git command for secrets based on the command type
 * Requires a GitExecutor function to run git commands
 */
export async function scanGitCommandForSecrets(
  normalizedGitSubcommand: string,
  cwd: string,
  execGit: GitExecutor,
  options?: SecretScanOptions
): Promise<SecretFinding[]> {
  if (
    normalizedGitSubcommand === 'git commit' ||
    normalizedGitSubcommand.startsWith('git commit ')
  ) {
    return scanStagedDiffForSecrets(cwd, execGit, options);
  }
  if (
    normalizedGitSubcommand === 'git push' ||
    normalizedGitSubcommand.startsWith('git push ')
  ) {
    return scanPushDiffForSecrets(cwd, execGit, options);
  }
  return [];
}

function parseTomlStringArrayValues(arrayText: string): string[] {
  const values: string[] = [];
  const quotedString = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;

  for (const match of arrayText.matchAll(quotedString)) {
    if (match[1] !== undefined) {
      values.push(
        match[1]
          .replaceAll('\\\\', '\\')
          .replaceAll('\\"', '"')
          .replaceAll('\\n', '\n')
          .replaceAll('\\t', '\t')
      );
      continue;
    }
    if (match[2] !== undefined) {
      values.push(match[2]);
    }
  }

  return values;
}

function isGitleaksAllowlistHeader(line: string): boolean {
  const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]?\]\s*$/);
  if (!header) return false;
  const name = header[1]?.trim();
  return name === 'allowlist' || name === 'allowlists';
}

function isTomlHeader(line: string): boolean {
  return /^\s*\[/.test(line);
}

function isTomlArrayComplete(arrayText: string): boolean {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let inComment = false;
  let bracketDepth = 0;
  let sawOpenBracket = false;

  for (const char of arrayText) {
    if (inComment) {
      if (char === '\n' || char === '\r') inComment = false;
      continue;
    }

    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quote = null;
      }
      continue;
    }

    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }

    if (char === '#') {
      inComment = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '[') {
      sawOpenBracket = true;
      bracketDepth += 1;
      continue;
    }
    if (char === ']' && sawOpenBracket) {
      bracketDepth -= 1;
      if (bracketDepth === 0) return true;
    }
  }

  return false;
}

export function parseGitleaksAllowlistPathPatterns(config: string): string[] {
  const patterns: string[] = [];
  const lines = config.split(/\r?\n/);
  let inAllowlistBlock = false;
  let collectingPaths = false;
  let pathsText = '';

  for (const line of lines) {
    if (!collectingPaths && isTomlHeader(line)) {
      inAllowlistBlock = isGitleaksAllowlistHeader(line);
      continue;
    }

    if (!inAllowlistBlock) continue;

    if (!collectingPaths) {
      const pathsStart = line.match(/^\s*paths\s*=\s*(\[.*)$/);
      if (!pathsStart) continue;
      collectingPaths = true;
      pathsText = pathsStart[1] ?? '';
    } else {
      pathsText += `\n${line}`;
    }

    if (isTomlArrayComplete(pathsText)) {
      patterns.push(...parseTomlStringArrayValues(pathsText));
      collectingPaths = false;
      pathsText = '';
    }
  }

  return patterns;
}
