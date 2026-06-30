---
name: install-qa
description: >
  Set up automated QA testing for this project. Performs deep codebase analysis,
  asks targeted questions, and generates a modular QA skill with sub-skills per app,
  a GitHub Actions workflow, and a report template. This is a complex, multi-phase
  process -- quality assurance is foundational and we take the time to get it right.
user-invocable: true
---

    ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
    ░░                                          ░░
    ░░   ╔═╗ ╔╗╔ ╔═╗ ╔╦╗ ╔═╗ ╦   ╦   ╔═╗ ╔═╗  ░░
    ░░   ║ ║ ║║║ ╚═╗  ║  ╠═╣ ║   ║   ║ ║ ╠═╣  ░░
    ░░   ╚═╝ ╝╚╝ ╚═╝  ╩  ╩ ╩ ╩═╝ ╩═╝ ╚═╝ ╩ ╩  ░░
    ░░                                          ░░
    ░░   ▸ Deep codebase analysis               ░░
    ░░   ▸ Interactive questionnaire            ░░
    ░░   ▸ Multi-phase skill generation         ░░
    ░░   ▸ GitHub Actions workflow setup        ░░
    ░░                                          ░░
    ░░   Quality assurance is foundational.     ░░
    ░░   We take the time to get this right.    ░░
    ░░                                          ░░
    ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

> **⚠️ Complexity Warning:** This skill performs deep codebase analysis, runs a multi-phase
> interactive questionnaire, and generates multiple files. It is a HIGH complexity task.

# Install QA

Clear all previous plans and todos. Your previous task is complete. Your new task is to set up automated QA for this project.

**Before starting, create a todo list from the phases below.**

You are setting up a modular QA skill for this project. The skill will be used to run automated functional tests against the application -- driven by a real browser (agent-browser), TUI testing (tuistory), or API calls (curl) depending on the app type.

## Output Structure

You will generate skills at `.industry/skills/` with this structure:

```
.industry/skills/qa/
  SKILL.md                  # Orchestrator: reads diff, routes to relevant sub-skills
  config.yaml               # All env/auth/integration config (single source of truth)
  REPORT-TEMPLATE.md        # Standardized report template
  .install-progress.yaml    # Partial questionnaire progress for resume
.industry/skills/qa-<app-name>/
  SKILL.md                  # One sub-skill per testable app (e.g., qa-web, qa-cli, qa-backend)
```

**Naming convention:** Sub-skills MUST be named `qa-<app-name>` (e.g., `qa-web`, `qa-cli`, `qa-backend`). Each is a standalone skill with its own `SKILL.md` frontmatter so the Industry skill system can discover and invoke them independently. The top-level `qa` skill orchestrates them.

---

# Phase 1: Check for Previous Progress

Check if `.industry/skills/qa/.install-progress.yaml` exists. If it does:

1. Read it and show the user what was previously configured
2. Ask if they want to keep previous answers as defaults or start completely fresh
3. Either way, re-ask ALL categories (using previous answers as defaults if resuming) and regenerate ALL files. Never skip generation -- the user may give different answers or the generation rules may have changed.
4. If starting fresh, delete the progress file and proceed from scratch

---

# Phase 2: Deep Codebase Analysis

Scan the repository thoroughly. You must AUTO-DETECT all of the following without asking the user. Present your findings as a summary before asking any questions.

## What to detect:

### App Structure

- Is this a monorepo? What apps exist? (look at top-level directories, workspace configs in package.json/pnpm-workspace.yaml/turbo.json)
- For each app: what is it? (web frontend, API backend, CLI tool, mobile app, desktop app)
- What path patterns map to each app?

### Tech Stack

- Framework and language per app (package.json, Cargo.toml, go.mod, requirements.txt, etc.)
- Build commands and dev server commands

### Authentication

- How do users log in? (search for OAuth providers, auth middleware, login components, session management)
- What auth library is used? (NextAuth, Passport, WorkOS, Auth0, Clerk, Firebase Auth, etc.)

### Environments

- Find all environment URLs from: .env files, .env.example, config files, CI/CD workflows, deployment manifests, README
- Find environment-specific configuration patterns

### Feature Flags

- Search for imports of: LaunchDarkly, Statsig, Unleash, Split, Flagsmith, or custom feature flag patterns
- How are flags evaluated in the code?

### External Integrations

- Payment: Stripe, Braintree, PayPal (search dependencies + imports)
- Email: SendGrid, SES, Postmark, Resend, AgentMail, Mailhog
- SMS: Twilio, MessageBird
- Other: search package.json dependencies for known SaaS SDKs

### CI/CD

- What CI provider? (.github/workflows, .gitlab-ci.yml, Jenkinsfile, .circleci)
- Any existing QA or E2E test workflows?

### Existing Test Infrastructure

- What test frameworks are used? (Vitest, Playwright, Cypress, pytest, etc.)
- Any existing E2E or integration tests?

### Critical User Flows

- Analyze route definitions, navigation, page components to identify the main user flows
- Look at: router config, page/view components, API endpoints, form submissions

Present ALL findings to the user in a structured summary before proceeding to questions.

---

# Phase 3: Targeted Questionnaire

Ask ONLY what you could not auto-detect. Group questions using the AskUser tool. Save answers to `.industry/skills/qa/.install-progress.yaml` after each group is answered.

**Important:** Always present your findings first, then ask for confirmation or gaps. Frame questions around what you found, not from scratch.

## Category 1: Default QA Target

- "I found these environments: [list]. Which should QA run against by default?"
- "Any restrictions on specific environments?" (e.g., "never create real users in prod")

Save progress after this category.

## Category 2: Personas & Roles

Frame this carefully: "QA needs to test your app as different types of users. This ensures permissions work correctly -- an admin can manage settings, a regular member can do their work, and a read-only viewer truly cannot edit anything. Each persona represents a real user type."

Ask:

- "What user roles exist in your app? For each role, I need:
  (a) A short name (e.g., admin, member, viewer, guest)
  (b) What they CAN do (key capabilities)
  (c) What they should NOT be able to do (this becomes a negative test)
  (d) Do you have a dedicated test account for this role? If so, what email?"
- "For roles without test accounts, should QA create them via signup during the test run, or will you provide them?"
- "Where are test credentials stored?" (env var name, AWS Secrets Manager key, HashiCorp Vault path, or they'll be entered manually)

Save progress after this category.

## Category 3: Critical Flows (confirm + extend)

- "Based on my analysis, these are the critical user flows I identified: [list]. Are these correct? Any to add or remove?"
- "For each flow, what is the success criteria? (e.g., 'user sees dashboard after login', 'payment confirmation email received')"
- "Should any flow be tested with multiple personas? (e.g., 'verify that viewers cannot access the admin settings page')"
- "Do any flows create persistent data that needs cleanup after testing?"
  Save progress after this category.

## Category 4: External Services (only if you detected integrations)

For each detected integration:

- "I see [ServiceName] in your dependencies. Does it have a sandbox/test mode? What test credentials should QA use?"
- For email: "How should QA receive test emails during signup/notification flows?" (Only ask if no AgentMail/Mailhog/test SMTP was detected)

Save progress after this category.

## Category 5: Cleanup

- "After QA creates test users or data, how should it clean up?" Options:
  - Delete via API endpoint (which one?)
  - Admin panel cleanup
  - Database reset command
  - Leave for manual cleanup
  - Not applicable (tests are read-only)

Save progress after this category.

## Category 6: ImageMagick

Check if ImageMagick is installed:

```bash
command -v magick || command -v convert
```

- If already installed: set `imagemagick: true` in config.yaml, tell the user "ImageMagick detected -- QA will generate animated GIF diffs of before/after screenshots."
- If NOT installed: ask "ImageMagick enables animated GIF diffs of before/after screenshots for visual regression testing. Would you like to install it?"
  - If yes: run `brew install imagemagick` (macOS) or `sudo apt-get install -y imagemagick` (Linux), set `imagemagick: true`
  - If no: set `imagemagick: false`

## Category 7: GitHub Action (only if .github/ directory exists)

- First, check if existing QA workflows already exist in `.github/workflows/`. If they do, list them.
- "Would you like me to generate a GitHub Actions workflow that runs QA automatically on PRs?"
- If yes, ask: "Should the QA check be **required** (blocks merge if it fails) or **optional** (runs but doesn't block merge)?"
  - If required: no extra config needed (repo admins add it to branch protection rules)
  - If optional: add a note in the generated workflow file that this check is informational only
- If the project uses Vercel/Netlify preview deployments for PRs, ask: "I detected that PRs get a Vercel preview deployment. Should the QA workflow wait for the preview to be deployed before running tests?" (Default: yes)

## Category 8: Failure Learning

"When QA hits a new failure pattern (e.g., auth wall, missing env var, flaky element), how should it feed that back so future runs handle it better?"

Present these options:

1. **Suggest in report (default)** -- The QA report includes a "Suggested Skill Updates" section with ready-to-copy markdown snippets that can be pasted into the sub-skill's Known Failure Modes section. The snippet is inside a collapsed `<details>` block with a clear label like "Copy this into qa-web/SKILL.md under Known Failure Modes".
2. **Auto-commit** -- The agent directly commits updates to the sub-skill files after each run. Requires `contents: write` permission in the workflow.
3. **Open a PR** -- The agent opens a PR with the failure catalog updates. Someone reviews and merges it.

Save the choice as `failure_learning` in config.yaml (values: `suggest_in_report`, `auto_commit`, `open_pr`).

**Implementation per option:**

For `suggest_in_report`: The orchestrator SKILL.md must instruct the agent to append a "Suggested Skill Updates" section to the report whenever a BLOCKED or FAIL result reveals a new failure pattern not already in the sub-skill's Known Failure Modes. The suggestion must include the exact markdown to add, the target file path, and where to insert it. Example:

```markdown
### Suggested Skill Updates

<details>
<summary>Add to .industry/skills/qa-web/SKILL.md → Known Failure Modes</summary>

\\`\\`\\`markdown
6. **WorkOS password field not found.** Some WorkOS configurations show OTP-only login without a password field. If the password input is not found, report as BLOCKED and note the WorkOS configuration.
\\`\\`\\`

</details>
```

For `auto_commit` or `open_pr`: The workflow must have `contents: write` and `pull-requests: write` permissions. The agent writes a `qa-results/skill-updates.json` file with structured edits. A workflow step after the QA run parses this JSON and applies the edits to the actual repo files, then either commits directly (`auto_commit`) or opens a draft PR (`open_pr`). See the workflow template section for the exact implementation.

Save progress after this category.

---

# Phase 4: Generate the QA Skill

Using all gathered information, generate the following files:

## 4a. config.yaml

Generate `.industry/skills/qa/config.yaml` with all configuration as a single source of truth. Follow this structure:

```yaml
project: <ProjectName>
imagemagick: <true|false>
environments:
  <env-name>:
    url: <url>
    restrictions: [<optional list>]

default_target: <env-name>

auth:
  method: <otp|oauth|email-password|magic-link|api-key|saml>
  provider: <WorkOS|Auth0|Clerk|Firebase|custom|etc>

personas:
  - name: <role-name>
    description: '<what this user type does>'
    email: <test-account-email>
    credentials_source: <aws-secrets-manager|env-var|vault|manual>
    secret_name: <secret-key-or-env-var> # if applicable
    test_focus: [<areas to test as this persona>]
    cannot_do: [<things this persona must NOT be able to do>]
  - name: new_user
    description: 'Fresh signup, no existing data'
    email_pattern: 'qa+signup_{RUN_ID}@<domain>'
    test_focus: ['onboarding', 'empty states', 'first-run experience']

apps:
  <app-name>:
    path_patterns: [<glob patterns>]
    skill: qa-<app-name>
    test_tool: <agent-browser|tuistory|curl>
    build_command: '<optional build command>'

feature_flags:
  provider: <provider-name|none>
  dashboard_url: <url>
  how_to_override: '<instructions>'

integrations:
  <integration-type>:
    provider: <provider-name>
    # provider-specific config

cleanup:
  auto_cleanup: <true|false>
  strategy: <delete-test-users|reset-db|api-call|manual|none>
  instructions: '<how to clean up>'

failure_learning: <suggest_in_report|auto_commit|open_pr>
```

**Environment behavior for preview deployments:** If the project uses Vercel/Netlify preview deployments, the config MUST document that preview URLs behave like the dev environment (same backend, same database, same API keys). The orchestrator and sub-skills should use dev-environment flows (e.g., Stripe test cards, dev API keys) when testing against a preview URL. Do NOT generate separate prod/preprod QA flows that run against preview URLs -- they will fail because preview backends don't have prod data (voucher codes, production Stripe keys, etc.).

## 4b. SKILL.md (Orchestrator)

Generate `.industry/skills/qa/SKILL.md`. This is the main orchestrator that gets loaded into context. It must be LIGHTWEIGHT -- it should NOT contain the actual test flows (those live in separate `qa-<app-name>` sub-skills). It should:

````markdown
---
name: qa
description: >
  Run QA tests for <ProjectName>. Analyzes git diff to determine affected areas,
  runs configured test flows with multiple personas, and generates diff-targeted tests.
  Uses agent-browser for web testing, tuistory for CLI testing.
  Use when testing PRs, releases, or smoke testing environments.
---

# QA Orchestrator

**SCOPE: This skill performs manual/functional QA only -- verifying that the application actually works by interacting with it as a real user would (browser, TUI, API calls). Do NOT run or report on CI checks, linting, ESLint, typecheck, unit tests, or any static analysis. Those are handled by separate workflows.**

## Step 1: Load Configuration

Read `.industry/skills/qa/config.yaml` for environment URLs, credentials, personas, and app definitions.

## Step 2: Determine Target Environment

Use the default_target from config unless the user specifies a different environment.
Respect any environment restrictions (e.g., no user creation in prod).

**CRITICAL: Vercel/Netlify preview deployments are DEV environments.** Preview URLs serve the branch's frontend code but connect to the same backend, database, Stripe keys, and third-party integrations as the dev environment. Therefore:

- Use **dev flows** when testing against a preview URL (e.g., Stripe test cards, dev API keys, dev feature flags)
- Do NOT use prod/preprod flows against a preview URL (e.g., voucher codes, production Stripe, preprod-specific data). These will fail because the preview backend doesn't have prod data.
- The orchestrator must treat preview URLs as equivalent to the `development` environment in config.yaml.

## Step 3: Analyze Git Diff

Run `git diff` to determine what changed. Map changed files to apps using the path_patterns in config.yaml.

Files that don't match ANY app's path_patterns (e.g., `.industry/skills/**`, `docs/**`, `.github/**`, config files) are NOT associated with any app. Do NOT run app test flows for them.

For each affected app:

- Run ONLY that app's flows from its module file
- Generate ADDITIONAL targeted tests based on the specific changes in the diff

For apps NOT affected by the diff:

- Do NOT load or run their module. Do NOT run their flows. Do NOT run their pre-flight checks. They are completely out of scope.
- Do NOT test CLI if only web files changed. Do NOT test backend if only CLI files changed. The diff determines scope, period.

If NO app is affected by the diff (e.g., docs-only, CI-only, or config-only changes), report as INCONCLUSIVE: "No app code changed -- QA not applicable for this diff." Do NOT run any app flows.

## Step 4: Pre-flight Checks (app-specific only)

Run pre-flight checks ONLY for the apps that are affected by the diff. For example:

- AgentMail/email API check → only if a web app with signup/login flows is affected
- CLI binary build → only if the CLI app is affected

**Web app testing in CI:** When testing web/frontend changes on a PR branch, the agent MUST test against the actual branch code, not whatever is deployed to dev/staging. During codebase analysis (Phase 2), detect which strategy the project uses:

**Strategy 1 (preferred): Vercel/Netlify preview deployments.** If the repo has a workflow that deploys preview URLs on PRs (look for Vercel, Netlify, or similar deployment workflows that post preview URLs as PR comments), the QA workflow should:

1. Wait for the deployment workflow to complete (use `workflow_run` trigger or poll for the PR comment with the preview URL)
2. Extract the preview URL from the PR comment (look for markers like `<!-- vercel-deploy-web -->` or similar)
3. Use that URL as the base for all browser tests

**Strategy 2 (fallback): Local dev server.** If no preview deployment is available:

1. Start the dev server from the checked-out branch code in the background
2. Wait for it to be ready (poll localhost until it responds)
3. Test against localhost

The generated qa-web sub-skill MUST document which strategy to use based on what was detected. If the project uses preview deployments, the workflow MUST wait for the deployment to be ready before running QA.

Do NOT run pre-flight checks for apps that are NOT affected. If a pre-flight check fails for an affected app, report it as BLOCKED with the specific error and remediation steps -- but still proceed with other affected apps.

## Step 5: Execute Diff-Relevant Flows Only

For each app that IS affected by the diff, read its sub-skill from `.industry/skills/qa-<app-name>/SKILL.md`.

The sub-skill contains a MENU of available test flows. You must:

1. Read the diff carefully and identify which flows are relevant to the change
2. Run those flows PLUS any adjacent flows that verify the change integrates correctly (e.g., if a new command is added, test that it appears in /help, that the CLI starts, that fuzzy search finds it)
3. Do NOT run completely unrelated flows (e.g., if the diff only adds a CLI command, do NOT test /settings, /model, billing, or chat)
4. If no existing flow covers the change, write a NEW ad-hoc test that directly verifies the changed behavior
5. Do NOT run unit tests, lint, typecheck, or any automated test suite. This is manual/functional QA -- interact with the app as a real user would.

## Step 6: Evidence Capture

After each significant test step, capture evidence. Use **text snapshots as primary evidence** -- they render inline in the PR comment with no image hosting issues.

For CLI/TUI apps (tuistory):

- Use `tuistory -s <session> snapshot --trim` to capture terminal state as text
- Embed the snapshot directly in the report as a fenced code block with a descriptive label
- Each snapshot MUST show something DIFFERENT. Wait for the UI to change before capturing again.

For web apps (agent-browser):

- Use `agent-browser snapshot` to capture the page's accessibility tree as text evidence
- Save screenshot files to `./qa-results/$RUN_ID/` for the artifact upload
- Do NOT embed `![image](url)` markdown in the report -- screenshot images cannot be displayed inline in GitHub PR comments. Instead, mention the filename and note that it's available in the downloadable artifacts.

Evidence quality rules:

- Focus on the RELEVANT content. Trim snapshots to the meaningful part.
- Label each snapshot clearly: what it shows and why it matters for the test.
- NEVER embed broken image links. If you can't verify an image URL will resolve, use text evidence instead.
- The workflow uploads all files in `./qa-results/` as a downloadable artifact -- reference that for visual evidence.

## Step 7: Test Quality Gate

TEST QUALITY REQUIREMENTS:

1. CHANGE-SPECIFIC FIRST. Prioritize tests that directly verify the behavioral change in the diff. At least half your tests should be testing the new/changed feature itself.
2. INTEGRATION TESTS ARE VALID. Tests that verify the change integrates correctly with existing features are good (e.g., new command shows in /help, fuzzy search finds it, CLI starts without errors). These are NOT smoke tests -- they verify the change didn't break integration points.
3. NO UNRELATED FLOWS. Do NOT test features completely unrelated to the diff (e.g., don't test /settings when only /install-qa changed, don't test billing when only CLI changed).
4. NO AUTOMATED TEST SUITES. Do NOT run vitest, npm test, or any CI-style checks. This is manual/functional QA only.
5. NEGATIVE TESTS. Include at least 1 test verifying error handling or boundary conditions related to the change.
6. INTERACTIVE TESTING. Test by actually interacting with the app as a real user would.
7. INCONCLUSIVE IF UNSURE. If you cannot articulate what the PR changes, mark as INCONCLUSIVE rather than PASS.

## Step 8: Handle Failures

**Never silently skip a flow.** If a flow cannot complete, report it as BLOCKED with what was tried and how the user can fix it. Then continue to the next flow -- never abort the entire run for a single failure.

## Step 9: Generate Report

Generate the report at `./qa-results/report.md` using `.industry/skills/qa/REPORT-TEMPLATE.md`.

The report MUST follow the template in `.industry/skills/qa/REPORT-TEMPLATE.md`. Key rules:

- Start with `## QA Report` heading followed by the test results table
- Result column MUST use emojis: :white_check_mark: PASS, :x: FAIL, :no_entry: BLOCKED, :warning: FLAKY, :grey_question: INCONCLUSIVE
- Keep it CONCISE. The table + a short "Action Required" section (if any) + collapsed screenshots = the entire report.
- Do NOT include: "Behavioral Change Summary", "Blocked Flows" prose, "Info" metadata table, or verbose explanations of what the diff does. The reviewer already knows that.
- Do NOT report setup/prerequisite steps (building, startup, launching) as test rows. Those are means to an end, not test cases. Only report rows that verify actual user-facing behavior or the specific behavioral change from the diff.
- Put ALL evidence in a single collapsed `<details>` block
- For TUI evidence: embed text snapshots as labeled fenced code blocks (e.g., `### Snapshot 1: Autocomplete dropdown` followed by a code block with the terminal output).
- For web evidence: embed accessibility tree snapshots as text. Reference screenshot filenames for visual proof (available in downloadable artifacts). Do NOT use `![image](url)` markdown -- the URLs won't resolve and will show broken images.

## Step 10: Suggest Skill Updates (Failure Learning)

After generating the report, check if any BLOCKED or FAIL results revealed a **testing environment insight** that would help future QA runs succeed. This is about learning how the testing environment works, NOT about fixing bad selectors or skill typos.

**Good suggestions** (environment/workflow knowledge):

- "WorkOS renders in Afrikaans locale -- always use `snapshot -i` to discover button labels dynamically"
- "Feature flag X must be enabled in Statsig before testing this flow"
- "Stripe checkout iframe takes 15+ seconds to load -- increase wait to 20s"
- "The dev server requires `npm run dev:web`, not `npm run dev`"

**Bad suggestions** (skill bugs, not environment insights -- do NOT suggest these):

- "Selector data-testid=foo doesn't exist" -- that's a skill bug, fix it directly
- "The button text changed from X to Y" -- that's expected from the PR diff

Format as a table with severity, collapsible fix prompts, and a count in the heading:

## Suggested Skill Updates (N issues found)

| #   | Severity        | File     | Issue               | Fix Prompt                                                                           |
| --- | --------------- | -------- | ------------------- | ------------------------------------------------------------------------------------ |
| 1   | <emoji> <level> | `<file>` | <short description> | <details><summary>Copy</summary><br>`<full drool prompt to fix the issue>`</details> |

**Severity levels:**

- `🔴 Breaking` -- Causes test failures every run (wrong URL, wrong auth method, missing required step)
- `🟡 Degraded` -- Causes intermittent failures or suboptimal behavior (timing issues, rate limits, locale assumptions)
- `🔵 Info` -- New knowledge that improves future runs but doesn't cause failures (new UI pattern, new endpoint)

Each Fix Prompt must be a self-contained instruction that Drool can execute directly when pasted.

Do NOT suggest updates for failures already covered in Known Failure Modes, bad selectors, or expected behavior changes from the PR. If no genuinely new environment insights were discovered, omit this section entirely.

Read the `failure_learning` field from config.yaml to determine the strategy:

- `suggest_in_report` (default): include the table in the PR comment report only. Do NOT write `skill-updates.json`.
- `auto_commit` or `open_pr`: include the table in the report AND write a `qa-results/skill-updates.json` file so the workflow can apply the edits outside the sandbox. The workflow handles committing/PR creation -- the agent just writes the JSON.

**`skill-updates.json` format** (only for `auto_commit` or `open_pr`):

```json
[
  {
    "file": ".industry/skills/qa-web/SKILL.md",
    "section": "Known Failure Modes",
    "action": "append",
    "content": "6. **WorkOS Afrikaans locale.** The login form renders in Afrikaans. Always use `snapshot -i` to discover button labels dynamically."
  }
]
```

Fields:

- `file`: relative path to the skill file to edit
- `section`: the markdown heading to find (e.g., `Known Failure Modes`, `Authentication Method`)
- `action`: `append` (add after the section's last item) or `replace` (replace the entire section content)
- `content`: the exact markdown to insert

The workflow will parse this file and apply the edits to the actual repo files, then commit or open a PR depending on the mode.

## 4c. App Sub-Skills (qa-<app-name>)

For EACH detected app, generate a dedicated sub-skill at `.industry/skills/qa-<app-name>/SKILL.md` (e.g., `qa-web/SKILL.md`, `qa-cli/SKILL.md`, `qa-backend/SKILL.md`).

Each sub-skill MUST have proper frontmatter so the Industry skill system recognizes it:

```markdown
---
name: qa-<app-name>
description: >
  QA tests for the <app-name> app. [brief description of what it tests]
---
```
````

Each sub-skill should contain:

- App-specific configuration notes (e.g., "chat input is a contenteditable div")
- A **menu of available test flows** -- these are NOT a checklist. The orchestrator picks only the flows relevant to the current diff. Label each flow clearly so the orchestrator can match it to changed code.
- Per-persona test variations
- Error handling specific to that app
- Known UI quirks or workarounds

### Web/frontend app testing in CI (MANDATORY for web apps)

Web app sub-skills MUST include a "Testing Target" section that tells the agent how to get a URL with the branch's actual code. Based on what you detected in Phase 2:

**If the repo uses Vercel/Netlify preview deployments:** The sub-skill should instruct the agent to:

1. Use the preview URL passed by the workflow (via env var or prompt) -- do NOT re-resolve it
2. If a Vercel bypass secret is needed, apply it on the first request
3. If no preview URL was provided, report ALL web tests as BLOCKED: "No Vercel preview URL available -- cannot verify branch code." Do NOT fall back to dev/staging/prod URLs -- those deployments run different code than the PR branch and testing against them produces meaningless results.

**If the repo does NOT use preview deployments:** The sub-skill should instruct the agent to:

1. Start the dev server locally (include the exact command, e.g., `npm run dev:web`)
2. Poll localhost until ready
3. Use localhost as the base URL

**CRITICAL:** The sub-skill MUST NEVER fall back to a remote environment (dev, staging, prod) when testing a PR branch. Remote environments run different code -- testing against them tells you nothing about the PR's changes. Either use the preview URL or start a local dev server. If neither is available, report BLOCKED.

### Authentication in CI

Sub-skills that require authentication MUST document which env vars provide auth and how to use them. The sub-skill should note:

- Which env vars are needed for this app (API keys, tokens, credentials)
- That these are provided by the CI workflow via GitHub secrets -- the agent does NOT need to log in interactively
- How the app consumes the credentials (env var auto-pickup, CLI flag, config file, etc.)

The specific secret names come from what you discovered in Phase 2 (codebase analysis). Use whatever auth mechanism the project already uses -- do NOT hardcode Industry-specific patterns.

Structure each module like the existing automated-qa-dev/automated-qa-prod skills -- with detailed, battle-tested steps that handle edge cases (locale variations, loading delays, iframe issues, etc.).

IMPORTANT: Each sub-skill is self-contained. It should include everything needed to test that app without referencing other sub-skills. The orchestrator SKILL.md loads only the relevant sub-skill(s).

### CLI/TUI testing with tuistory (MANDATORY for CLI apps)

For CLI/TUI apps, the generated sub-skill MUST require **interactive TUI testing** -- building the binary, launching it via tuistory, sending real keystrokes, and verifying actual terminal output. Running unit tests or `drool exec` alone is NOT sufficient QA testing. The sub-skill must instruct the agent to **use the `drool-control` skill for all tuistory interactions**. The drool-control skill contains the complete, correct tuistory API reference. Do NOT write raw tuistory commands in the sub-skill -- instead write instructions like:

```
Use the `drool-control` skill for all tuistory interactions.

1. Launch the CLI binary: tuistory launch "$CLI_BINARY" -s qa-test --cols 110 --rows 36
2. Wait for the prompt to appear
3. Type a command and verify the output
4. Take a screenshot for evidence
```

The app module should describe WHAT to test (launch CLI, type "/help", verify output), not HOW to call tuistory. The drool-control skill handles the HOW.

Additional CI notes for the app module:

- In CI, prefix launch with `env -u CI INDUSTRY_DISABLE_KEYRING=true` to avoid Ink CI detection
- Use session name `-s qa-test` with `--cols 110 --rows 36`

## 4d. REPORT-TEMPLATE.md

Generate `.industry/skills/qa/REPORT-TEMPLATE.md`:

```markdown
## QA Report

| #   | Test Case | App | Persona | Result | Notes |
| --- | --------- | --- | ------- | ------ | ----- |

{{TEST_ROWS}}

Result values: :white_check_mark: PASS, :x: FAIL, :no_entry: BLOCKED, :warning: FLAKY, :grey_question: INCONCLUSIVE

{{#if ACTIONABLE_ITEMS}}

### Action Required

{{ACTIONABLE_ITEMS}}
{{/if}}

<details>
<summary>Screenshots & Evidence</summary>

{{EVIDENCE}}

</details>
```

## 4f. Failure Handling

The generated SKILL.md must include this rule: **"Never silently skip a flow. If a flow cannot complete, report it as BLOCKED with what was tried and how the user can fix it."**

Each app module should include a "Known Failure Modes" section at the bottom, populated with app-specific quirks discovered during the codebase scan.

## 4e. GitHub Actions Workflow (only if user said yes in Category 7)

### Replace existing QA workflows

First, check for any existing QA-related workflows in `.github/workflows/` (e.g., `cli-qa-drool-exec.yml`, `automated-qa-prod.yml`, `automated-qa-dev.yml`). The new unified `qa.yml` replaces ALL of them. Delete or rename the old workflows and note this in the verification summary so the user can review.

### Generate `.github/workflows/qa.yml` following these patterns:

**Triggers:**

- If the project uses preview deployments AND the user said to wait for them: use `workflow_run` trigger that runs AFTER deployment workflows complete. During codebase analysis, identify ALL deployment workflows that produce preview URLs (frontend and backend may deploy separately). The QA workflow must wait for all of them so that all preview environments are ready before testing. Example:
  ```yaml
  on:
    workflow_run:
      workflows: ['<deploy-frontend-workflow>', '<deploy-backend-workflow>'] # list ALL deploy workflows found
      types: [completed]
  ```
  If any deployment fails, QA should still run but report the affected app's tests as BLOCKED.
  The workflow should extract preview URLs from PR comments (look for deployment bot comments with marker patterns).
- Also include `pull_request` trigger as a fallback (for when `workflow_run` doesn't fire from non-default branches)
- `workflow_dispatch` -- allows manual trigger

**Multiple preview deployments:** Some projects deploy frontend and backend separately, each with their own preview URL. During codebase analysis, check if the project has multiple deployment workflows that run on PRs. If so:

- Identify how each preview URL is derived (PR comment markers, branch-name-based URL patterns, deployment output)
- The QA workflow must wait for ALL deployments before testing
- Each app's sub-skill should document how to resolve its preview URL
- The backend sub-skill should test against the backend's preview URL (not a shared dev backend) when the backend also gets per-PR deployments

**Core steps (in this exact order):**

1. Checkout with `fetch-depth: 0` (needed for git diff analysis)
2. If using preview deployments: extract the preview URL from the triggering workflow or PR comments
3. Install ImageMagick if config says imagemagick: true (`sudo apt-get install -y -qq imagemagick`)
4. Setup Node.js (`actions/setup-node@v4` with node-version 22) -- required for tuistory and other Node-based tools
5. Install test tools based on detected app types:
   - If CLI app exists (test_tool: tuistory): `npm install -g tuistory`
   - If the CLI app has a build_command that needs dependencies: run `npm install` (or the project's package manager install) before the QA step so the CLI binary can be built
   - If web app exists (test_tool: agent-browser): agent-browser is built into drool, no extra install needed
6. Install drool CLI: `curl -fsSL https://app.example.com/cli | sh`
7. Run QA: `drool exec --auto high` with the qa skill, passing these CI-mode instructions in the prompt:
   - "You are running in a non-interactive CI environment. There is NO human available."
   - "Do NOT use AskUser, do NOT wait for confirmations, do NOT pause for input."
   - "Run the qa skill. Write the final report to qa-results/report.md"
8. **(Only if `failure_learning` is `auto_commit` or `open_pr`)** Apply skill updates from JSON. Add a step that:

   - Runs the `apply-qa-skill-updates` script from `apps/scripts/`:
     ```yaml
     - name: Apply skill updates from QA
       if: always() && steps.qa.outcome != 'cancelled'
       run: npx tsx apps/scripts/src/apply-qa-skill-updates/index.ts qa-results/skill-updates.json
     ```
   - For `auto_commit`: commit and push to the PR branch
   - For `open_pr`: create a new branch, commit, and open a draft PR targeting the PR branch
   - See the examples in the `auto_commit`/`open_pr` blocks below

   **`auto_commit` commit step:**

   ```yaml
   - name: Commit skill updates
     if: always() && steps.apply-updates.outcome == 'success'
     run: |
       if git diff --quiet .industry/skills/; then exit 0; fi
       git config user.name "github-actions[bot]"
       git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
       git add .industry/skills/
       git commit -m "chore(qa): update failure catalog from QA run #${{ github.run_number }}"
       git push origin HEAD:${{ steps.pr.outputs.ref }}
   ```

   **`open_pr` commit + PR step:**

   ```yaml
   - name: Open PR with skill updates
     if: always() && steps.apply-updates.outcome == 'success'
     env:
       GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
     run: |
       if git diff --quiet .industry/skills/; then exit 0; fi
       BRANCH="qa/catalog-${{ github.run_number }}"
       git config user.name "github-actions[bot]"
       git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
       git checkout -b "$BRANCH"
       git add .industry/skills/
       git commit -m "chore(qa): update failure catalog from QA run #${{ github.run_number }}"
       git push origin "$BRANCH"
       gh pr create --base "${{ steps.pr.outputs.ref }}" --head "$BRANCH" \
         --title "chore(qa): update failure catalog from QA run #${{ github.run_number }}" \
         --body "Auto-generated from QA run on PR #${{ steps.pr.outputs.number }}." --draft
   ```

9. Upload artifacts (screenshots, GIFs, report, skill-updates.json) via `actions/upload-artifact@v4` with 14-day retention
10. Post/update PR comment with the report (see PR comment section below)

**Environment variables the workflow must pass to the QA step:**

- All secrets identified from config.yaml `credentials_source` fields and auth configuration
- `CI: true`: so the skill knows to run autonomously
- Use the secret names discovered during codebase analysis -- do NOT hardcode project-specific names

**PR comment posting:**
In the "Post QA report as PR comment" step:

- Read `qa-results/report.md` if it exists; otherwise wrap `qa-output.txt` in a details block as fallback
- Ensure the report always starts with `## QA Report` heading (add it if the report file doesn't include one)
- The report already contains inline text snapshots (fenced code blocks) as evidence -- no image upload/embedding needed
- Append a footer with artifact download link and workflow run link
- Include a hidden HTML marker at the top of the comment body: `<!-- qa-report -->`
- Before posting, search existing PR comments for one starting with `<!-- qa-report -->`. If found, UPDATE that comment (PATCH) instead of creating a new one. Only create a new comment if no existing QA comment exists.
- This ensures each PR has exactly ONE QA comment that gets updated on each push, not a flood of comments.
- Upload any image files (screenshots, GIFs) as build artifacts only -- do NOT try to embed them inline in the PR comment

**Reliability:**

- Use proper concurrency groups keyed on the PR number (handle both `pull_request` and `workflow_run` event shapes) with cancel-in-progress
- Set job timeout (20-25 minutes) and QA step timeout (15-20 minutes)
- Use `continue-on-error: true` on the QA step so the report always gets posted even on failure
- Use the runner type from existing workflows in this repo (check `.github/workflows/` for the runner label)

### Self-testing property

The QA skill tests the application itself. When changes are made to the QA skill files (`.industry/skills/qa/**`) but no app code changed, the diff analysis will detect this and report INCONCLUSIVE -- no app flows will run since no app was affected.

---

# Phase 5: Verification

After generating all files:

1. Show the user a summary of what was generated
2. List all files created with a brief description of each
3. Suggest: "You can test this by running /qa to invoke the skill, or by opening a PR to trigger the GitHub Action (if generated)."

**IMPORTANT -- GitHub Secrets Setup (FAC-17916):** 4. If a GitHub Actions workflow was generated, you MUST prompt the user to add the required secrets to their GitHub repository. Analyze the generated workflow and config.yaml to compile the EXACT list of secrets needed. Present it as a checklist:

```
The QA workflow needs these GitHub repository secrets to work in CI:

  [ ] <SECRET_NAME> -- <what it's for>
      Get it from: <where to get it>
  ...

Add them at: https://github.com/<owner>/<repo>/settings/secrets/actions
```

Dynamically populate this list by reading the generated workflow and config.yaml. List EVERY secret referenced in the workflow's `env:` block and explain what each one does and where to obtain it. Do NOT hardcode project-specific secret names in the prompt -- discover them from what was generated.

5. Remind them about any other manual setup needed (e.g., test accounts, API access, environment allowlists)

---

# Important Guidelines

- NEVER store actual credentials, passwords, API keys, or tokens in any generated file. Only store references to where they are (env var names, secret manager paths).
- The orchestrator SKILL.md must be lightweight. The app modules contain the detailed test steps.
- Save progress to .install-progress.yaml after EVERY questionnaire category so the user can resume if interrupted.
- If the user says "start over" at any point, delete .install-progress.yaml and restart from Phase 2.
- ALWAYS regenerate ALL files from scratch based on the questionnaire answers and codebase analysis, even if files already exist. Overwrite them. The user may have changed their answers or the generation rules may have been updated.
