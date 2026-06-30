---
name: install-code-review
description: >
  Install and configure Industry Drool for automated code review on GitHub or GitLab.
  Supports single-repo setup or org/group-wide rollout across hundreds of repos.
  Use when a user wants to set up Drool review on their repositories.
user-invocable: true
---

# Install Code Review

You are setting up Industry Drool for automated code review.

## Rules (follow these exactly, no exceptions)

1. **NEVER skip a step.** Execute steps in order. If a step fails, stop and tell the user how to fix it.
2. **NEVER assume.** Every decision point requires user input via AskUser. Do not pick defaults, do not skip questions.
3. **NEVER commit secrets.** Workflow files reference secrets via `${{ secrets.INDUSTRY_API_KEY }}` (GitHub) or `$INDUSTRY_API_KEY` (GitLab) — never put actual keys in files.
4. **NEVER escape `${{ ... }}`** in workflow YAML. Write expressions literally (`${{ secrets.INDUSTRY_API_KEY }}`); never `\${{ ... }}`. To avoid shell expansion, use the base64 heredoc in Step 8 — do not add backslashes.
5. **Run all prerequisite checks in parallel** where possible (Step 1).
6. **Use the exact commands** listed below. Do not improvise alternative commands.
7. **Use AskUser** for every question. Do not ask questions in plain text.
8. **Confirm before executing** any action that creates, modifies, or deletes resources.
9. **Track progress** for multi-repo operations. Show which repo is being processed.

## Step 0: Detect Platform

Check the git remote to detect the platform:

```bash
git remote get-url origin 2>/dev/null
```

- If the URL contains `github.com` → **GitHub**. Proceed to Step 1 (GitHub).
- If the URL contains `gitlab.com` or a known GitLab instance → **GitLab**. Proceed to Step 1 (GitLab).
- If no remote or ambiguous: use AskUser:
  ```
  1. [question] Which platform are you using?
  [topic] Platform
  [option] GitHub
  [option] GitLab
  ```

Once the platform is determined, follow ONLY the steps for that platform. Do not mix GitHub and GitLab steps.

---

# GitHub Flow

## Step 1 (GitHub): Verify Prerequisites

Run ALL FOUR of these commands in parallel. If any fail, stop and show the fix.

| Check         | Command                                                                              | On failure                                                    |
| ------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| gh installed  | `gh --version`                                                                       | Tell user to install: `brew install gh` (macOS)               |
| Authenticated | `gh auth status`                                                                     | Tell user to run: `gh auth login`                             |
| Scopes        | `gh auth status -t 2>&1` — look for `repo`, `read:org`, `workflow` in "Token scopes" | Tell user to run: `gh auth refresh -s repo,read:org,workflow` |
| API access    | `gh api user --jq .login`                                                            | Tell user to run: `gh auth refresh`                           |

Only proceed when ALL four pass.

## Step 2 (GitHub): Determine Scope

Use AskUser:

```
1. [question] What scope do you want to set up Drool for?
[topic] Scope
[option] Single repository
[option] Multiple repositories (org-wide)
```

- If **Single repository**: run `git remote get-url origin 2>/dev/null` to detect `owner/repo`. If found, confirm with user. If not found, use AskUser to ask for `owner/repo`. Then go to Step 4.
- If **Multiple repositories**: go to Step 3.

## Step 3 (GitHub): Org-Wide Setup

### 3a. Identify the org

List the user's orgs: `gh api user/orgs --jq '.[].login'`

Use AskUser to ask which org. Include the orgs from the command output as options.

Verify it exists: `gh api /orgs/{org} --jq '.login'`

### 3b. Check GitHub App installation

Run: `gh api /orgs/{org}/installations --jq '.installations[] | select(.app_slug == "industry-drool") | .id'`

- If output is empty (no ID returned): tell the user exactly this:
  > "The Industry Drool GitHub App is not installed for this org. Please install it at: https://app.example.com/settings/integrations/github/start — grant access to 'All repositories' or select the specific repos you want. Let me know when done."
  > Then wait. When user confirms, re-run the command. If still empty, repeat the message.
- If an ID is returned: proceed.

### 3c. Check INDUSTRY_API_KEY org secret

Run: `gh secret list --org {org} 2>/dev/null | grep INDUSTRY_API_KEY`

- If no match: tell the user exactly this:
  > "INDUSTRY_API_KEY is not set as an org secret. To set it up:"
  > "1. Generate a key at https://app.example.com/settings/api-keys"
  > "2. Run: `gh secret set INDUSTRY_API_KEY --org {org} --visibility all`"
  > Then wait for user to confirm. Re-check. If it fails with a permissions error about `admin:org` scope, tell them to run `gh auth refresh -h github.com -s admin:org` first.
- If match found: proceed.

### 3d. Select target repos

Run: `gh repo list {org} --limit 1000 --json name,isArchived,isFork --jq '.[] | "\(.name) | archived:\(.isArchived) | fork:\(.isFork)"'`

Use AskUser:

```
1. [question] Which repos should Drool be enabled on?
[topic] Repo-selection
[option] All repos
[option] Filter by pattern
[option] Let me select manually
```

If "All repos" or "Filter by pattern": count how many are archived and how many are forks. Use AskUser:

```
1. [question] Found X archived repos. Exclude them?
[topic] Archived
[option] Yes, exclude archived repos
[option] No, include them

2. [question] Found Y forked repos. Forked repos cannot use required workflows (Option C). Include them?
[topic] Forks
[option] Yes, include forks
[option] No, exclude forks
```

Then check which repos already have Drool workflows. For each selected repo run:
`gh api /repos/{org}/{repo}/contents/.github/workflows/ --jq '.[].name' 2>/dev/null`

Count repos that already have `drool.yml` or `drool-review.yml`. If any exist, use AskUser:

```
1. [question] X repos already have Drool workflow files. What do you want to do?
[topic] Existing-workflows
[option] Skip repos that already have workflows
[option] Overwrite existing workflow files
```

## Step 4 (GitHub): Check Permissions (single-repo only)

Run: `gh api /repos/{owner}/{repo} --jq '.permissions.admin'`

If result is `false`, tell the user:

> "You don't have admin permissions on this repository. You can still proceed, but you may need a repository admin to approve the GitHub App installation, add the INDUSTRY_API_KEY secret, and merge the workflow PR."

Use AskUser:

```
1. [question] Continue without admin permissions?
[topic] Permissions
[option] Yes, continue anyway
[option] No, cancel
```

## Step 5 (GitHub): GitHub App Installation (single-repo only)

Run: `gh api /repos/{owner}/{repo}/installation --jq '.id' 2>/dev/null`

If empty or error: tell the user:

> "The Industry Drool GitHub App is not installed for this repository. Please visit https://app.example.com/settings/integrations/github/start to install it. Let me know when done."

Open the browser: `open https://app.example.com/settings/integrations/github/start 2>/dev/null`

Wait for user to confirm. Re-run the check. Repeat if still not installed.

## Step 6 (GitHub): Workflow Selection

Use AskUser with exactly these questions:

```
1. [question] Enable @drool tag responses? (Responds to @drool mentions in issues and PR comments)
[topic] Tag-responses
[option] Yes
[option] No

2. [question] Enable automatic code review on new PRs?
[topic] Auto-review
[option] Yes
[option] No

3. [question] Enable automatic security review on new PRs?
[topic] Security-review
[option] Yes
[option] No

4. [question] Review depth for automatic reviews?
[topic] Review-depth
[option] deep (thorough)
[option] shallow (fast, cost-effective)
```

At least one of tag responses or auto review must be enabled. If user disabled both, tell them: "At least one workflow must be enabled. Please enable tag responses or automatic review."

## Step 7 (GitHub): Choose Distribution Strategy (multi-repo only)

First, check the org plan: `gh api /orgs/{org} --jq '.plan.name'`

Use AskUser. If plan is `free`, only show Options A and B. If plan is `team` or `enterprise`, show all three:

```
1. [question] How should the workflow files be added to these repos?
[topic] Strategy
[option] Direct commit (fastest, commits to each repo's default branch)
[option] Open PRs (safest, opens a PR in each repo for review)
[option] Required workflows (zero per-repo files, enforced via org ruleset — requires Team/Enterprise)
```

If plan is `free` and user asks about required workflows, tell them:

> "Required workflows need GitHub Team or Enterprise Cloud. Your org is on the free plan."

## Step 8 (GitHub): Execute

Before executing, use AskUser to confirm:

```
1. [question] Ready to proceed? Here is what will happen: [describe exactly what will be created/modified, how many repos, which strategy]
[topic] Confirm
[option] Yes, go ahead
[option] No, cancel
```

**CRITICAL: encode workflow content with this pattern only.** `echo|base64`, `printf|base64`, and embedding YAML in double-quoted shell strings can corrupt `${{ ... }}`. Use a single-quoted Python heredoc with a raw string:

```bash
B64=$(python3 << 'PYEOF'
import base64
content = r"""<workflow YAML; keep ${{ ... }} literal, no backslashes>"""
print(base64.b64encode(content.encode()).decode())
PYEOF
)
```

Verify before committing (portable): `echo "$B64" | (base64 -d 2>/dev/null || base64 -D) | grep -F 'secrets.INDUSTRY_API_KEY'` and ensure the decoded output contains **no** `\${{` / `\$\{\{`. Pass to `gh api` as `-f content="$B64"`.

### Option A: Direct commit

For each selected repo:

1. Check if workflow files already exist (respect skip/overwrite choice from Step 3d).
2. Get default branch: `gh api /repos/{org}/{repo} --jq '.default_branch'`
3. Encode each workflow file with the Step 8 heredoc, then:
   `gh api /repos/{org}/{repo}/contents/.github/workflows/{filename} -X PUT -f message="feat: Add {filename} workflow" -f content="$B64"`
   If overwriting, fetch the SHA first (`--jq '.sha'`) and add `-f sha={existing_sha}`.
4. Print: `✓ {repo}: committed {filenames}`
5. On error, print: `✗ {repo}: {error message}` and continue to next repo.

### Option B: Open PRs

For each selected repo:

1. Check if a branch `add-industry-workflows-*` already exists (idempotency): `gh api /repos/{org}/{repo}/git/refs --jq '.[].ref' 2>/dev/null | grep add-industry-workflows`
   If found, skip and print: `⊘ {repo}: PR branch already exists, skipping`
2. Get default branch: `gh api /repos/{org}/{repo} --jq '.default_branch'`
3. Get latest SHA: `gh api /repos/{org}/{repo}/git/refs/heads/{default_branch} --jq '.object.sha'`
4. Create branch: `gh api /repos/{org}/{repo}/git/refs -f ref=refs/heads/add-industry-workflows-{timestamp} -f sha={sha}`
5. Encode each workflow file with the Step 8 heredoc, then:
   `gh api /repos/{org}/{repo}/contents/.github/workflows/{filename} -X PUT -f message="feat: Add {filename} workflow" -f content="$B64" -f branch=add-industry-workflows-{timestamp}`
6. Create PR: `gh pr create --repo {org}/{repo} --head add-industry-workflows-{timestamp} --base {default_branch} --title "Enable Industry Drool automated code review" --body "{pr_body}"`
   PR body must include: what workflows were added, link to https://app.example.com/settings/api-keys, link to https://docs.example.com
7. Print: `✓ {repo}: PR opened — {pr_url}`
8. On error, print: `✗ {repo}: {error message}` and continue to next repo.

### Option C: Required workflows

1. Run: `gh api /orgs/{org} --jq '.plan.name'` — if `free`, stop and tell user this requires Team/Enterprise.
2. Use AskUser to ask for central repo name:
   ```
   1. [question] Name for the central workflows repo?
   [topic] Repo-name
   [option] drool-workflows
   ```
3. Check if repo exists: `gh api /repos/{org}/{repo_name} --jq '.name' 2>/dev/null`
4. If not found, create it: `gh api /orgs/{org}/repos -f name={repo_name} -f visibility=public -f description="Reusable Drool workflows" -f auto_init=true`
5. Commit the reusable workflow files (from Reusable Workflow Templates below) to the central repo using the GitHub Contents API.
6. Get repo ID: `gh api /repos/{org}/{repo_name} --jq '.id'`
7. Get workflow SHA: `gh api /repos/{org}/{repo_name}/contents/.github/workflows/{filename} --jq '.sha'`
8. Use AskUser to ask about exclusions:
   ```
   1. [question] Exclude any repos from the required workflow?
   [topic] Exclusions
   [option] No exclusions (apply to all repos)
   [option] Exclude specific repos
   ```
   If excluding, ask for repo names/patterns.
9. Create the org ruleset:
   ```
   gh api /orgs/{org}/rulesets -X POST --input - <<EOF
   {
     "name": "Require Drool Review",
     "target": "branch",
     "enforcement": "active",
     "conditions": {
       "ref_name": {
         "include": ["~DEFAULT_BRANCH"],
         "exclude": []
       },
       "repository_name": {
         "include": ["~ALL"],
         "exclude": ["{excluded_repos}"]
       }
     },
     "rules": [
       {
         "type": "workflows",
         "parameters": {
           "workflows": [
             {
               "repository_id": {repo_id},
               "path": ".github/workflows/drool-review-reusable.yml",
               "ref": "main",
               "sha": "{workflow_sha}"
             }
           ]
         }
       }
     ]
   }
   EOF
   ```
10. If the API returns 403, tell user: "Org rulesets require admin permissions. Ask an org admin to run this, or use Option A or B instead."
11. On success, print: `✓ Ruleset "Require Drool Review" created. Applies to all repos` (or `all repos except {excluded}`).
12. Tell user: "Manage exclusions later at: https://github.com/organizations/{org}/settings/rules"

### Single repo:

1. Get default branch: `gh api /repos/{owner}/{repo} --jq '.default_branch'`
2. Get latest SHA: `gh api /repos/{owner}/{repo}/git/refs/heads/{default_branch} --jq '.object.sha'`
3. Create branch: `gh api /repos/{owner}/{repo}/git/refs -f ref=refs/heads/add-industry-workflows-{timestamp} -f sha={sha}`
   Use `date +%s` for the timestamp.
4. Encode each workflow file with the Step 8 heredoc, then:
   `gh api /repos/{owner}/{repo}/contents/.github/workflows/{filename} -X PUT -f message="feat: Add {filename} workflow" -f content="$B64" -f branch=add-industry-workflows-{timestamp}`
   Verify (portable): `gh api /repos/{owner}/{repo}/contents/.github/workflows/{filename} --jq '.content' | (base64 -d 2>/dev/null || base64 -D) | tee /tmp/_drool_chk | grep -F 'secrets.INDUSTRY_API_KEY'` then `! grep -F '\${{' /tmp/_drool_chk` — both must succeed.
5. Create PR:
   `gh pr create --repo {owner}/{repo} --head add-industry-workflows-{timestamp} --base {default_branch} --title "feat: Add Industry GitHub workflows" --body "{pr_body}"`
6. Print the PR URL.

## Step 9 (GitHub): Summary

Display a results table:

| Category   | Count | Details                                      |
| ---------- | ----- | -------------------------------------------- |
| Configured | X     | repos with workflows committed or PRs opened |
| PRs opened | Y     | links to first 5 PRs                         |
| Skipped    | Z     | already configured, user chose to skip       |
| Failed     | W     | repo names + error reasons                   |

If any repos failed, use AskUser:

```
1. [question] {W} repos failed. Retry with a different strategy?
[topic] Retry
[option] Retry failed repos with direct commit
[option] Retry failed repos with PRs
[option] Skip, I'll handle them manually
```

If INDUSTRY_API_KEY was not verified (single-repo flow skips the org secret check), remind:

> "**Important: Add your INDUSTRY_API_KEY**"
> "1. Generate a key at https://app.example.com/settings/api-keys"
> "2. Go to repo Settings > Secrets and variables > Actions > New repository secret"
> "3. Name: `INDUSTRY_API_KEY`, Value: your generated key"

## Reusable Workflow Templates

Used by Option C. Commit these to the central repo.

### drool-reusable.yml

```yaml
name: Drool Tag (Reusable)

on:
  workflow_call:
    secrets:
      industry_api_key:
        required: true

jobs:
  drool:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
      id-token: write
      actions: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@v5
        with:
          fetch-depth: 1
      - name: Run Drool Exec
        uses: Industry-AI/drool-action@main
        with:
          industry_api_key: ${{ secrets.industry_api_key }}
```

### drool-review-reusable.yml

```yaml
name: Drool Auto Review (Reusable)

on:
  workflow_call:
    secrets:
      industry_api_key:
        required: true
    inputs:
      automatic_security_review:
        type: boolean
        default: false
      review_depth:
        type: string
        default: deep

jobs:
  drool-review:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
      actions: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@v5
        with:
          fetch-depth: 1
      - name: Run Drool Auto Review
        uses: Industry-AI/drool-action@main
        with:
          industry_api_key: ${{ secrets.industry_api_key }}
          automatic_review: true
          automatic_security_review: ${{ inputs.automatic_security_review }}
          review_depth: ${{ inputs.review_depth }}
```

## Standalone Workflow File Templates

Used by Options A, B, and single-repo flow.

### drool.yml

Generate when @drool tag responses are enabled:

```yaml
name: Drool Tag

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]
  pull_request_review:
    types: [submitted]
  pull_request:
    types: [opened, edited]

jobs:
  drool:
    if: |
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@drool')) ||
      (github.event_name == 'pull_request_review_comment' && contains(github.event.comment.body, '@drool')) ||
      (github.event_name == 'pull_request_review' && contains(github.event.review.body, '@drool')) ||
      (github.event_name == 'issues' && (contains(github.event.issue.body, '@drool') || contains(github.event.issue.title, '@drool'))) ||
      (github.event_name == 'pull_request' && (contains(github.event.pull_request.body, '@drool') || contains(github.event.pull_request.title, '@drool')))
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
      id-token: write
      actions: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@v5
        with:
          fetch-depth: 1
      - name: Run Drool Exec
        uses: Industry-AI/drool-action@main
        with:
          industry_api_key: ${{ secrets.INDUSTRY_API_KEY }}
```

### drool-review.yml

Generate when automatic code review is enabled. Start with this base:

```yaml
name: Drool Auto Review

on:
  pull_request:
    types: [opened, ready_for_review, reopened]

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  drool-review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
      actions: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@v5
        with:
          fetch-depth: 1
      - name: Run Drool Auto Review
        uses: Industry-AI/drool-action@main
        with:
          industry_api_key: ${{ secrets.INDUSTRY_API_KEY }}
          automatic_review: true
```

Then add these lines under `with:` based on user choices from Step 6:

- If security review enabled: add `automatic_security_review: true`
- If review depth is shallow: add `review_depth: shallow`
- If review depth is deep: do NOT add `review_depth` (deep is the default)

## Error Handling (GitHub)

| Error                                | Cause                             | Fix                                                                           |
| ------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------- |
| `HTTP 404` on installations endpoint | User is not an org admin          | Tell user to ask an org admin, or use single-repo flow                        |
| `HTTP 403` on secret set             | Missing `admin:org` scope         | Tell user: `gh auth refresh -h github.com -s admin:org`                       |
| `HTTP 403` on rulesets               | Free plan or not org admin        | Tell user to upgrade plan or ask org admin                                    |
| `HTTP 422` on file create            | File already exists without SHA   | Get the existing SHA and retry with `-f sha={sha}`                            |
| Branch protection blocks push        | Repo has branch protection        | Suggest opening PRs instead of direct commit                                  |
| `startup_failure` on workflow        | Fork repo using reusable workflow | Forked repos cannot call cross-repo reusable workflows. Use standalone files. |

---

# GitLab Flow

## Step 1 (GitLab): Verify Prerequisites

Run these checks in parallel. If any fail, stop and show the fix.

| Check          | Command                                               | On failure                                                                                 |
| -------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| glab installed | `glab --version`                                      | Tell user to install: `brew install glab` (macOS) or see https://gitlab.com/gitlab-org/cli |
| Authenticated  | `glab auth status`                                    | Tell user to run: `glab auth login`                                                        |
| API access     | `glab api user` and parse username from JSON response | Tell user to run: `glab auth login` and check their connection                             |

**IMPORTANT**: `glab api` does NOT support `--jq`. To extract fields from API responses, always pipe through python:
`glab api <endpoint> | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['field'])"`

Only proceed when ALL pass.

## Step 2 (GitLab): Determine Scope

Use AskUser:

```
1. [question] What scope do you want to set up Drool for?
[topic] Scope
[option] Single project
[option] Multiple projects (group-wide)
```

- If **Single project**: run `git remote get-url origin 2>/dev/null` to detect the project path. Parse the GitLab project path (e.g., `group/project`). Confirm with user. Then go to Step 4 (GitLab).
- If **Multiple projects**: go to Step 3 (GitLab).

## Step 3 (GitLab): Group-Wide Setup

### 3a. Identify the group

List the user's groups:
`glab api groups -X GET -f min_access_level=30 | python3 -c "import sys,json; [print(g['full_path']) for g in json.load(sys.stdin)]"`

Use AskUser to ask which group. Include the groups from the command output as options.

To URL-encode group paths for the API (e.g., `my-group/sub-group` → `my-group%2Fsub-group`), use:
`python3 -c "import urllib.parse; print(urllib.parse.quote('{group_path}', safe=''))"`

Verify it exists:
`glab api groups/{group_url_encoded} | python3 -c "import sys,json; print(json.load(sys.stdin)['full_path'])"`

### 3b. Check INDUSTRY_API_KEY and GITLAB_TOKEN CI/CD variables

The drool-review CI/CD Component needs TWO masked CI/CD variables:

| Variable          | Purpose                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `INDUSTRY_API_KEY` | Authenticates the Drool CLI against Industry's inference endpoint                                       |
| `GITLAB_TOKEN`    | Lets the review job post inline MR comments + update the sticky tracking note via the GitLab REST API. |

Both must be set as **masked, non-protected** CI/CD variables at a level that all target projects inherit from. (Non-protected is required so the variable is available to merge-request pipelines, which by default run on non-protected branches.)

> Note: `CI_JOB_TOKEN` is intentionally not used — it lacks the permissions to create MR notes/discussions. The template requires a real Project, Group, or Personal Access Token with the `api` scope.

> **Security trade-off — please surface this to the user before proceeding:**
>
> A masked, non-protected `GITLAB_TOKEN` with `api` scope is available to **every merge-request pipeline**, including MRs opened from forks or by less-trusted contributors. Pipelines can read the variable from the environment and exfiltrate it; an attacker who obtains the token gets the token's full API privileges until it's rotated.
>
> Mitigations to recommend (in decreasing order of preference):
>
> 1. **Use the narrowest scope that works.** Prefer a Project Access Token over a Group Access Token over a Personal Access Token. A token scoped to a single project can only be abused against that one project; a group token can be abused against every project in the group.
> 2. **Use a dedicated bot account or fine-grained token** rather than a long-lived Personal Access Token tied to a real user.
> 3. **Use the minimum role.** `Developer` is enough for the review job (posting notes + reading MR data). Do not grant `Maintainer`/`Owner` if not required.
> 4. **Set a short expiration** on the token (GitLab supports up to 1 year; rotate sooner if the contributor model is open).
> 5. **For projects that accept fork-MRs from untrusted contributors**, consider:
>    - Disabling pipelines for MRs from forks (Settings > CI/CD > General pipelines > "Run pipelines for fork merge requests"), and/or
>    - Running the Drool review only on protected branches via a `rules:` override and marking the variable Protected instead of non-protected (this also disables review on MR pipelines, so it's a trade-off — the user has to pick).
>
> Ask the user about their contributor model before settling on group-wide non-protected. If they don't know, default to **per-project Project Access Tokens** and surface the trade-off explicitly in Step 8.

GitLab CI/CD variables can be set at multiple levels in the hierarchy (top-level group, subgroup, or project). Ask the user where they want to set them:

```
1. [question] Where should the INDUSTRY_API_KEY and GITLAB_TOKEN CI/CD variables be set? Setting them at a higher level means all descendant projects inherit them automatically.
[topic] Variable-Scope
[option] Top-level group (all projects in the group inherit it)
[option] A specific subgroup (only projects in that subgroup inherit it)
[option] Per-project (I'll set it on each project individually)
```

Then check whether each variable already exists at the chosen level. Run BOTH checks (in parallel where possible):

For group/subgroup:

- `glab api groups/{chosen_group_url_encoded}/variables/INDUSTRY_API_KEY | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('key','NOT_FOUND'))"`
- `glab api groups/{chosen_group_url_encoded}/variables/GITLAB_TOKEN | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('key','NOT_FOUND'))"`

For project:

- `glab api projects/{project_url_encoded}/variables/INDUSTRY_API_KEY | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('key','NOT_FOUND'))"`
- `glab api projects/{project_url_encoded}/variables/GITLAB_TOKEN | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('key','NOT_FOUND'))"`

For each missing variable, tell the user how to set it:

**If `INDUSTRY_API_KEY` is `NOT_FOUND`:**

> "INDUSTRY_API_KEY is not set as a CI/CD variable at {chosen_level}. To set it up:"
> "1. Generate a key at https://app.example.com/settings/api-keys"
> "2. Go to {chosen_level} Settings > CI/CD > Variables"
> "3. Add variable: Key=`INDUSTRY_API_KEY`, Value=your key, check 'Mask variable', uncheck 'Protect variable'"
> Or run: `glab api {groups_or_projects}/{url_encoded}/variables -X POST -f key=INDUSTRY_API_KEY -f value=YOUR_KEY -f masked=true -f protected=false`
> Wait for user to confirm. Re-check.

**If `GITLAB_TOKEN` is `NOT_FOUND`:**

> "GITLAB_TOKEN is not set as a CI/CD variable at {chosen_level}. The review job uses this token to post MR comments and update the tracking note."
> ""
> "Pick the most appropriate token type for {chosen_level}:"
> " - **Group Access Token** (recommended for group-wide setup): {group_url}/-/settings/access_tokens — create a token named e.g. `drool-bot` with role `Developer` (or higher) and `api` scope."
> " - **Project Access Token** (per-project setup): {project_url}/-/settings/access_tokens — same role and scope."
> " - **Personal Access Token** (fallback, tied to a user): https://gitlab.com/-/user_settings/personal_access_tokens — `api` scope."
> ""
> "Then go to {chosen_level} Settings > CI/CD > Variables and add: Key=`GITLAB_TOKEN`, Value=the token, check 'Mask variable', uncheck 'Protect variable'."
> Or once you have the token value, run: `glab api {groups_or_projects}/{url_encoded}/variables -X POST -f key=GITLAB_TOKEN -f value=YOUR_TOKEN -f masked=true -f protected=false`
> Wait for user to confirm. Re-check.

- If both are found: proceed.

### 3c. Select target projects

Run:
`glab api groups/{group_url_encoded}/projects -X GET -f include_subgroups=true -f per_page=100 | python3 -c "import sys,json; [print(f\"{p['path_with_namespace']} | archived:{p['archived']}\") for p in json.load(sys.stdin)]"`

Use AskUser:

```
1. [question] Which projects should Drool be enabled on?
[topic] Project-selection
[option] All projects
[option] Filter by pattern
[option] Let me select manually
```

Count archived projects. If any, use AskUser to confirm exclusion.

Then check which projects already have a `.gitlab-ci.yml` with drool jobs. For each selected project, URL-encode the project path and run:
`glab api "projects/{project_url_encoded}/repository/files/.gitlab-ci.yml/raw?ref={default_branch}" 2>&1`

If the response contains "drool", the project already has drool config. Count these and if any, use AskUser:

```
1. [question] X projects already have Drool CI configuration. What do you want to do?
[topic] Existing-config
[option] Skip projects that already have Drool config
[option] Overwrite existing configuration
```

## Step 4 (GitLab): Check Permissions (single-project only)

Run: `glab api projects/{project_url_encoded} | python3 -c "import sys,json; d=json.load(sys.stdin); p=d.get('permissions',{}); a=p.get('project_access') or p.get('group_access') or {}; print(a.get('access_level',0))"`

If the access level is less than 40 (Maintainer), tell the user:

> "You need at least Maintainer access to add CI/CD configuration. You can still proceed, but someone with Maintainer access will need to merge the MR."

Use AskUser to confirm continuing.

## Step 5 (GitLab): Pipeline Configuration Selection

Use AskUser:

```
1. [question] Enable automatic code review on merge requests?
[topic] Auto-review
[option] Yes
[option] No

2. [question] Enable automatic security review on merge requests?
[topic] Security-review
[option] Yes
[option] No

3. [question] Review depth for automatic reviews?
[topic] Review-depth
[option] deep (thorough)
[option] shallow (fast, cost-effective)
```

At least auto review must be enabled.

## Step 6 (GitLab): Choose Distribution Strategy (group-wide only)

First, check if the group has Ultimate tier by testing the security policies API:
`glab api "groups/{group_url_encoded}/security/policies" 2>&1`

- If 404: group is on Free/Premium tier. Only show Options A and B.
- If 200 or other response: Ultimate tier. Show all three options.

Use AskUser. If Free/Premium, show only Options A and B:

```
1. [question] How should the CI configuration be added to these projects?
[topic] Strategy
[option] Direct commit (fastest, commits to each project's default branch)
[option] Open merge requests (safest, opens an MR in each project for review)
```

If Ultimate tier, show all three:

```
1. [question] How should the CI configuration be added to these projects?
[topic] Strategy
[option] Direct commit (fastest, commits to each project's default branch)
[option] Open merge requests (safest, opens an MR in each project for review)
[option] Pipeline Execution Policy (zero per-project files, enforced centrally — requires Ultimate)
```

If Free/Premium and user asks about Pipeline Execution Policies, tell them:

> "Pipeline Execution Policies require GitLab Ultimate. Your group is on a lower tier. You can start a free trial at https://about.gitlab.com/free-trial/ or use Options A/B instead."

## Step 7 (GitLab): Execute

Before executing, use AskUser to confirm what will happen.

**CRITICAL: Content encoding for `glab api`**

The `.gitlab-ci.yml` content contains `$` characters (CI variables like `$INDUSTRY_API_KEY`, `$CI_PIPELINE_SOURCE`). To avoid shell expansion, ALWAYS use python to base64-encode the content:

```bash
B64=$(python3 << 'PYEOF'
import base64
content = """<yaml content here>"""
print(base64.b64encode(content.encode()).decode())
PYEOF
)
```

Then pass to the API with `-f encoding=base64 -f "content=$B64"`.

**CRITICAL: POST vs PUT for file creation**

Before committing a file, always check if it already exists on the target branch:
`glab api "projects/{encoded}/repository/files/.gitlab-ci.yml?ref={branch}" 2>&1`

- If it returns file metadata (HTTP 200): use `-X PUT` to update
- If it returns 404: use `-X POST` to create

This applies to BOTH the MR branch AND the default branch. A project may have an existing `.gitlab-ci.yml` that gets copied to the new branch.

### GitLab Single project:

1. Get default branch:
   `glab api projects/{project_url_encoded} | python3 -c "import sys,json; print(json.load(sys.stdin)['default_branch'])"`
2. Check if `.gitlab-ci.yml` already exists on default branch:
   `glab api "projects/{project_url_encoded}/repository/files/.gitlab-ci.yml?ref={default_branch}" 2>&1`
   - If exists: read the raw content from default branch and append drool jobs
   - If not: use the full GitLab CI template below
3. Create a new branch: `glab api projects/{project_url_encoded}/repository/branches -X POST -f branch=add-industry-drool-review -f ref={default_branch}`
4. Base64-encode the content using python (see encoding note above).
5. Commit the file — use PUT since the branch was created from default which may already have the file:
   `glab api "projects/{project_url_encoded}/repository/files/.gitlab-ci.yml" -X PUT -f branch=add-industry-drool-review -f "content=$B64" -f encoding=base64 -f "commit_message=ci: add Industry Drool review pipeline"`
   If PUT returns 404 (file doesn't exist on branch), retry with POST.
6. Create MR using the API:
   `glab api "projects/{project_url_encoded}/merge_requests" -X POST -f source_branch=add-industry-drool-review -f target_branch={default_branch} -f "title=Enable Industry Drool automated code review" -f "description={mr_body}"`
   Parse the `web_url` from the response.
7. Print the MR URL.

### GitLab Multi-project (MRs):

Loop through selected projects. For each:

1. Check if branch `add-industry-drool-review` already exists (idempotency):
   `glab api "projects/{encoded}/repository/branches/add-industry-drool-review" 2>&1`
   If found, check for an existing MR: `glab api "projects/{encoded}/merge_requests?source_branch=add-industry-drool-review&state=opened" | python3 -c "import sys,json; mrs=json.load(sys.stdin); print(mrs[0]['web_url'] if mrs else 'NONE')"`
   Print: `⊘ {project}: MR already exists: {mr_url}` (or `branch already exists, skipping` if no open MR)
2. Follow the single-project steps above.
3. Track success/failure per project.

### GitLab Multi-project (direct commit):

Loop through selected projects. For each:

1. Check if `.gitlab-ci.yml` already exists on default branch.
2. If exists: read content, check if it already has drool config (grep for "drool"). If it does and user chose skip, skip this project.
3. If exists without drool config: append drool jobs to existing content.
4. Base64-encode and commit to default branch using the Repository Files API (PUT if exists, POST if not).
5. Track success/failure per project.

### GitLab Option C: Pipeline Execution Policy (Ultimate only)

This creates a centralized policy that injects drool review jobs into ALL project pipelines without modifying any project's `.gitlab-ci.yml`. This is the GitLab equivalent of GitHub Required Workflows.

1. **Verify Ultimate tier**: Run `glab api "groups/{group_url_encoded}/security/policies" 2>&1`. If it returns 404, stop and tell user this requires Ultimate.

2. **Check for existing security policy project**: Run:
   `glab api graphql -f query='{ group(fullPath: "{group_path}") { securityPolicyProject { id name fullPath } } }' | python3 -c "import sys,json; d=json.load(sys.stdin); p=d['data']['group']['securityPolicyProject']; print(p['fullPath'] if p else 'NONE')"`

3. **Create or identify the security policy project**:

   - If no security policy project exists, use AskUser to ask for a project name:
     ```
     1. [question] Name for the security policy project that will hold the Drool review policy?
     [topic] Policy-project
     [option] drool-security-policies
     ```
   - Create the project: `glab api "groups/{group_url_encoded}/projects" -X POST -f "name={name}" -f visibility=private -f "description=Security policy project for Industry Drool review enforcement" -f auto_init=true`
   - Get the new project ID from the response.
   - Link it as the security policy project via GraphQL: `glab api graphql -f query='mutation { securityPolicyProjectAssign(input: { fullPath: "{group_path}" securityPolicyProjectId: "gid://gitlab/Project/{project_id}" }) { errors } }'`

4. **Create the policy CI/CD configuration file** in the security policy project.
   Create a file called `drool-review-policy.yml` that includes the public Drool Component, pinning the injected job into the `.pipeline-policy-pre` stage that policy-injected jobs run in:

   ```yaml
   include:
     - project: 'industry-components/drool-action'
       ref: main
       file: '/templates/drool-review.yml'
       inputs:
         drool_action_ref: main
         stage: '.pipeline-policy-pre'
         automatic_security_review: '{automatic_security_review}' # "true" or "false"
         review_depth: '{review_depth}' # "deep" or "shallow"
   ```

   Notes:

   - The injected job inherits `INDUSTRY_API_KEY` and `GITLAB_TOKEN` from the consuming project's CI/CD variables (set in Step 3b), not from the security policy project. Make sure those variables exist at the top-level group or per-project level so every project in scope inherits them.
   - Pin `ref:` and `drool_action_ref:` to a release tag once the Component is published on the GitLab Catalog; using `main` keeps you on the latest.

   Base64-encode and commit `drool-review-policy.yml` to the security policy project using the Repository Files API (same pattern as other options).

5. **Enable the Pipeline Execution Policies setting** on the security policy project:
   Tell the user:

   > "Go to the security policy project Settings > General > Visibility, project features, permissions and enable **Pipeline execution policies**. This grants pipeline users read access to the policy config. Let me know when done."
   > Wait for confirmation.

6. **Create the pipeline execution policy**:
   Create a file `.gitlab/security-policies/policy.yml` in the security policy project:

   ```yaml
   ---
   pipeline_execution_policy:
     - name: Industry Drool Code Review
       description: Enforces automated code review on all merge requests
       enabled: true
       pipeline_config_strategy: inject_policy
       content:
         include:
           - project: { security_policy_project_path }
             file: drool-review-policy.yml
       policy_scope:
         compliance_frameworks: []
   ```

   IMPORTANT schema rules for `policy.yml`:

   - The `---` YAML document separator is required at the top.
   - List items under `pipeline_execution_policy:` must use 2-space indent (not nested under a `-` with extra indent).
   - `content` MUST contain an `include` key with an array. Do NOT use `content.project`/`content.file`/`content.ref` directly.
   - Do NOT include `skip_ci` or `variables_override` fields -- they are optional and cause schema validation errors if formatted incorrectly.
   - `policy_scope.compliance_frameworks: []` means "apply to all projects in the group".

   Base64-encode and commit the policy file.

7. **Verify**: Tell the user:

   > "Pipeline Execution Policy created. Drool review jobs will now be injected into all merge request pipelines across the group. No per-project `.gitlab-ci.yml` changes needed."
   > "Manage the policy at: {security_policy_project_url}/-/security/policies"

8. If any API call returns 403, tell the user:
   > "You need Owner access to the group to create security policies. Ask a group Owner to run this, or use Option A or B instead."

## Step 8 (GitLab): Summary

Display results table (same format as GitHub Step 9).

Remind about both required CI/CD variables (only if Step 3b detected one or both were missing):

> "**Important: the review pipeline needs two masked CI/CD variables**"
>
> "**1. `INDUSTRY_API_KEY`** — Authenticates the Drool CLI."
> " - Generate at https://app.example.com/settings/api-keys"
> " - Add at the appropriate level's Settings > CI/CD > Variables (top-level group for all projects, subgroup for a subset, or per-project)"
> " - Key=`INDUSTRY_API_KEY`, Value=your key, check 'Mask variable', uncheck 'Protect variable'"
>
> "**2. `GITLAB_TOKEN`** — Lets the job post MR comments and update the sticky tracking note."
> " - Create a **Group Access Token** at {group_url}/-/settings/access_tokens (recommended for group-wide setup), a **Project Access Token** at {project_url}/-/settings/access_tokens, or a **Personal Access Token** at https://gitlab.com/-/user_settings/personal_access_tokens."
> " - Role: `Developer` or higher. Scope: `api`."
> " - Add at the same level as INDUSTRY_API_KEY: Key=`GITLAB_TOKEN`, Value=the token, check 'Mask variable', uncheck 'Protect variable'."
>
> "Without both variables, the pipeline will fail with `Missing INDUSTRY_API_KEY` or `GitLab API 401: Unauthorized` from the prepare step."

## GitLab CI Templates

The Drool review pipeline is published as a reusable GitLab CI/CD Component at `industry-components/drool-action` on gitlab.com (a mirror of the public drool-action repo). Consuming projects just `include:` the template — they don't need to script `drool exec`, install the CLI, or maintain the review pipeline themselves.

The template provides the full two-pass review (candidate generation + validator), inline MR comments, a sticky tracking note with telemetry, and an optional parallel security-reviewer subagent — all configured via inputs.

### Full .gitlab-ci.yml (for new files)

Generate this when creating a new `.gitlab-ci.yml`:

```yaml
include:
  - project: 'industry-components/drool-action'
    ref: main
    file: '/templates/drool-review.yml'
    inputs:
      drool_action_ref: main
      automatic_security_review: '{automatic_security_review}' # "true" or "false"
      review_depth: '{review_depth}' # "deep" or "shallow"
```

Substitute `{automatic_security_review}` with `"true"` or `"false"` based on the Step 5 answers, and `{review_depth}` with `"deep"` or `"shallow"`.

Notes:

- The Component pins `industry-components/drool-action` at the `main` branch. Pin to a tag (e.g. `v0.1.0`) or commit SHA in production to make the pipeline reproducible. Both `ref:` on the include AND the `drool_action_ref:` input should match.
- The job defaults to `stage: test`. This works for projects without a custom `stages:` list (GitLab's implicit default ordering includes `test`). For projects with a custom `stages:` list that omits `test`, see the stages-check guidance in the append snippet below.
- `INDUSTRY_API_KEY` and `GITLAB_TOKEN` CI/CD variables are inherited automatically (the template references them by name from the job environment). Do NOT add an explicit `variables:` override block for these — explicit re-interpolation can break inheritance on some projects.

### Append snippet (for existing .gitlab-ci.yml)

When appending to an existing file:

1. Read the existing file content.
2. Check whether it already has an `include:` block. If yes, append the new entry under the existing `include:`. If no, add a top-level `include:` block.
3. **Check the existing `stages:` list (if present).** The Component's job defaults to `stage: test`, so the job needs `test` to be a valid stage:
   - If there is no top-level `stages:` key → no change required (GitLab uses an implicit default that includes `test`).
   - If `stages:` exists AND already contains `test` → no change required.
   - If `stages:` exists but does NOT contain `test`, pick ONE of:
     - **Option A (recommended):** append `- test` to the existing `stages:` list. This is the smallest possible change and keeps the Drool job isolated from the project's existing stages.
     - **Option B:** leave `stages:` alone and add a `stage: "<existing-stage>"` input to the Component include (e.g. `stage: "build"` if the project has `- build` in its `stages:`). Use this if the user explicitly wants the Drool job grouped with an existing stage in the pipeline UI.
   - Ask the user which option they prefer before modifying the file, defaulting to Option A.
4. Append:

   ```yaml
   include:
     - project: 'industry-components/drool-action'
       ref: main
       file: '/templates/drool-review.yml'
       inputs:
         drool_action_ref: main
         automatic_security_review: '{automatic_security_review}'
         review_depth: '{review_depth}'
         # Add `stage: "<existing-stage>"` here if you picked Option B above.
   ```

Do NOT overwrite the existing file content — read it first, then merge.

## Error Handling (GitLab)

| Error                                 | Cause                                                          | Fix                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `glab: command not found`             | glab CLI not installed                                         | Tell user: `brew install glab` or visit https://gitlab.com/gitlab-org/cli                                                   |
| `401 Unauthorized`                    | Not authenticated                                              | Tell user: `glab auth login`                                                                                                |
| `403 Forbidden` on project files      | Insufficient permissions                                       | User needs at least Maintainer access                                                                                       |
| `403 Forbidden` on security policies  | Not group Owner                                                | User needs Owner access for Pipeline Execution Policies                                                                     |
| `404` on group variables              | Variable doesn't exist                                         | Guide user to create it in group CI/CD settings                                                                             |
| `404` on security policies API        | Not on Ultimate tier                                           | Tell user: Pipeline Execution Policies require GitLab Ultimate                                                              |
| `400` on file create                  | File already exists                                            | Use PUT instead of POST to update                                                                                           |
| Branch already exists                 | Previous run didn't complete                                   | Delete the branch or skip the project                                                                                       |
| `chosen stage X missing from stages:` | Custom `stage:` input doesn't appear in project `stages:` list | Either remove the `stage:` input (defaults to `test`) or add the chosen stage to the project's `stages:` list               |
| `Missing INDUSTRY_API_KEY`             | CI/CD variable not set or not inherited                        | Verify INDUSTRY_API_KEY is masked + non-protected at a level the project inherits from (Step 3b)                             |
| `GitLab API 401: Unauthorized`        | GITLAB_TOKEN missing, expired, or insufficient scope           | Re-issue a Project/Group/Personal Access Token with `api` scope and re-set the CI/CD variable (Step 3b)                     |
| `include: project: ... 401` or `404`  | industry-components/drool-action not accessible from runner     | Confirm the consuming project's CI/CD environment can reach gitlab.com (no egress block) and that the include `ref:` exists |

---

## Language

Respond in the same language the user is writing in. If the user writes in Japanese, respond in Japanese. If they write in Korean, respond in Korean. This applies to all messages, AskUser questions, error guidance, and summaries. The only things that must stay in English are: git commit messages, branch names, PR titles/bodies (these are technical artifacts), and the workflow YAML content itself.
