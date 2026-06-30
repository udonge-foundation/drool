---
name: install-wiki
description: |
  Install a CI action that automatically refreshes the Industry Wiki on each push to the default branch.
  Use when the user wants to set up automated wiki generation, install wiki CI, or configure wiki refresh.
user-invocable: true
---

# Install Wiki CI Action

You are setting up a CI action that will automatically refresh the Industry Wiki whenever code is pushed to the repository's default branch.

Follow these steps exactly. Do NOT skip any step. Do NOT proceed to the next step if the current one fails.

## Step 1: Verify Git Repository

Run `git rev-parse --is-inside-work-tree` to check if the current directory is inside a git repository.

If NOT in a git repo, tell the user:

> "This command must be run from within a git repository."

Then stop. Do not continue.

## Step 2: Detect CI Framework

Check which CI framework the repository uses:

1. Check if `.github/workflows/` directory exists (GitHub Actions)
2. Check if `.gitlab-ci.yml` file exists (GitLab CI)

If NEITHER is found, tell the user:

> "Could not detect a supported CI framework. Currently supported: GitHub Actions, GitLab CI. Please set up your CI framework first, then run this command again."

Then stop. Do not continue.

## Step 3: Check for Existing Wiki CI Action

Search for any existing wiki refresh CI configuration:

- **GitHub Actions**: Search all files in `.github/workflows/` for content matching both `drool` and `wiki` (e.g., `drool exec` with `/wiki` or `wiki-upload`).
- **GitLab CI**: Search `.gitlab-ci.yml` for content matching both `drool` and `wiki`.

If an existing wiki CI action is found, tell the user:

> "A wiki refresh CI action already exists in this repository: [filename]. No changes needed."

Then stop. Do not continue.

## Step 4: Detect Default Branch

Run `git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null` to get the default branch. Extract just the branch name (e.g., `main` from `refs/remotes/origin/main`).

If this fails, fall back to checking if `main` or `master` branch exists with `git rev-parse --verify origin/main 2>/dev/null` or `git rev-parse --verify origin/master 2>/dev/null`.

If none found, default to `main`.

## Step 5: Create the CI Configuration

### For GitHub Actions

Create the file `.github/workflows/drool-wiki-refresh.yml` with this exact content (replacing `DEFAULT_BRANCH` with the detected default branch):

```yaml
name: Drool Wiki Refresh

on:
  push:
    branches: [DEFAULT_BRANCH]

jobs:
  wiki-refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Industry Drool
        run: curl -fsSL https://app.example.com/cli | sh

      - name: Generate wiki
        run: drool exec --auto high "/wiki"
        env:
          INDUSTRY_API_KEY: ${{ secrets.INDUSTRY_API_KEY }}
```

### For GitLab CI

Before appending the job, read `.gitlab-ci.yml` and check the `stages:` list. Pick an existing stage that fits (e.g., `deploy`, `after_script`, or the last stage listed). If no `stages:` key exists, omit the `stage:` field entirely so GitLab uses the default `test` stage.

Append the following job to the existing `.gitlab-ci.yml` file (replacing `DEFAULT_BRANCH` with the detected default branch, and `DETECTED_STAGE` with the stage you found above):

```yaml
drool-wiki-refresh:
  stage: DETECTED_STAGE
  before_script:
    - curl -fsSL https://app.example.com/cli | sh
  script:
    - drool exec --auto high "/wiki"
  rules:
    - if: $CI_COMMIT_BRANCH == "DEFAULT_BRANCH"
  variables:
    INDUSTRY_API_KEY: $INDUSTRY_API_KEY
```

After creating/modifying the file, show the user what was created and remind them:

> "Make sure to add your `INDUSTRY_API_KEY` as a secret in your CI settings."

## Step 6: Offer to Create a PR

Ask the user if they would like to create a pull request for this change. If they say yes:

1. Create a new branch named `industry/install-wiki-ci`
2. Stage the new/modified CI file
3. Commit with message `ci: add Drool Wiki refresh action`
4. Push the branch
5. Create a PR with title `ci: add Drool Wiki refresh action` and a description explaining the change
