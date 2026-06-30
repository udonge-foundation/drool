/**
 * Repo Metadata Collection
 *
 * Collects repository characteristics for telemetry using git commands.
 * Uses streaming to keep memory bounded regardless of repo size.
 *
 * Tested against:
 * - industry-mono: 4,442 files (0.07s)
 * - Linux kernel: 92,194 files (0.12s)
 * - Chromium: 482,627 files (1.2s)
 * - CocoaPods Specs: 803,018 files (2.5s)
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { LANGUAGE_EXTENSIONS } from '@industry/drool-core/tools/utils';
import { logInfo, logWarn } from '@industry/logging';

import {
  ALL_CONFIG_FILES,
  CONFIG_PATTERNS,
  TEST_PATTERNS,
  TIMEOUT_MS,
  WORKSPACE_INDICATORS,
} from '@/telemetry/customer/constants';
import { CustomerMetrics } from '@/telemetry/customer/CustomerMetrics';
import { AttributeName, MetricName } from '@/telemetry/customer/enums';
import type { RepoMetadata } from '@/telemetry/customer/types';

/** Maximum commits to walk for history-based metrics (bounds memory/time) */
const MAX_COMMITS_TO_WALK = 10000;

/**
 * Run a git command with timeout. Returns null on failure.
 */
async function runGitCommand(
  args: string[],
  cwd: string
): Promise<string | null> {
  return new Promise((resolve) => {
    const git = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      git.kill('SIGTERM');
    }, TIMEOUT_MS);

    git.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    git.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut || code !== 0) {
        resolve(null);
      } else {
        resolve(stdout.trim());
      }
    });

    git.on('error', () => {
      clearTimeout(timeout);
      git.kill('SIGTERM'); // Safe no-op if spawn failed
      resolve(null);
    });
  });
}

/**
 * Stream git ls-tree output and collect file metadata.
 * Uses readline for O(1) memory regardless of repo size.
 */
async function collectFileMetadataStreaming(cwd: string): Promise<{
  fileCount: number;
  totalCodeBytes: number;
  directoryCount: number;
  maxDepth: number;
  languageBytes: Record<string, number>;
  languageFileCounts: Record<string, number>;
  frameworks: string[];
  buildTools: string[];
  linters: string[];
  testFrameworks: string[];
  devContainers: string[];
  cicd: string[];
  security: string[];
  observability: string[];
  docsGen: string[];
  preCommit: string[];
  docs: string[];
  testPatternsFound: Set<string>;
  workspaceType: string;
  packagesSubdirs: Set<string>;
  appsSubdirs: Set<string>;
  hasPackageJson: boolean;
  hasCargoToml: boolean;
} | null> {
  return new Promise((resolve) => {
    const git = spawn('git', ['ls-tree', '-r', '-l', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const rl = readline.createInterface({ input: git.stdout });

    // Accumulators
    let fileCount = 0;
    let totalCodeBytes = 0;
    let directoryCount = 0;
    let maxDepth = 0;
    let lastDir = '';
    const languageBytes: Record<string, number> = {};
    const languageFileCounts: Record<string, number> = {};
    const frameworks: string[] = [];
    const buildTools: string[] = [];
    const linters: string[] = [];
    const testFrameworks: string[] = [];
    const devContainers: string[] = [];
    const cicd: string[] = [];
    const security: string[] = [];
    const observability: string[] = [];
    const docsGen: string[] = [];
    const preCommit: string[] = [];
    const docs: string[] = [];
    const testPatternsFound = new Set<string>();
    let workspaceType = 'none';
    const packagesSubdirs = new Set<string>();
    const appsSubdirs = new Set<string>();
    let hasPackageJson = false;
    let hasCargoToml = false;
    let timedOut = false;

    // Pre-compile test regexes
    const testRegexes = TEST_PATTERNS.map((pattern) => ({
      pattern,
      regex: new RegExp(
        `^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`
      ),
    }));

    const timeout = setTimeout(() => {
      timedOut = true;
      git.kill('SIGTERM');
      rl.close();
    }, TIMEOUT_MS);

    rl.on('line', (line) => {
      // Parse: "100644 blob <hash> <size>\t<path>"
      const tabIndex = line.indexOf('\t');
      if (tabIndex === -1) return;

      const filePath = line.slice(tabIndex + 1);
      const prefix = line.slice(0, tabIndex);
      const parts = prefix.split(/\s+/);
      if (parts.length < 4) return;

      const size = parseInt(parts[3], 10);
      if (Number.isNaN(size)) return;

      fileCount++;
      const dir = path.dirname(filePath);
      const fileName = path.basename(filePath);
      const ext = path.extname(fileName).slice(1).toLowerCase();

      // Track directories - git ls-tree is sorted, so count dir changes
      if (dir !== lastDir && dir !== '.') {
        directoryCount++;
        lastDir = dir;
        const depth = filePath.split('/').length - 1;
        maxDepth = Math.max(maxDepth, depth);
      }

      // Count packages/apps subdirectories
      if (filePath.startsWith('packages/')) {
        const subdir = filePath.split('/')[1];
        if (subdir) packagesSubdirs.add(subdir);
      }
      if (filePath.startsWith('apps/')) {
        const subdir = filePath.split('/')[1];
        if (subdir) appsSubdirs.add(subdir);
      }

      // Track special files
      if (filePath === 'package.json') hasPackageJson = true;
      if (filePath === 'Cargo.toml') hasCargoToml = true;

      // Language detection
      const lang = LANGUAGE_EXTENSIONS[ext];
      if (lang) {
        languageBytes[lang] = (languageBytes[lang] || 0) + size;
        languageFileCounts[lang] = (languageFileCounts[lang] || 0) + 1;
        totalCodeBytes += size;
      }

      // Config file detection
      if (ALL_CONFIG_FILES.has(fileName)) {
        if (CONFIG_PATTERNS.frameworks.includes(fileName))
          frameworks.push(fileName);
        if (CONFIG_PATTERNS.buildTools.includes(fileName))
          buildTools.push(fileName);
        if (CONFIG_PATTERNS.linters.includes(fileName)) linters.push(fileName);
        if (CONFIG_PATTERNS.testFrameworks.includes(fileName))
          testFrameworks.push(fileName);
        if (CONFIG_PATTERNS.devContainers.includes(fileName))
          devContainers.push(fileName);
        if (CONFIG_PATTERNS.cicd.includes(fileName)) cicd.push(fileName);
        if (CONFIG_PATTERNS.security.includes(fileName))
          security.push(fileName);
        if (CONFIG_PATTERNS.observability.includes(fileName))
          observability.push(fileName);
        if (CONFIG_PATTERNS.docsGen.includes(fileName)) docsGen.push(fileName);
        if (CONFIG_PATTERNS.preCommit.includes(fileName))
          preCommit.push(fileName);
        if (CONFIG_PATTERNS.docs.includes(fileName)) docs.push(fileName);

        // Workspace indicator
        if (WORKSPACE_INDICATORS[fileName] && workspaceType === 'none') {
          workspaceType = WORKSPACE_INDICATORS[fileName];
        }
      }

      // Test pattern detection
      for (const { pattern, regex } of testRegexes) {
        if (regex.test(fileName)) {
          testPatternsFound.add(pattern);
        }
      }
    });

    // Track both events to avoid race condition between rl.close and git.close
    let rlClosed = false;
    let gitClosed = false;
    let gitExitCode: number | null = null;

    const tryResolve = () => {
      if (!rlClosed || !gitClosed) return;
      clearTimeout(timeout);
      if (timedOut || gitExitCode !== 0) {
        resolve(null);
      } else {
        resolve({
          fileCount,
          totalCodeBytes,
          directoryCount,
          maxDepth,
          languageBytes,
          languageFileCounts,
          frameworks,
          buildTools,
          linters,
          testFrameworks,
          devContainers,
          cicd,
          security,
          observability,
          docsGen,
          preCommit,
          docs,
          testPatternsFound,
          workspaceType,
          packagesSubdirs,
          appsSubdirs,
          hasPackageJson,
          hasCargoToml,
        });
      }
    };

    git.on('close', (code) => {
      gitExitCode = code;
      gitClosed = true;
      tryResolve();
    });

    rl.on('close', () => {
      rlClosed = true;
      tryResolve();
    });

    rl.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });

    git.on('error', () => {
      clearTimeout(timeout);
      gitExitCode = 1; // Mark as failed
      gitClosed = true;
      rl.close();
    });
  });
}

/**
 * Get contributor count using git log --format (more memory efficient than shortlog).
 * Uses --max-count to bound time/memory on very active repos.
 */
async function getContributorCount(cwd: string): Promise<number | null> {
  const output = await runGitCommand(
    [
      'log',
      `--max-count=${MAX_COMMITS_TO_WALK}`,
      '--since=90 days ago',
      '--format=%aN',
    ],
    cwd
  );
  if (output === null) return null;

  const uniqueAuthors = new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );
  return uniqueAuthors.size;
}

/**
 * Get commit velocity using rev-list with --max-count to bound time.
 */
async function getCommitVelocity(cwd: string): Promise<number | null> {
  const output = await runGitCommand(
    [
      'rev-list',
      '--count',
      `--max-count=${MAX_COMMITS_TO_WALK}`,
      '--since=30 days ago',
      'HEAD',
    ],
    cwd
  );
  if (output === null) return null;
  const count = parseInt(output, 10);
  return Number.isNaN(count) ? null : count;
}

/**
 * Collect all repo metadata from git commands.
 * Returns null if not a git repo or collection fails.
 */
async function collectRepoMetadata(cwd: string): Promise<RepoMetadata | null> {
  try {
    // Stream file metadata (O(1) memory)
    const fileMetadata = await collectFileMetadataStreaming(cwd);
    if (fileMetadata === null) {
      return null;
    }

    let { workspaceType } = fileMetadata;

    // Check npm workspaces
    if (fileMetadata.hasPackageJson && workspaceType === 'none') {
      try {
        const pkg = JSON.parse(
          await fs.promises.readFile(path.join(cwd, 'package.json'), 'utf-8')
        );
        if (Array.isArray(pkg.workspaces)) {
          workspaceType = 'npm-workspaces';
        }
      } catch {
        // Ignore
      }
    }

    // Check cargo workspace
    if (fileMetadata.hasCargoToml && workspaceType === 'none') {
      try {
        const content = await fs.promises.readFile(
          path.join(cwd, 'Cargo.toml'),
          'utf-8'
        );
        if (content.includes('[workspace]')) {
          workspaceType = 'cargo-workspace';
        }
      } catch {
        // Ignore
      }
    }

    // Determine primary language by bytes
    let primaryLanguage: string | null = null;
    let maxBytes = 0;
    for (const [lang, bytes] of Object.entries(fileMetadata.languageBytes)) {
      if (bytes > maxBytes) {
        maxBytes = bytes;
        primaryLanguage = lang;
      }
    }

    // Get git metadata in parallel (with bounded history walking)
    const [
      remoteUrl,
      defaultBranchRef,
      firstCommit,
      contributorCount90d,
      commitVelocity30d,
    ] = await Promise.all([
      runGitCommand(['remote', 'get-url', 'origin'], cwd),
      runGitCommand(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd),
      runGitCommand(['log', '--reverse', '-1', '--format=%ct'], cwd),
      getContributorCount(cwd),
      getCommitVelocity(cwd),
    ]);

    let remoteUrlHash: string | null = null;
    if (remoteUrl) {
      remoteUrlHash = createHash('sha256').update(remoteUrl).digest('hex');
    }

    let defaultBranch: string | null = null;
    if (defaultBranchRef) {
      const match = defaultBranchRef.match(/refs\/remotes\/origin\/(.+)/);
      if (match) defaultBranch = match[1];
    }

    let ageDays: number | null = null;
    if (firstCommit) {
      const ts = parseInt(firstCommit, 10);
      if (!Number.isNaN(ts)) {
        ageDays = Math.floor((Date.now() / 1000 - ts) / 86400);
      }
    }

    // Convert bytes to estimated LOC per language (~50 bytes per line)
    const languageLOCEstimate: Record<string, number> = {};
    for (const [lang, bytes] of Object.entries(fileMetadata.languageBytes)) {
      languageLOCEstimate[lang] = Math.round(bytes / 50);
    }

    return {
      fileCount: fileMetadata.fileCount,
      locEstimate: Math.round(fileMetadata.totalCodeBytes / 50),
      directoryCount: fileMetadata.directoryCount,
      maxDepth: fileMetadata.maxDepth,
      languageLOCEstimate,
      languageFileCounts: fileMetadata.languageFileCounts,
      primaryLanguage,
      languageCount: Object.keys(fileMetadata.languageBytes).length,
      frameworks: [...new Set(fileMetadata.frameworks)],
      buildTools: [...new Set(fileMetadata.buildTools)],
      linters: [...new Set(fileMetadata.linters)],
      testFrameworks: [...new Set(fileMetadata.testFrameworks)],
      devContainers: [...new Set(fileMetadata.devContainers)],
      cicd: [...new Set(fileMetadata.cicd)],
      security: [...new Set(fileMetadata.security)],
      observability: [...new Set(fileMetadata.observability)],
      docsGen: [...new Set(fileMetadata.docsGen)],
      preCommit: [...new Set(fileMetadata.preCommit)],
      docs: [...new Set(fileMetadata.docs)],
      workspaceType,
      workspacePackageCount:
        fileMetadata.packagesSubdirs.size + fileMetadata.appsSubdirs.size,
      testPatterns: Array.from(fileMetadata.testPatternsFound),
      testPatternCount: fileMetadata.testPatternsFound.size,
      hasGit: true,
      remoteUrlHash,
      defaultBranch,
      ageDays,
      contributorCount90d,
      commitVelocity30d,
    };
  } catch (error) {
    logWarn('[RepoMetadata] Failed to collect repo metadata', { cause: error });
    return null;
  }
}

let lastEmittedCwd: string | null = null;

type CollectAndEmitRepoMetadataOptions = {
  collectRepoMetadataFn?: (cwd: string) => Promise<RepoMetadata | null>;
};

function emitRepoMetadata(metadata: RepoMetadata): void {
  const attributes: Record<string, string | number | boolean> = {
    [AttributeName.REPO_FILE_COUNT]: metadata.fileCount,
    [AttributeName.REPO_LOC_ESTIMATE]: metadata.locEstimate,
    [AttributeName.REPO_DIRECTORY_COUNT]: metadata.directoryCount,
    [AttributeName.REPO_MAX_DEPTH]: metadata.maxDepth,
    [AttributeName.REPO_LANGUAGE_LOC_ESTIMATE]: JSON.stringify(
      metadata.languageLOCEstimate
    ),
    [AttributeName.REPO_LANGUAGE_FILE_COUNTS]: JSON.stringify(
      metadata.languageFileCounts
    ),
    [AttributeName.REPO_LANGUAGE_COUNT]: metadata.languageCount,
    [AttributeName.REPO_FRAMEWORKS]: JSON.stringify(metadata.frameworks),
    [AttributeName.REPO_BUILD_TOOLS]: JSON.stringify(metadata.buildTools),
    [AttributeName.REPO_LINTERS]: JSON.stringify(metadata.linters),
    [AttributeName.REPO_TEST_FRAMEWORKS]: JSON.stringify(
      metadata.testFrameworks
    ),
    [AttributeName.REPO_DEV_CONTAINERS]: JSON.stringify(metadata.devContainers),
    [AttributeName.REPO_CICD]: JSON.stringify(metadata.cicd),
    [AttributeName.REPO_SECURITY]: JSON.stringify(metadata.security),
    [AttributeName.REPO_OBSERVABILITY]: JSON.stringify(metadata.observability),
    [AttributeName.REPO_DOCS_GEN]: JSON.stringify(metadata.docsGen),
    [AttributeName.REPO_PRE_COMMIT]: JSON.stringify(metadata.preCommit),
    [AttributeName.REPO_DOCS]: JSON.stringify(metadata.docs),
    [AttributeName.REPO_WORKSPACE_TYPE]: metadata.workspaceType,
    [AttributeName.REPO_WORKSPACE_PACKAGE_COUNT]:
      metadata.workspacePackageCount,
    [AttributeName.REPO_TEST_PATTERNS]: JSON.stringify(metadata.testPatterns),
    [AttributeName.REPO_TEST_PATTERN_COUNT]: metadata.testPatternCount,
    [AttributeName.REPO_HAS_GIT]: metadata.hasGit,
  };

  if (metadata.primaryLanguage !== null) {
    attributes[AttributeName.REPO_PRIMARY_LANGUAGE] = metadata.primaryLanguage;
  }
  if (metadata.remoteUrlHash !== null) {
    attributes[AttributeName.REPO_REMOTE_URL_HASH] = metadata.remoteUrlHash;
  }
  if (metadata.defaultBranch !== null) {
    attributes[AttributeName.REPO_DEFAULT_BRANCH] = metadata.defaultBranch;
  }
  if (metadata.ageDays !== null) {
    attributes[AttributeName.REPO_AGE_DAYS] = metadata.ageDays;
  }
  if (metadata.contributorCount90d !== null) {
    attributes[AttributeName.REPO_CONTRIBUTOR_COUNT_90D] =
      metadata.contributorCount90d;
  }
  if (metadata.commitVelocity30d !== null) {
    attributes[AttributeName.REPO_COMMIT_VELOCITY_30D] =
      metadata.commitVelocity30d;
  }

  CustomerMetrics.addToCounter(MetricName.REPO_METADATA, 1, attributes);
}

export async function collectAndEmitRepoMetadata(
  cwd: string,
  options: CollectAndEmitRepoMetadataOptions = {}
): Promise<void> {
  if (lastEmittedCwd === cwd) return;
  // Set cache immediately to prevent duplicate async work
  lastEmittedCwd = cwd;

  try {
    const metadata = await (
      options.collectRepoMetadataFn ?? collectRepoMetadata
    )(cwd);
    if (metadata === null) {
      lastEmittedCwd = null; // Allow retry on next call
      logWarn('[RepoMetadata] Skipping emission due to collection failure');
      return;
    }

    emitRepoMetadata(metadata);

    logInfo('[RepoMetadata] Emitted repo metadata', {
      fileCount: metadata.fileCount,
      runtime: metadata.primaryLanguage ?? undefined,
      type: metadata.workspaceType,
    });
  } catch (error) {
    lastEmittedCwd = null; // Allow retry on next call
    logWarn('[RepoMetadata] Failed to emit', { cause: error });
  }
}
