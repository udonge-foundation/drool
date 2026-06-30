/**
 * Agent Readiness Drool - Constants
 *
 * This file defines the constants used by the Agent Readiness Drool
 * for evaluating repository readiness.
 */

import {
  ReadinessCriterionId,
  ReadinessCategoryId,
  ReadinessLevel,
  ReadinessCriterionScope,
} from './enums';
import {
  ReadinessCriterion,
  ReadinessCategory,
  ReadinessLevelDefinition,
} from './types';

// -----------------------------------------------------------------------------
// Shared Instruction Snippets
// -----------------------------------------------------------------------------

/**
 * Instruction snippet for checking admin/maintainer access on GitHub/GitLab.
 * Used by criteria that require elevated API permissions.
 */
const VCS_CLI_ADMIN_CHECK =
  "GitHub: `gh api repos/{owner}/{repo} --jq '.permissions.admin'`, GitLab: `glab api projects/{id} --jq '.permissions.project_access.access_level'` (need >= 40)";

// -----------------------------------------------------------------------------
// Criterion Constants
// -----------------------------------------------------------------------------

/**
 * Linter Configuration criterion
 */
const READINESS_LINT_CONFIG_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.LintConfig,
  name: 'Linter Configuration',
  description: 'Project has a linter configured to catch code quality issues',
  category: ReadinessCategoryId.Style,
  level: ReadinessLevel.Level1,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Linter configured – Project has a linter configured to catch code quality issues. Common examples: ESLint (.eslintrc.*, eslint.config.*) for TS/JS, ruff/flake8 (pyproject.toml, .flake8, ruff.toml) for Python, SonarQube/SonarCloud (sonar-project.properties, .sonarcloud.properties, or "sonar" in CI workflows). Other equivalent linters or static analysis tools also satisfy this criterion.',
};

/**
 * Type Checker criterion
 */
const READINESS_TYPE_CHECK_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.TypeCheck,
  name: 'Type Checker',
  description: 'Project uses static type checking',
  category: ReadinessCategoryId.Style,
  level: ReadinessLevel.Level1,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Type checker – tsconfig.json with "strict": true for TS, mypy.ini or [tool.mypy] in pyproject.toml for Py.',
};

/**
 * Formatter criterion
 */
const READINESS_FORMATTER_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.Formatter,
  name: 'Code Formatter',
  description: 'Project uses an automated code formatter',
  category: ReadinessCategoryId.Style,
  level: ReadinessLevel.Level1,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Formatter – Prettier (.prettierrc*) for TS, Black ([tool.black] in pyproject.toml) for Py.',
};

/**
 * Pre-commit Hooks criterion
 */
const READINESS_PRE_COMMIT_HOOKS_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.PreCommitHooks,
  name: 'Pre-commit Hooks',
  description: 'Project uses pre-commit hooks to enforce quality checks',
  category: ReadinessCategoryId.Style,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Pre-commit hooks – Husky/lint-staged for TS, .pre-commit-config.yaml with ruff/black for Py.',
};

/**
 * Build Command Documentation criterion
 */
const READINESS_BUILD_CMD_DOC_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.BuildCmdDoc,
  name: 'Build Command Documentation',
  description: 'Project documents how to build the code',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Build command documented – README/AGENTS.md lists "npm run build" (TS) or "pip install -r requirements.txt" (Py)',
};

/**
 * Dependencies Pinned criterion
 */
const READINESS_DEPS_PINNED_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.DepsPinned,
  name: 'Dependencies Pinned',
  description: 'Project pins dependencies to specific versions',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Dependencies pinned – lockfile committed (package-lock.json, yarn.lock, pnpm-lock.yaml) for TS; requirements.txt with == pins or poetry.lock for Py',
};

/**
 * VCS CLI Tools criterion
 */
const READINESS_VCS_CLI_TOOLS_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.VcsCliTools,
  name: 'VCS CLI Tools',
  description:
    'Version control CLI tools are installed and authenticated for automated checks',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'VCS CLI tools available – Check if `gh` (GitHub CLI), `glab` (GitLab CLI), or equivalent version control CLI is installed and authenticated. Run `gh auth status` or `glab auth status` to verify. This is a prerequisite for many Level 3+ checks including branch protection, CI metrics, deployment frequency, security scanning, and automated reviews. Without authenticated CLI access, those checks must fall back to less reliable file-based inference.',
};

/**
 * Unit Tests Exist criterion
 */
const READINESS_UNIT_TESTS_EXIST_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.UnitTestsExist,
  name: 'Unit Tests Exist',
  description: 'Project has unit tests',
  category: ReadinessCategoryId.Testing,
  level: ReadinessLevel.Level1,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Unit tests present – *.test.ts / __tests__/ (TS) or tests/test_*.py (Py).',
};

/**
 * Integration Tests Exist criterion
 */
const READINESS_INTEGRATION_TESTS_EXIST_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.IntegrationTestsExist,
  name: 'Integration Tests Exist',
  description: 'Project has integration or end-to-end tests',
  category: ReadinessCategoryId.Testing,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Integration tests present – cypress/, playwright.config.ts (TS) or tests/integration/, Behave .feature files (Py).',
};

/**
 * Unit Tests Runnable criterion
 */
const READINESS_UNIT_TESTS_RUNNABLE_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.UnitTestsRunnable,
  name: 'Unit Tests Runnable',
  description: 'Unit tests can be run locally with a simple command',
  category: ReadinessCategoryId.Testing,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Tests runnable locally – "test": "vitest" (or Vitest) script in package.json (TS) or pytest runnable via tox/make test (Py). Actually run the command you find to see if the tests really are runnable (do not worry about whether they pass, just if they can be run). Use flags like --listTests (vitest) or --collect-only (pytest) to verify runnability without running the full suite, which can take hours. It is very important to use these flags to avoid waiting for the entire test suite to complete.',
};

/**
 * Test Performance Tracking criterion
 */
const READINESS_TEST_PERFORMANCE_TRACKING_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.TestPerformanceTracking,
  name: 'Test Performance Tracking',
  description: 'Test suite duration is measured and monitored',
  category: ReadinessCategoryId.Testing,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Test performance tracking – Test suite duration is measured and tracked. Check: 1) CI outputs that show test timing (e.g., vitest --verbose, pytest --durations). 2) Test reports uploaded as artifacts. 3) Integration with test analytics platforms (BuildPulse, Datadog CI, GitHub Actions test reporting). 4) Config flags for test timing output in package.json scripts or CI workflows. Evidence that org monitors test performance, not just pass/fail.',
};

/**
 * Flaky Test Detection criterion
 */
const READINESS_FLAKY_TEST_DETECTION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.FlakyTestDetection,
  name: 'Flaky Test Detection',
  description: 'System identifies and tracks unstable tests',
  category: ReadinessCategoryId.Testing,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Flaky test detection – Check for proactive flaky test management. If `gh` or `glab` CLI is available and authenticated, run `gh pr list --state all --limit 10 --json statusCheckRollup` to detect duplicate check names (indicates retries/flakiness). Also check for: 1) Test retry configuration (vitest-retry, pytest-rerunfailures). 2) Flaky test tracking tools (BuildPulse). 3) CI quarantine/skip mechanisms. 4) Test stability metrics. Skip if `gh`/`glab` CLI is not available or not authenticated and no other flaky test detection evidence exists.',
  isSkippable: true,
};

/**
 * AGENTS.md criterion
 */
const READINESS_AGENTS_MD_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.AgentsMd,
  name: 'AGENTS.md File',
  description:
    'Repository has an AGENTS.md file with instructions for autonomous agents',
  category: ReadinessCategoryId.Docs,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'AGENTS.md exists at repo root – Check for AGENTS.md file in repository root directory. File should document essentials for autonomous agents like: npm/bun/yarn scripts (TS/JS), pip/venv/poetry setup (Python), build commands, test commands, development workflow, and project-specific conventions. Verify file exists and is not empty (>100 characters). See https://docs.example.com/industry-docs/agents-md for reference.',
};

/**
 * README criterion
 */
const READINESS_README_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.Readme,
  name: 'README File',
  description: 'Repository has a README with basic information',
  category: ReadinessCategoryId.Docs,
  level: ReadinessLevel.Level1,
  scope: ReadinessCriterionScope.Repository,
  instructions: 'README.md exists at repo root with setup/usage instructions.',
};

/**
 * Dev Container criterion
 */
const READINESS_DEVCONTAINER_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.Devcontainer,
  name: 'Dev Container',
  description: 'Project has a development container configuration',
  category: ReadinessCategoryId.DevEnv,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Dev container configured – .devcontainer/devcontainer.json with Node.js & TS extensions (TS) or Python image with pip/poetry (Py)',
};

/**
 * Structured Logging criterion
 */
const READINESS_STRUCTURED_LOGGING_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.StructuredLogging,
  name: 'Structured Logging',
  description: 'Project uses structured logging for better observability',
  category: ReadinessCategoryId.Debugging,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Structured logging – Check for logging library in dependencies: TS/JS (winston, pino, bunyan, log4js in package.json), Python (structlog, loguru, python-json-logger in requirements/pyproject.toml), or custom logger module (src/logger.*, lib/logging.*). PASS if any logging library is installed OR a dedicated logger module exists.',
};

/**
 * Distributed Tracing criterion
 */
const READINESS_DISTRIBUTED_TRACING_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.DistributedTracing,
  name: 'Distributed Tracing',
  description: 'Application implements request tracing',
  category: ReadinessCategoryId.Debugging,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Check for trace ID or request ID propagation through the application (OpenTelemetry, X-Request-ID headers, etc.) that allows following a request through the system.',
};

/**
 * Metrics Collection criterion
 */
const READINESS_METRICS_COLLECTION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.MetricsCollection,
  name: 'Metrics Collection',
  description: 'Engineering telemetry for performance monitoring',
  category: ReadinessCategoryId.Debugging,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Check for metrics/telemetry instrumentation (Datadog, Axiom, Prometheus, New Relic, CloudWatch, etc.) for understanding application performance.',
};

/**
 * Code Quality Metrics criterion
 */
const READINESS_CODE_QUALITY_METRICS_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.CodeQualityMetrics,
  name: 'Code Quality Metrics Dashboard',
  description:
    'Coverage, complexity, and maintainability metrics are monitored',
  category: ReadinessCategoryId.Debugging,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Application,
  instructions: `Code quality metrics tracked – Coverage, complexity, and maintainability metrics are monitored. If \`gh\` or \`glab\` CLI is available and authenticated, first check admin access: ${VCS_CLI_ADMIN_CHECK}. If no admin/maintainer access, skip the code-scanning API check but still check for other approaches. Code scanning check: run \`gh api /repos/{owner}/{repo}/code-scanning/analyses\`; 403 "Code Security must be enabled" = FAIL, 200 with array = PASS. Also check: coverage bots in PR comments (run \`gh pr list --state merged --limit 10 --json comments\` and search for "coverage", "codecov", "coveralls"), coverage configuration (grep for "--coverage" in package.json test scripts, or check vi.config/vitest.config coverage settings), SonarQube/SonarCloud (provides coverage, maintainability, reliability metrics with quality gates; strong evidence if sonar.qualitygate.wait=true in CI). Other code quality platforms or CI checks that track these metrics also satisfy this criterion. PASS if ANY method found. Skip if no evidence found and \`gh\`/\`glab\` CLI is not available, not authenticated, or lacks admin/maintainer access.`,
  isSkippable: true,
};

/**
 * Branch Protection criterion
 */
const READINESS_BRANCH_PROTECTION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.BranchProtection,
  name: 'Branch Protection',
  description: 'Repository has branch protection rules',
  category: ReadinessCategoryId.Security,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions: `Branch protection rules enforced – If \`gh\` or \`glab\` CLI is available and authenticated, first check admin access: ${VCS_CLI_ADMIN_CHECK}. If no admin/maintainer access, skip this criterion. If access confirmed, check in order: 1) Modern rulesets: run \`gh api repos/{owner}/{repo}/rulesets\` and look for active rulesets targeting main/dev branches. If found, inspect ruleset details with \`gh api repos/{owner}/{repo}/rulesets/{id}\` to verify PR review requirements and direct push prevention. 2) Legacy branch protection (only if rulesets returns empty []): run \`gh api repos/{owner}/{repo}/branches/main/protection\` and \`gh api repos/{owner}/{repo}/branches/dev/protection\`. If both methods return 404/empty, branch protection is not configured. Skip if \`gh\`/\`glab\` CLI is not available, not authenticated, or lacks admin/maintainer access.`,
  isSkippable: true,
};

/**
 * Secret Scanning criterion
 */
const READINESS_SECRET_SCANNING_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.SecretScanning,
  name: 'Secret Scanning',
  description: 'Repository scans for accidentally committed secrets',
  category: ReadinessCategoryId.Security,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Repository,
  instructions: `Secret scanning configured – Repository scans for committed secrets. If \`gh\` or \`glab\` CLI is available and authenticated, first check admin access: ${VCS_CLI_ADMIN_CHECK}. If no admin/maintainer access, skip the native secret scanning API check but still check for other approaches. Native check: run \`gh api /repos/{owner}/{repo}/secret-scanning/alerts\`; 404 with "disabled" message = FAIL (feature not enabled), 200 with array = PASS. Also check: GitHub Actions running gitleaks, trufflehog, or detect-secrets, pre-commit hooks with secret scanning, SonarQube/SonarCloud with security hotspots enabled (verify it is not explicitly disabled in sonar properties). Other secret detection tools or CI checks also satisfy this criterion. Skip if no evidence found and \`gh\`/\`glab\` CLI is not available, not authenticated, or lacks admin/maintainer access.`,
  isSkippable: true,
};

/**
 * CODEOWNERS criterion
 */
const READINESS_CODEOWNERS_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.Codeowners,
  name: 'CODEOWNERS File',
  description: 'Repository has a CODEOWNERS file to assign ownership',
  category: ReadinessCategoryId.Security,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'CODEOWNERS file exists – in root or .github/ directory with valid team assignments',
};

/**
 * Automated PR Review criterion
 */
const READINESS_AUTOMATED_PR_REVIEW_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.AutomatedPrReview,
  name: 'Automated PR Review Generation',
  description:
    'System automatically generates code review comments on pull requests',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Automated PR review generation – Check for automation that generates code review comments on PRs. If `gh` or `glab` CLI is available and authenticated, run `gh pr list --state all --limit 10 --json reviews,comments` to verify bots/automation are posting review comments (not just status checks). Look for danger.js, drool exec reviews, custom GitHub Actions comments, or AI-powered review bots. Key is automation that GENERATES review content, not just runs checks. Skip if `gh`/`glab` CLI is not available or not authenticated.',
  isSkippable: true,
};

/**
 * Agentic Development criterion
 */
const READINESS_AGENTIC_DEVELOPMENT_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.AgenticDevelopment,
  name: 'Agentic Development',
  description: 'AI agents are integrated into the development workflow',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    "Agentic development detected – Look for evidence that AI agents are part of the development workflow. Check: 1) Git history for agent co-authorship: `git log --format='%an|||%ae|||%s|||%b' -100` and search for AI coding agent identifiers in author/co-author fields. Common patterns include AI tool names (often with '[bot]' suffix) in author fields or 'Co-authored-by' headers (e.g., 'industry-drool[bot]', 'Claude Code'). Note: dependency bots like dependabot or renovate do not count. Also note that these examples are non-exhaustive - look for any AI coding agent identifiers. Optional: if `gh` CLI available, use `gh pr list --json commits` for more reliable co-author detection. 2) CI/CD workflows that invoke agents for reviews, code generation, or documentation. 3) Scripts/Makefiles with agent CLI commands (e.g., drool exec). 4) Agent configuration directories, skills, or hooks (e.g., .industry/drools/, .industry/skills/, .industry/hooks/). Need at least one strong evidence point showing agents actively participate in development.",
};

/**
 * Fast CI Feedback criterion
 */
const READINESS_FAST_CI_FEEDBACK_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.FastCiFeedback,
  name: 'Fast CI Feedback',
  description: 'CI pipeline provides feedback in under 10 minutes',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Fast CI feedback – CI pipeline provides feedback in under 10 minutes. If `gh` or `glab` CLI is available and authenticated, run `gh pr list --state merged --limit 20 --json statusCheckRollup`. For each PR, find all status checks in statusCheckRollup array and calculate CI duration from earliest startedAt to latest completedAt or updatedAt (ISO8601 timestamps). Example: if checks start at 10:00:00Z and finish at 10:06:00Z, CI duration is 6 minutes. Verify average CI duration is under 10 minutes for typical PRs. IMPORTANT: Calculate CI check duration, NOT PR merge time (createdAt to mergedAt). Focus on the primary CI workflow that runs on PRs. Skip if `gh`/`glab` CLI is not available or not authenticated.',
  isSkippable: true,
};

/**
 * Build Performance Tracking criterion
 */
const READINESS_BUILD_PERFORMANCE_TRACKING_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.BuildPerformanceTracking,
  name: 'Build Performance Tracking',
  description: 'Build duration is measured and optimized',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Build performance tracking – Build duration is measured and optimized. If `gh` or `glab` CLI is available and authenticated, use `gh run view --log` or `gh pr view --json statusCheckRollup` to analyze build step timing. Also check for: 1) Build caching configured (turbo cache, nx cache, webpack cache, buildx cache). 2) Build metrics exported to monitoring. 3) Evidence of build optimization (parallel builds, incremental builds). Verify deliberate performance monitoring exists, not just builds that happen to run. Skip if `gh`/`glab` CLI is not available or not authenticated and no other build performance evidence exists.',
  isSkippable: true,
};

/**
 * Deployment Frequency criterion
 */
const READINESS_DEPLOYMENT_FREQUENCY_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.DeploymentFrequency,
  name: 'Deployment Frequency',
  description: 'System deploys multiple times per week with automation',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Frequent deployments – System deploys multiple times per week with automation. If `gh` or `glab` CLI is available and authenticated, run BOTH: 1) `gh release list --limit 30` to check for release-based deploys. 2) For workflow-based deploys, first list workflows with `ls .github/workflows/ | grep -i deploy` to find deploy workflow filenames, then run `gh run list --workflow={exact-name}.yml --limit 30` for each (gh CLI does not support wildcards in --workflow). Alternatively, run `gh run list --limit 50` and filter for deploy-related workflows. Some orgs use releases, others use workflow runs - either is valid. Count successful deploys from both sources combined and verify multiple deploys per week minimum. Also verify deployment automation (auto-deploy on merge, CD pipelines). This is about culture of frequent shipping. Skip if `gh`/`glab` CLI is not available or not authenticated.',
  isSkippable: true,
};

/**
 * Automated Security Review criterion
 */
const READINESS_AUTOMATED_SECURITY_REVIEW_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.AutomatedSecurityReview,
  name: 'Automated Security Review Generation',
  description:
    'System automatically generates security review reports or assessments',
  category: ReadinessCategoryId.Security,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions: `Automated security review generation – System automatically generates security review reports or assessments. If \`gh\` or \`glab\` CLI is available and authenticated, first check admin access: ${VCS_CLI_ADMIN_CHECK}. If no admin/maintainer access, skip the code-scanning API check but still check for other approaches. Code scanning check: run \`gh api /repos/{owner}/{repo}/code-scanning/alerts\` for SAST tools (Semgrep, CodeQL, Snyk); 403 "Code Security must be enabled" = FAIL, 200 with results = PASS. Also look for: dependency audit reports in PR comments (Snyk, Dependabot), container scan summaries, or drool exec security assessments. Must generate readable reports, not just pass/fail status. Skip if no evidence found and \`gh\`/\`glab\` CLI is not available, not authenticated, or lacks admin/maintainer access.`,
  isSkippable: true,
};

/**
 * Automated Documentation Generation criterion
 */
const READINESS_AUTOMATED_DOC_GENERATION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.AutomatedDocGeneration,
  name: 'Automated Documentation Generation',
  description:
    'System automatically generates or updates technical documentation',
  category: ReadinessCategoryId.Docs,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Automated documentation generation – Tools/workflows that create/update docs. Examples: API doc generators (Swagger/OpenAPI), code comment extractors (JSDoc, Sphinx), architecture diagram generators, drool exec creating docs, changelog generators, or README updaters. Must show evidence of automated doc creation, not just static docs.',
};

/**
 * Skills criterion
 */
const READINESS_SKILLS_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.Skills,
  name: 'Skills Configuration',
  description:
    'Repository has skills defined following the Claude skills standard',
  category: ReadinessCategoryId.Docs,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Skills configured – Check for skills directories (common locations: `.industry/skills/`, `.skills/`, `.claude/skills/`, walk up to git root). Each skill should be in `{skill-name}/SKILL.md` format with either YAML frontmatter containing at minimum `name` and `description`, or table format (`| name | description |`). Verify at least one valid skill exists with non-empty prompt content. See https://code.claude.com/docs/en/skills for the open standard reference.',
};

/**
 * Documentation Freshness criterion
 */
const READINESS_DOCUMENTATION_FRESHNESS_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.DocumentationFreshness,
  name: 'Documentation Freshness',
  description: 'Documentation is kept up-to-date with code changes',
  category: ReadinessCategoryId.Docs,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Documentation freshness – Run `git log --since="180 days ago" --name-only -- README.md AGENTS.md CONTRIBUTING.md | grep -E "\\.(md)$" | head -1`. PASS if at least one of README.md, AGENTS.md, or CONTRIBUTING.md was modified in the last 180 days. This is a simple binary check: key docs updated recently = pass.',
};

// -----------------------------------------------------------------------------
// NEW CRITERIA (v2 expansion)
// -----------------------------------------------------------------------------

/**
 * Strict Typing criterion
 */
const READINESS_STRICT_TYPING_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.StrictTyping,
  name: 'Strict Typing',
  description: 'TypeScript strict mode or mypy strict mode is enabled',
  category: ReadinessCategoryId.Style,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Strict typing enabled – Project uses strict type checking. Common approaches: TypeScript tsconfig.json with "strict": true, Python mypy strict mode in mypy.ini or pyproject.toml, SonarQube/SonarCloud for TypeScript (has type-related rules that complement strict mode; verify it is not explicitly disabled in sonar properties). Other type checkers or strict mode configurations also satisfy this criterion. Some languages (Rust, Go) are typed by default. Reason about each application and skip if unclear.',
  isSkippable: true,
};

/**
 * Naming Consistency criterion
 */
const READINESS_NAMING_CONSISTENCY_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.NamingConsistency,
  name: 'Naming Consistency',
  description: 'Consistent naming conventions enforced across the codebase',
  category: ReadinessCategoryId.Style,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Naming consistency – Consistent naming conventions are enforced. Common approaches: ESLint @typescript-eslint/naming-convention rule, pylint naming-style rules, explicit naming conventions documented in AGENTS.md or CONTRIBUTING.md (e.g., "use camelCase for functions"), SonarQube/SonarCloud (has naming convention rules enabled by default in quality profiles; verify it is not explicitly disabled in sonar properties). Other linter rules, code quality tools, or documented conventions that enforce naming standards also satisfy this criterion.',
};

/**
 * Cyclomatic Complexity criterion
 */
const READINESS_CYCLOMATIC_COMPLEXITY_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.CyclomaticComplexity,
  name: 'Cyclomatic Complexity',
  description: 'Code maintains reasonable complexity thresholds',
  category: ReadinessCategoryId.Style,
  level: ReadinessLevel.Level5,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Cyclomatic complexity – Code complexity is analyzed and monitored. Common tools: ESLint complexity rule, lizard or radon for Python, gocyclo or go-critic for Go, SonarQube/SonarCloud (has built-in cognitive/cyclomatic complexity analysis enabled by default; verify it is not explicitly disabled in sonar properties). Other complexity analyzers or CI checks that enforce complexity thresholds also satisfy this criterion.',
};

/**
 * Single Command Setup criterion
 */
const READINESS_SINGLE_COMMAND_SETUP_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.SingleCommandSetup,
  name: 'Single Command Setup',
  description: 'One command gets you from clone to running dev server',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    "Single command setup – README or AGENTS.md or SKILLS documents a single command (or short sequence) that takes you from fresh clone to running dev server. Example: 'npm install && npm run dev' or 'make dev'.",
};

/**
 * Feature Flag Infrastructure criterion
 */
const READINESS_FEATURE_FLAG_INFRASTRUCTURE_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.FeatureFlagInfrastructure,
  name: 'Feature Flag Infrastructure',
  description: 'Feature flag system configured for safe rollouts',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Feature flag infrastructure – LaunchDarkly, Statsig, Unleash, GrowthBook, or custom feature flag system is configured. Enables agents to ship changes behind toggles, reducing risk of agent-authored code affecting all users immediately.',
};

/**
 * Release Notes Automation criterion
 */
const READINESS_RELEASE_NOTES_AUTOMATION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.ReleaseNotesAutomation,
  name: 'Release Notes Automation',
  description: 'Automated release notes or changelog generation',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Release notes automation – Automated release notes or changelog generation exists. Does not need to run on every commit - can be periodic (weekly/release-based) via semantic-release, standard-version, changesets, GitHub releases, or custom scripts. Ensures agent contributions are documented.',
};

/**
 * Progressive Rollout criterion
 */
const READINESS_PROGRESSIVE_ROLLOUT_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.ProgressiveRollout,
  name: 'Progressive Rollout',
  description: 'Canary or percentage-based deployments configured',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Progressive rollout – Canary deployments, percentage-based rollouts, or ring deployments are configured. Allows agent-shipped changes to reach a small percentage of users first, catching issues before full rollout. Skip if not an infra repo.',
  isSkippable: true,
};

/**
 * Rollback Automation criterion
 */
const READINESS_ROLLBACK_AUTOMATION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.RollbackAutomation,
  name: 'Rollback Automation',
  description: 'One-click or automated rollback capability',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Rollback automation – One-click or automated rollback capability exists and is documented. If an agent ships a bad change, the system can quickly revert without manual intervention or deep investigation. Skip if not an infra based repo.',
  isSkippable: true,
};

/**
 * Monorepo Tooling criterion
 */
const READINESS_MONOREPO_TOOLING_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.MonorepoTooling,
  name: 'Monorepo Tooling',
  description: 'Monorepo build tools properly configured',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Monorepo tooling – For monorepos: check for multi-package/module/workspace configuration that defines boundaries between components. Examples by ecosystem: JS/TS (npm/yarn/pnpm workspaces, Turborepo, Nx, Lerna), Python (pants, poetry multi-package), Go (go.work), Rust (Cargo workspaces), Java (Maven multi-module, Gradle multi-project), or language-agnostic tools (Bazel, Buck2, moon). Advanced build tools with caching and task orchestration are recommended for larger monorepos but not required. PASS if any monorepo tooling is configured. Skip for single-application repos.',
  isSkippable: true,
};

/**
 * Test Coverage Thresholds criterion
 */
const READINESS_TEST_COVERAGE_THRESHOLDS_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.TestCoverageThresholds,
  name: 'Test Coverage Thresholds',
  description: 'Minimum coverage enforced in CI',
  category: ReadinessCategoryId.Testing,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Test coverage thresholds – Minimum coverage percentages are enforced. Common approaches: vi.config.js coverageThreshold, pytest --cov-fail-under, Codecov/Coveralls with PR status checks blocking on coverage, SonarQube/SonarCloud quality gate with coverage threshold (sonar.coverage.* settings or sonar.qualitygate.wait=true in CI). Other CI gates or tools that enforce minimum coverage also satisfy this criterion. Agents must know they have to maintain coverage, not just that it is tracked.',
};

/**
 * API Schema Docs criterion
 */
const READINESS_API_SCHEMA_DOCS_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.ApiSchemaDocs,
  name: 'API Schema Docs',
  description: 'OpenAPI or GraphQL schema for APIs',
  category: ReadinessCategoryId.Docs,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'API schema docs – OpenAPI/Swagger specification or GraphQL schema exists for service APIs. Search recursively for files matching patterns: **/openapi.{json,yaml,yml}, **/swagger.{json,yaml,yml}, **/*.openapi.{json,yaml}, **/*.swagger.{json,yaml}, **/schema.graphql, **/*.graphql, **/*.gql. PASS if any valid API schema file is found anywhere in the repository. Skip for non-API apps (e.g., libraries, CLI tools without HTTP APIs).',
  isSkippable: true,
};

/**
 * Service Flow Documented criterion
 */
const READINESS_SERVICE_FLOW_DOCUMENTED_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.ServiceFlowDocumented,
  name: 'Service Architecture Documented',
  description: 'Architecture diagrams and service dependencies are documented',
  category: ReadinessCategoryId.Docs,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Service architecture documented – Check for: 1) Architecture diagram files (*.mermaid, *.puml, *.plantuml, docs/architecture*, docs/diagrams*). 2) Service dependency documentation showing external services, APIs, or databases the application calls. 3) Images in README/docs with names containing "architecture", "flow", "diagram", "sequence". PASS if any architecture diagrams OR service dependency documentation exists.',
};

/**
 * Env Template criterion
 */
const READINESS_ENV_TEMPLATE_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.EnvTemplate,
  name: 'Environment Template',
  description: '.env.example or documented environment variables',
  category: ReadinessCategoryId.DevEnv,
  level: ReadinessLevel.Level1,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Environment template – .env.example file exists or environment variables are documented in README/AGENTS.md. Without knowing required env vars, agents cannot run the application locally. Absolute blocker.',
};

/**
 * Local Services Setup criterion
 */
const READINESS_LOCAL_SERVICES_SETUP_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.LocalServicesSetup,
  name: 'Local Services Setup',
  description: 'docker-compose or docs for local dependencies',
  category: ReadinessCategoryId.DevEnv,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Local services setup – docker-compose.yml for local dependencies (Postgres, Redis, etc.) or clear documentation on how to run them. Agents need these services to run integration tests and develop features. Skip for apps without external service dependencies.',
  isSkippable: true,
};

/**
 * Database Schema criterion
 */
const READINESS_DATABASE_SCHEMA_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.DatabaseSchema,
  name: 'Database Schema',
  description: 'Schema definition files for databases',
  category: ReadinessCategoryId.DevEnv,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Database schema – Schema definition files exist for databases (Prisma schema, TypeORM entities, SQLAlchemy models, raw SQL schemas). Agents need to understand the data model to make correct changes. Skip for apps without databases.',
  isSkippable: true,
};

/**
 * Devcontainer Runnable criterion
 */
const READINESS_DEVCONTAINER_RUNNABLE_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.DevcontainerRunnable,
  name: 'Devcontainer Runnable',
  description: 'Devcontainer builds and runs successfully',
  category: ReadinessCategoryId.DevEnv,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Devcontainer runnable – The devcontainer can be built and run successfully using the devcontainer CLI or VS Code. Validates that the containerized development environment actually works, not just that config files exist. Skip if devcontainer CLI is not installed.',
  isSkippable: true,
};

/**
 * Error Tracking Contextualized criterion
 */
const READINESS_ERROR_TRACKING_CONTEXTUALIZED_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.ErrorTrackingContextualized,
  name: 'Error Tracking Contextualized',
  description: 'Sentry/Bugsnag with source maps and breadcrumbs',
  category: ReadinessCategoryId.Debugging,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Error tracking contextualized – Sentry, Bugsnag, or Rollbar is configured with source maps, breadcrumbs, and user context. Agents can trace production errors back to specific code paths with full stack traces.',
};

/**
 * Alerting Configured criterion
 */
const READINESS_ALERTING_CONFIGURED_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.AlertingConfigured,
  name: 'Alerting Configured',
  description: 'PagerDuty/OpsGenie or alert rules defined',
  category: ReadinessCategoryId.Debugging,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Alerting configured – PagerDuty, OpsGenie, or custom alerting rules are defined. The system actively notifies when things go wrong rather than waiting for someone to notice. Prerequisite for incident response.',
};

/**
 * Runbooks Documented criterion
 */
const READINESS_RUNBOOKS_DOCUMENTED_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.RunbooksDocumented,
  name: 'Runbooks Documented',
  description: 'Incident response playbooks exist',
  category: ReadinessCategoryId.Debugging,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Runbooks documented – Look for external pointers to runbooks/playbooks (links to Notion, Confluence, internal wiki, or dedicated runbooks/ directory). Check README, AGENTS.md, or docs/ for references to incident response procedures. PASS if any documentation points to runbooks, even if hosted externally.',
};

/**
 * Deployment Observability criterion
 */
const READINESS_DEPLOYMENT_OBSERVABILITY_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.DeploymentObservability,
  name: 'Deployment Observability',
  description: 'Can see deploy impact in real-time',
  category: ReadinessCategoryId.Debugging,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Deployment observability – Look for pointers to monitoring dashboards (Datadog, Grafana, New Relic links in docs or code comments). Check for deploy notification integrations (Slack webhooks, deployment annotations in monitoring). PASS if documentation references where to check deploy impact, even if dashboards are hosted externally.',
};

/**
 * Dependency Update Automation criterion
 */
const READINESS_DEPENDENCY_UPDATE_AUTOMATION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.DependencyUpdateAutomation,
  name: 'Dependency Update Automation',
  description: 'Dependabot or Renovate configured',
  category: ReadinessCategoryId.Security,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Dependency update automation – Dependabot, Renovate, or similar is configured and creating PRs for dependency updates. Keeps dependencies current automatically, reducing security vulnerability window.',
};

/**
 * Gitignore Comprehensive criterion
 */
const READINESS_GITIGNORE_COMPREHENSIVE_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.GitignoreComprehensive,
  name: 'Gitignore Comprehensive',
  description: '.gitignore excludes secrets and build artifacts',
  category: ReadinessCategoryId.Security,
  level: ReadinessLevel.Level1,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Gitignore comprehensive – .gitignore properly excludes .env files (not .env.example), node_modules, build artifacts, IDE configs (.idea, .vscode), and OS files (.DS_Store). Prevents agents from accidentally committing secrets or generated files.',
};

/**
 * Issue Templates criterion
 */
const READINESS_ISSUE_TEMPLATES_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.IssueTemplates,
  name: 'Issue Templates',
  description: 'Structured issue templates exist',
  category: ReadinessCategoryId.TaskDiscovery,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Issue templates – .github/ISSUE_TEMPLATE/ (GitHub) or .gitlab/issue_templates/ (GitLab) directory exists with structured templates for bugs, features, etc. Teaches agents what information to provide when creating issues.',
};

/**
 * Issue Labeling System criterion
 */
const READINESS_ISSUE_LABELING_SYSTEM_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.IssueLabelingSystem,
  name: 'Issue Labeling System',
  description: 'Consistent priority/type/area labels',
  category: ReadinessCategoryId.TaskDiscovery,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Issue labeling system – Consistent labels exist for priority (P0-P3 or critical/high/medium/low), type (bug, feature, chore), and area (frontend, backend, infra). Enables agents to filter and prioritize work programmatically.',
};

/**
 * Backlog Health criterion
 */
const READINESS_BACKLOG_HEALTH_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.BacklogHealth,
  name: 'Backlog Health',
  description: 'Issues have clear titles and recent activity',
  category: ReadinessCategoryId.TaskDiscovery,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Backlog health – Issues have clear titles and recent activity. If `gh` or `glab` CLI is available and authenticated, run `gh issue list --state open --limit 50 --json title,createdAt,labels`. Count issues with: 1) titles > 10 characters, 2) at least one label. PASS if >70% of open issues have both a descriptive title (>10 chars) AND at least one label. Also check `gh issue list --state open --json createdAt` - FAIL if >50% of issues are older than 365 days with no recent comments. Skip if `gh`/`glab` CLI is not available or not authenticated.',
  isSkippable: true,
};

/**
 * PR Templates criterion
 */
const READINESS_PR_TEMPLATES_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.PrTemplates,
  name: 'PR Templates',
  description: 'Pull request templates exist',
  category: ReadinessCategoryId.TaskDiscovery,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'PR templates – .github/pull_request_template.md (GitHub) or merge request templates (GitLab) exist with sections for description, testing done, and relevant context. Ensures agent PRs include necessary information for reviewers.',
};

/**
 * Product Analytics Instrumentation criterion
 */
const READINESS_PRODUCT_ANALYTICS_INSTRUMENTATION_CRITERION: ReadinessCriterion =
  {
    id: ReadinessCriterionId.ProductAnalyticsInstrumentation,
    name: 'Product Analytics Instrumentation',
    description: 'Mixpanel/Amplitude/PostHog instrumented',
    category: ReadinessCategoryId.Product,
    level: ReadinessLevel.Level3,
    scope: ReadinessCriterionScope.Application,
    instructions:
      'Product analytics instrumentation – Mixpanel, Amplitude, PostHog, Heap, or GA4 is instrumented in the application. Agents can see whether features are actually used and measure the impact of their changes on user behavior.',
  };

/**
 * Error to Insight Pipeline criterion
 */
const READINESS_ERROR_TO_INSIGHT_PIPELINE_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.ErrorToInsightPipeline,
  name: 'Error to Insight Pipeline',
  description: 'Errors flow from tracking to actionable issues',
  category: ReadinessCategoryId.Product,
  level: ReadinessLevel.Level5,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Error to insight pipeline – Check for Sentry-GitHub/GitLab integration: search for sentry.io webhook in .github/workflows or repo settings, OR Sentry issue linking config (SENTRY_ORG, SENTRY_PROJECT in env). Also check for error-to-issue automation: GitHub Actions that create issues from errors, or PagerDuty/OpsGenie integrations with issue creation. PASS if any error tracking tool has issue creation integration configured.',
};

/**
 * DAST Scanning criterion
 */
const READINESS_DAST_SCANNING_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.DastScanning,
  name: 'DAST Scanning',
  description:
    'Dynamic Application Security Testing runs against the application',
  category: ReadinessCategoryId.Security,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'DAST scanning – Check for Dynamic Application Security Testing (DAST) in CI/CD. Look for: 1) OWASP ZAP configured in CI workflows (zap-scan action, zap-baseline). 2) Burp Suite Enterprise or Burp CI integration. 3) Nuclei scanner configured. 4) Other DAST tools (Acunetix, Netsparker, StackHawk). 5) Custom security test suites that hit running endpoints. PASS if any DAST tool runs against a staging/test environment in CI. This is distinct from SAST (static analysis) - DAST tests the running application. Skip for apps that are not deployed as web services (e.g., libraries, CLI tools, scripts).',
  isSkippable: true,
};

/**
 * PII Handling criterion
 */
const READINESS_PII_HANDLING_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.PiiHandling,
  name: 'PII Handling',
  description: 'PII detection and handling tooling configured',
  category: ReadinessCategoryId.Security,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'PII handling – Check for PII detection and handling tooling. Look for: 1) Data classification tools (Microsoft Presidio, AWS Macie integration, Google DLP). 2) PII detection in CI (detect-secrets with PII patterns, custom regex scanners). 3) Data masking libraries in dependencies (faker for test data, masking utilities). 4) Documentation of PII handling in AGENTS.md, privacy policy references, or data-handling docs. PASS if any PII-aware tooling or documented handling procedures exist. Skip for apps that do not process personal/user data (e.g., internal tools, infrastructure, developer utilities).',
  isSkippable: true,
};

/**
 * Privacy Compliance criterion
 */
const READINESS_PRIVACY_COMPLIANCE_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.PrivacyCompliance,
  name: 'Privacy Compliance',
  description: 'GDPR/CCPA compliance infrastructure configured',
  category: ReadinessCategoryId.Security,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Privacy compliance – Check for privacy compliance infrastructure. Look for: 1) Consent management SDK/library (OneTrust, Cookiebot, custom consent banner). 2) Data retention policies documented. 3) GDPR/CCPA request handling code or documentation (data export, deletion endpoints). 4) Privacy-by-design patterns (data minimization configs, anonymization utilities). 5) Cookie/tracking consent implementation. PASS if evidence of privacy compliance infrastructure exists. Skip for apps without end-user data collection (e.g., internal tools, libraries, infrastructure).',
  isSkippable: true,
};

/**
 * Secrets Management criterion
 */
const READINESS_SECRETS_MANAGEMENT_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.SecretsManagement,
  name: 'Secrets Management',
  description: 'Secure secrets management infrastructure configured',
  category: ReadinessCategoryId.Security,
  level: ReadinessLevel.Level2,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Secrets management – Check for secure secrets management infrastructure. Look for: 1) Cloud secrets manager integration (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, HashiCorp Vault) in code or config. 2) Environment variable documentation pointing to secrets manager. 3) GitHub Actions secrets usage (secrets.* references without hardcoded values). 4) SOPS, age, or similar encrypted secrets in repo. 5) .env files properly gitignored with .env.example template. FAIL if secrets appear hardcoded or no secrets management pattern is evident.',
};

/**
 * Log Scrubbing criterion
 */
const READINESS_LOG_SCRUBBING_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.LogScrubbing,
  name: 'Sensitive Data Log Scrubbing',
  description: 'Log sanitization/scrubbing mechanisms configured',
  category: ReadinessCategoryId.Security,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Application,
  instructions:
    "Log scrubbing – Check for log sanitization/scrubbing mechanisms. Look for: 1) Logging library with redaction support configured (pino redact, winston format with filtering, structlog processors). 2) Custom log sanitization middleware or utilities (grep for 'redact', 'sanitize', 'mask' in logging code). 3) Log scrubbing documentation in AGENTS.md or logging guidelines. 4) PII filtering patterns in log configuration. PASS if any log sanitization mechanism is configured or documented.",
};

/**
 * Health Checks criterion
 */
const READINESS_HEALTH_CHECKS_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.HealthChecks,
  name: 'Health Checks',
  description: 'Health check endpoints and liveness probes configured',
  category: ReadinessCategoryId.Debugging,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Health checks – Check for health check endpoints and liveness/readiness probes. Look for: 1) `/health`, `/healthz`, `/ready`, `/live` endpoints in routes. 2) Kubernetes liveness/readiness probes in deployment manifests. 3) Health check libraries (terminus, lightship for Node.js, django-health-check). 4) Docker HEALTHCHECK instruction. 5) Load balancer health check configuration. PASS if any health check mechanism is implemented. Skip for non-deployed services (e.g., libraries, CLI tools, scripts, batch jobs).',
  isSkippable: true,
};

/**
 * Dead Feature Flag Detection criterion
 */
const READINESS_DEAD_FEATURE_FLAG_DETECTION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.DeadFeatureFlagDetection,
  name: 'Dead Feature Flag Detection',
  description: 'Tooling detects stale/dead feature flags',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Dead feature flag detection – Check for tooling that detects stale/dead feature flags. Look for: 1) Feature flag platform with stale flag detection (LaunchDarkly code references, Statsig stale detection). 2) Custom scripts that grep for flag usage and compare to flag definitions. 3) CI job that reports on flag age or usage. 4) Documentation of flag lifecycle/cleanup process. PASS if any dead flag detection mechanism exists. PREREQUISITE: feature_flag_infrastructure must pass.',
  isSkippable: true,
};

/**
 * Circuit Breakers criterion
 */
const READINESS_CIRCUIT_BREAKERS_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.CircuitBreakers,
  name: 'Circuit Breakers',
  description: 'Circuit breaker pattern implemented for resilience',
  category: ReadinessCategoryId.Debugging,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Application,
  instructions:
    "Circuit breakers – Check for circuit breaker pattern implementation. Look for: 1) Circuit breaker libraries (opossum, cockatiel for Node.js, resilience4j for Java, polly for .NET, tenacity for Python). 2) Service mesh with circuit breaking (Istio, Linkerd configuration). 3) Custom circuit breaker implementation (grep for 'circuit', 'breaker', 'fallback' patterns). 4) Retry with exponential backoff configuration. PASS if circuit breaker or resilience pattern is implemented for external calls. Skip for apps without external service dependencies (e.g., standalone tools, libraries).",
  isSkippable: true,
};

/**
 * Profiling Instrumentation criterion
 */
const READINESS_PROFILING_INSTRUMENTATION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.ProfilingInstrumentation,
  name: 'Profiling Instrumentation',
  description: 'Performance profiling infrastructure configured',
  category: ReadinessCategoryId.Debugging,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Profiling instrumentation – Check for performance profiling infrastructure. Look for: 1) APM tools (Datadog APM, New Relic, Dynatrace) in dependencies or config. 2) Continuous profiling (Pyroscope, Parca, Google Cloud Profiler). 3) Node.js profiling (clinic.js, 0x configured). 4) Memory profiling setup. 5) Flame graph generation capability. PASS if any profiling tooling is configured for production or development use. Skip for apps where performance profiling is not meaningful (e.g., libraries, simple scripts).',
  isSkippable: true,
};

/**
 * Large File Detection criterion
 */
const READINESS_LARGE_FILE_DETECTION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.LargeFileDetection,
  name: 'Large File Detection',
  description: 'Tooling detects/prevents overly large files',
  category: ReadinessCategoryId.Style,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Large file detection – Check for tooling that detects/prevents overly large files (language-agnostic). PASS if ANY ONE of the following exists: 1) Git hooks checking file size or line count (husky, pre-commit, custom scripts). 2) CI job that flags files over a threshold. 3) .gitattributes with LFS for large binary files. 4) Linter rules for file size (ESLint max-lines for JS/TS, pylint max-module-lines for Python, or equivalent). 5) Code quality platform with file size/complexity checks.',
};

/**
 * Heavy Dependency Detection criterion
 */
const READINESS_HEAVY_DEPENDENCY_DETECTION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.HeavyDependencyDetection,
  name: 'Heavy Dependency Detection',
  description: 'Bundle size analysis and heavy dependency detection',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Heavy dependency detection – Check for bundle size analysis and heavy dependency detection. Look for: 1) Bundle analyzer configured (webpack-bundle-analyzer, @next/bundle-analyzer, rollup-plugin-visualizer). 2) Size limit tools (size-limit, bundlesize, bundlewatch). 3) Import cost IDE extension configuration. 4) CI job that reports bundle size changes. 5) Lighthouse CI for performance budgets. PASS if any bundle/dependency size analysis is configured. Skip for non-bundled applications (e.g., backend services, CLI tools, server-side apps).',
  isSkippable: true,
};

/**
 * Unused Dependencies Detection criterion
 */
const READINESS_UNUSED_DEPENDENCIES_DETECTION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.UnusedDependenciesDetection,
  name: 'Unused Dependencies Detection',
  description: 'Tooling detects unused dependencies',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Unused dependencies detection – Check for tooling that detects unused dependencies in any language. PASS if ANY ONE of the following exists: 1) JS/TS: depcheck, npm-check, or knip configured. 2) Python: deptry or pip-extra-reqs. 3) Go: `go mod tidy` in CI (ensures go.mod only has used deps). 4) Rust: cargo-udeps. 5) Java/Maven: `mvn dependency:analyze` in CI. 6) Java/Gradle: dependency-analysis plugin. 7) Any CI job or pre-commit hook that checks for unused dependencies.',
};

/**
 * Tech Debt Tracking criterion
 */
const READINESS_TECH_DEBT_TRACKING_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.TechDebtTracking,
  name: 'Technical Debt Tracking',
  description: 'Tooling tracks technical debt markers',
  category: ReadinessCategoryId.Style,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Tech debt tracking – Tooling tracks technical debt markers. Common approaches: TODO/FIXME scanner in CI, TODO comments required to link to issues (e.g., TODO(TICKET-123) enforcement), language-specific linter rules (eslint-plugin-no-unsanitized-todo, pylint fixme), SonarQube/SonarCloud (has built-in technical debt tracking via SQALE methodology enabled by default; verify it is not explicitly disabled in sonar properties). Other tech debt tracking tools, code quality platforms, or documented tracking systems also satisfy this criterion.',
};

/**
 * Dead Code Detection criterion
 */
const READINESS_DEAD_CODE_DETECTION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.DeadCodeDetection,
  name: 'Dead Code Detection',
  description: 'Dead code detection tooling configured',
  category: ReadinessCategoryId.Style,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Dead code detection – Tooling detects unused/dead code. PASS if ANY ONE of the following exists: 1) JS/TS: knip, unimported, or ESLint import/no-unused-modules. 2) Python: vulture or dead. 3) Go: deadcode or staticcheck. 4) Rust: cargo-udeps. 5) Java: SpotBugs or PMD with unused code rules. 6) SonarQube/SonarCloud (has built-in unused code detection enabled by default; verify it is not explicitly disabled in sonar properties). 7) Any other dead code detector, CI check, or pre-commit hook that flags unused code. Check for config files at both repo root and app level (e.g., knip.json, .eslintrc, pyproject.toml). For monorepos, if a tool is configured at the repo root, read its config to determine which applications it covers (e.g., workspaces or include/exclude patterns) and count covered apps as passing.',
};

/**
 * Version Drift Detection criterion
 */
const READINESS_VERSION_DRIFT_DETECTION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.VersionDriftDetection,
  name: 'Version Drift Detection',
  description: 'Tooling detects dependency version drift across packages',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Version drift detection – Check for tooling that detects dependency version drift across monorepo packages. Look for: 1) syncpack, manypkg for JS/TS monorepos. 2) Renovate/Dependabot with grouping rules. 3) Custom CI script comparing package versions. 4) Monorepo tooling with version enforcement (Nx, Turborepo constraints). 5) Shared dependency constraints in workspace config. PASS if version consistency tooling exists for monorepos. Skip for single-application repos.',
  isSkippable: true,
};

/**
 * Code Modularization criterion
 */
const READINESS_CODE_MODULARIZATION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.CodeModularization,
  name: 'Code Modularization Enforcement',
  description: 'Tooling enforces code modularization and boundaries',
  category: ReadinessCategoryId.Style,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Code modularization – Check for tooling that enforces code modularization and boundaries. Skip for small projects where module boundaries are not meaningful, or Rust codebases (compiler enforces visibility). PASS if ANY ONE of the following exists: 1) JS/TS: eslint-plugin-boundaries, eslint-plugin-import/no-restricted-paths, dependency-cruiser, Nx module boundaries. 2) Java: ArchUnit configured for architecture tests. 3) Go: `internal/` package directories used (compiler-enforced boundaries). 4) Python: import-linter configured. 5) C#: ArchUnitNET. 6) Architectural fitness functions or layer enforcement in CI.',
  isSkippable: true,
};

/**
 * Duplicate Code Detection criterion
 */
const READINESS_DUPLICATE_CODE_DETECTION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.DuplicateCodeDetection,
  name: 'Duplicate Code Detection',
  description: 'Duplicate code (DRY) detection tooling configured',
  category: ReadinessCategoryId.Style,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Application,
  instructions:
    "Duplicate code detection – Tooling detects copy-paste or duplicate code to enforce DRY (Don't Repeat Yourself) principles. Common tools: jscpd (in CI or pre-commit), PMD CPD for Java, SonarQube/SonarCloud (has built-in CPD enabled by default; verify it is not explicitly disabled in sonar properties). Other duplication detectors, CI checks, or pre-commit hooks that flag duplicate code also satisfy this criterion.",
};

/**
 * N+1 Query Detection criterion
 */
const READINESS_N_PLUS_ONE_DETECTION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.NPlusOneDetection,
  name: 'N+1 Query Detection',
  description: 'N+1 query detection tooling configured',
  category: ReadinessCategoryId.Style,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'N+1 query detection – Check for N+1 query detection tooling. Look for: 1) bullet gem for Rails. 2) nplusone for Python/Django. 3) DataLoader pattern usage (graphql-dataloader). 4) ORM query logging with analysis. 5) Database query analysis in tests. 6) APM with slow query detection configured. PASS if any N+1 detection mechanism exists. Skip for apps without database/ORM usage (e.g., frontend-only apps, libraries, static sites).',
  isSkippable: true,
};

/**
 * Test Naming Conventions criterion
 */
const READINESS_TEST_NAMING_CONVENTIONS_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.TestNamingConventions,
  name: 'Test File Naming Conventions',
  description: 'Consistent test file naming enforcement',
  category: ReadinessCategoryId.Testing,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Test naming conventions – Check for consistent test file naming enforcement in any language. PASS if ANY ONE of the following exists: 1) JS/TS: Vitest testMatch/testRegex, Vitest include patterns, or Mocha test directory config. 2) Python: pytest naming conventions in pytest.ini or pyproject.toml (test_*.py pattern). 3) Go: *_test.go convention (built-in, check tests exist following pattern). 4) Java: Maven/Gradle test source directories with naming patterns. 5) Any test framework configured with explicit naming patterns. 6) Test naming conventions documented in AGENTS.md or CONTRIBUTING.md.',
};

/**
 * Test Isolation criterion
 */
const READINESS_TEST_ISOLATION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.TestIsolation,
  name: 'Test Isolation',
  description: 'Tests are configured for isolated/parallel execution',
  category: ReadinessCategoryId.Testing,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Application,
  instructions:
    'Test isolation – Check for test isolation enforcement in any language. PASS if ANY ONE of the following exists: 1) JS/TS: Vitest parallelization (not --runInBand), Vitest threads, or test sharding configured. 2) Python: pytest-xdist for parallel execution. 3) Go: `go test -parallel` or `t.Parallel()` usage. 4) Java: JUnit parallel execution config, or Maven/Gradle parallel test forks. 5) Database isolation patterns (transactions, test databases, factories, testcontainers). 6) Test randomization enabled (--randomize, pytest-randomly). 7) Any test framework configured for parallel or isolated execution.',
};

/**
 * AGENTS.md Validation criterion
 */
const READINESS_AGENTS_MD_VALIDATION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.AgentsMdValidation,
  name: 'AGENTS.md Freshness Validation',
  description: 'Automation validates AGENTS.md stays consistent with code',
  category: ReadinessCategoryId.Docs,
  level: ReadinessLevel.Level4,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'AGENTS.md validation – Check for automation that validates AGENTS.md stays consistent with code. Look for: 1) CI job that checks AGENTS.md commands still work. 2) Automated AGENTS.md generation/update (drool that updates it). 3) Pre-commit hook validating AGENTS.md commands. 4) Documentation testing (running commands from docs). 5) Link checker for AGENTS.md references. PASS if any validation of AGENTS.md accuracy exists. PREREQUISITE: agents_md must pass.',
};

/**
 * Release Automation criterion
 */
const READINESS_RELEASE_AUTOMATION_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.ReleaseAutomation,
  name: 'Release Automation',
  description: 'Automated release/deployment pipelines configured',
  category: ReadinessCategoryId.Build,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Release automation – Check for automated release/deployment pipelines. Look for: 1) CD pipeline in .github/workflows (deploy on merge to main). 2) semantic-release or similar configured. 3) GitOps setup (ArgoCD, Flux manifests). 4) Automated Docker image publishing. 5) Release-please or changesets automation. PASS if releases/deployments are automated rather than manual.',
};

/**
 * Minimum Release Age criterion
 */
const READINESS_MIN_RELEASE_AGE_CRITERION: ReadinessCriterion = {
  id: ReadinessCriterionId.MinReleaseAge,
  name: 'Minimum Dependency Release Age',
  description:
    'Dependencies are not adopted immediately after release, mitigating supply chain attacks',
  category: ReadinessCategoryId.Security,
  level: ReadinessLevel.Level3,
  scope: ReadinessCriterionScope.Repository,
  instructions:
    'Minimum dependency release age – Check for policies or tooling that enforce a minimum waiting period before adopting new dependency releases. Look for: 1) Renovate configured with `minimumReleaseAge` or `stabilityDays` (or an equivalent delay gate). 2) A documented dependency-update policy that explicitly requires waiting N days before merging version bumps. 3) Custom CI checks that verify the target release date is at least N days old. PASS only if there is an explicit delay (not just centralized updates or signature/provenance verification).',
};

/**
 * All criteria
 */
export const READINESS_CRITERIA: ReadinessCriterion[] = [
  // Style / Validation
  READINESS_LINT_CONFIG_CRITERION,
  READINESS_TYPE_CHECK_CRITERION,
  READINESS_FORMATTER_CRITERION,
  READINESS_PRE_COMMIT_HOOKS_CRITERION,
  READINESS_STRICT_TYPING_CRITERION,
  READINESS_NAMING_CONSISTENCY_CRITERION,
  READINESS_CYCLOMATIC_COMPLEXITY_CRITERION,
  READINESS_LARGE_FILE_DETECTION_CRITERION,
  READINESS_DEAD_CODE_DETECTION_CRITERION,
  READINESS_DUPLICATE_CODE_DETECTION_CRITERION,
  READINESS_CODE_MODULARIZATION_CRITERION,
  READINESS_TECH_DEBT_TRACKING_CRITERION,
  READINESS_N_PLUS_ONE_DETECTION_CRITERION,

  // Build System
  READINESS_BUILD_CMD_DOC_CRITERION,
  READINESS_DEPS_PINNED_CRITERION,
  READINESS_VCS_CLI_TOOLS_CRITERION,
  READINESS_AUTOMATED_PR_REVIEW_CRITERION,
  READINESS_AGENTIC_DEVELOPMENT_CRITERION,
  READINESS_FAST_CI_FEEDBACK_CRITERION,
  READINESS_BUILD_PERFORMANCE_TRACKING_CRITERION,
  READINESS_DEPLOYMENT_FREQUENCY_CRITERION,
  READINESS_SINGLE_COMMAND_SETUP_CRITERION,
  READINESS_FEATURE_FLAG_INFRASTRUCTURE_CRITERION,
  READINESS_RELEASE_NOTES_AUTOMATION_CRITERION,
  READINESS_PROGRESSIVE_ROLLOUT_CRITERION,
  READINESS_ROLLBACK_AUTOMATION_CRITERION,
  READINESS_MONOREPO_TOOLING_CRITERION,
  READINESS_HEAVY_DEPENDENCY_DETECTION_CRITERION,
  READINESS_UNUSED_DEPENDENCIES_DETECTION_CRITERION,
  READINESS_VERSION_DRIFT_DETECTION_CRITERION,
  READINESS_RELEASE_AUTOMATION_CRITERION,
  READINESS_DEAD_FEATURE_FLAG_DETECTION_CRITERION,

  // Testing
  READINESS_UNIT_TESTS_EXIST_CRITERION,
  READINESS_INTEGRATION_TESTS_EXIST_CRITERION,
  READINESS_UNIT_TESTS_RUNNABLE_CRITERION,
  READINESS_TEST_PERFORMANCE_TRACKING_CRITERION,
  READINESS_FLAKY_TEST_DETECTION_CRITERION,
  READINESS_TEST_COVERAGE_THRESHOLDS_CRITERION,
  READINESS_TEST_NAMING_CONVENTIONS_CRITERION,
  READINESS_TEST_ISOLATION_CRITERION,

  // Docs
  READINESS_AGENTS_MD_CRITERION,
  READINESS_README_CRITERION,
  READINESS_AUTOMATED_DOC_GENERATION_CRITERION,
  READINESS_SKILLS_CRITERION,
  READINESS_DOCUMENTATION_FRESHNESS_CRITERION,
  READINESS_API_SCHEMA_DOCS_CRITERION,
  READINESS_SERVICE_FLOW_DOCUMENTED_CRITERION,
  READINESS_AGENTS_MD_VALIDATION_CRITERION,

  // Dev Environment
  READINESS_DEVCONTAINER_CRITERION,
  READINESS_ENV_TEMPLATE_CRITERION,
  READINESS_LOCAL_SERVICES_SETUP_CRITERION,
  READINESS_DATABASE_SCHEMA_CRITERION,
  READINESS_DEVCONTAINER_RUNNABLE_CRITERION,

  // Debugging / Operations
  READINESS_STRUCTURED_LOGGING_CRITERION,
  READINESS_DISTRIBUTED_TRACING_CRITERION,
  READINESS_METRICS_COLLECTION_CRITERION,
  READINESS_CODE_QUALITY_METRICS_CRITERION,
  READINESS_ERROR_TRACKING_CONTEXTUALIZED_CRITERION,
  READINESS_ALERTING_CONFIGURED_CRITERION,
  READINESS_RUNBOOKS_DOCUMENTED_CRITERION,
  READINESS_DEPLOYMENT_OBSERVABILITY_CRITERION,
  READINESS_HEALTH_CHECKS_CRITERION,
  READINESS_CIRCUIT_BREAKERS_CRITERION,
  READINESS_PROFILING_INSTRUMENTATION_CRITERION,

  // Security
  READINESS_BRANCH_PROTECTION_CRITERION,
  READINESS_SECRET_SCANNING_CRITERION,
  READINESS_CODEOWNERS_CRITERION,
  READINESS_AUTOMATED_SECURITY_REVIEW_CRITERION,
  READINESS_DEPENDENCY_UPDATE_AUTOMATION_CRITERION,
  READINESS_GITIGNORE_COMPREHENSIVE_CRITERION,
  READINESS_DAST_SCANNING_CRITERION,
  READINESS_PII_HANDLING_CRITERION,
  READINESS_PRIVACY_COMPLIANCE_CRITERION,
  READINESS_SECRETS_MANAGEMENT_CRITERION,
  READINESS_LOG_SCRUBBING_CRITERION,
  READINESS_MIN_RELEASE_AGE_CRITERION,

  // Task Discovery
  READINESS_ISSUE_TEMPLATES_CRITERION,
  READINESS_ISSUE_LABELING_SYSTEM_CRITERION,
  READINESS_BACKLOG_HEALTH_CRITERION,
  READINESS_PR_TEMPLATES_CRITERION,

  // Product & Experimentation
  READINESS_PRODUCT_ANALYTICS_INSTRUMENTATION_CRITERION,
  READINESS_ERROR_TO_INSIGHT_PIPELINE_CRITERION,
];

// -----------------------------------------------------------------------------
// Category Definitions
// -----------------------------------------------------------------------------

/**
 * Style/Validation category
 */
const READINESS_STYLE_CATEGORY: ReadinessCategory = {
  id: ReadinessCategoryId.Style,
  name: 'Style & Validation',
  description:
    'Code quality tools that catch errors early in the development process',
};

/**
 * Build System category
 */
const READINESS_BUILD_CATEGORY: ReadinessCategory = {
  id: ReadinessCategoryId.Build,
  name: 'Build System',
  description: 'Clear and reproducible build process',
};

/**
 * Testing category
 */
const READINESS_TESTING_CATEGORY: ReadinessCategory = {
  id: ReadinessCategoryId.Testing,
  name: 'Testing',
  description: 'Automated tests that verify code correctness',
};

/**
 * Documentation category
 */
const READINESS_DOCS_CATEGORY: ReadinessCategory = {
  id: ReadinessCategoryId.Docs,
  name: 'Documentation',
  description: 'Clear instructions for agents and developers',
};

/**
 * Development Environment category
 */
const READINESS_DEV_ENV_CATEGORY: ReadinessCategory = {
  id: ReadinessCategoryId.DevEnv,
  name: 'Development Environment',
  description: 'Consistent and reproducible development environment',
};

/**
 * Debugging category
 */
const READINESS_DEBUGGING_CATEGORY: ReadinessCategory = {
  id: ReadinessCategoryId.Debugging,
  name: 'Debugging & Observability',
  description: 'Tools for understanding runtime behavior',
};

/**
 * Security category
 */
const READINESS_SECURITY_CATEGORY: ReadinessCategory = {
  id: ReadinessCategoryId.Security,
  name: 'Security',
  description: 'Protections against vulnerabilities and mistakes',
};

/**
 * Task Discovery category
 */
const READINESS_TASK_DISCOVERY_CATEGORY: ReadinessCategory = {
  id: ReadinessCategoryId.TaskDiscovery,
  name: 'Task Discovery',
  description: 'Infrastructure for agents to find and scope work autonomously',
};

/**
 * Product & Experimentation category
 */
const READINESS_PRODUCT_CATEGORY: ReadinessCategory = {
  id: ReadinessCategoryId.Product,
  name: 'Product & Experimentation',
  description:
    'Tools for measuring impact, running experiments, and understanding user behavior',
};

/**
 * All categories
 */
export const READINESS_CATEGORIES: ReadinessCategory[] = [
  READINESS_STYLE_CATEGORY,
  READINESS_BUILD_CATEGORY,
  READINESS_TESTING_CATEGORY,
  READINESS_DOCS_CATEGORY,
  READINESS_DEV_ENV_CATEGORY,
  READINESS_DEBUGGING_CATEGORY,
  READINESS_SECURITY_CATEGORY,
  READINESS_TASK_DISCOVERY_CATEGORY,
  READINESS_PRODUCT_CATEGORY,
];

/**
 * Category map for quick lookup
 */
export const READINESS_CATEGORY_MAP: Record<
  ReadinessCategoryId,
  ReadinessCategory
> = READINESS_CATEGORIES.reduce(
  (map, category) => ({ ...map, [category.id]: category }),
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- reduce initial value must be empty; all keys are populated by the array iteration
  {} as Record<ReadinessCategoryId, ReadinessCategory>
);

// -----------------------------------------------------------------------------
// Grade Constants
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Level System Constants (New)
// -----------------------------------------------------------------------------

/**
 * Readiness level definitions
 */
export const READINESS_LEVELS: ReadinessLevelDefinition[] = [
  {
    level: ReadinessLevel.Level1,
    name: 'Basic',
    description: 'Table stakes. Basic tooling that catches obvious mistakes.',
    thresholdPercent: 80,
  },
  {
    level: ReadinessLevel.Level2,
    name: 'Infrastructure',
    description: 'Invested in infrastructure, CI/CD, and process.',
    thresholdPercent: 80,
  },
  {
    level: ReadinessLevel.Level3,
    name: 'Advanced',
    description: 'Security, observability, and end-to-end validation.',
    thresholdPercent: 80,
  },
  {
    level: ReadinessLevel.Level4,
    name: 'Expert',
    description: 'Mastered advanced readiness criteria.',
    thresholdPercent: 80,
  },
  {
    level: ReadinessLevel.Level5,
    name: 'Autonomous',
    description:
      'Enables agents to operate independently, discover work, and maintain quality without human intervention.',
    thresholdPercent: 80,
  },
];
