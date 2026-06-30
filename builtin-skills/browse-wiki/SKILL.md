---
name: browse-wiki
description: 'Search and read wiki documentation for a repository'
user-invocable: false
---

# Wiki search

Search and browse Industry Wiki documentation for any repository. Use the `drool wiki-read` and `drool wiki-search` CLI commands to find information in wiki pages.

## Local wiki access

Wiki pages may be stored locally under a `drool-wiki/` folder in the repository root. If a `drool-wiki/` directory exists in the current project, read `.md` files directly from it instead of using the CLI commands below. This is faster and works offline.

Only use `drool wiki-read` / `drool wiki-search` for remote access when no local `drool-wiki/` directory exists.

## Parsing wiki URLs

When a user pastes a Industry wiki URL, extract the relevant identifiers:

```
https://app.example.com/wiki/{wikiRunId}?page={pageId}
```

- `wikiRunId` — the wiki run identifier (required). Pass it via `--wiki-run-id`.
- `pageId` — a specific page within the wiki (optional). Pass it via `--page` to `wiki-read`.

Example: given `https://app.example.com/wiki/abc123?page=getting-started`, extract `wikiRunId=abc123` and `pageId=getting-started`.

## Page ID format

Page IDs use **double-dash (`--`) separators** to represent directory hierarchy, without `.md` extensions:

- ✅ `features--agent-readiness-reports` (correct)
- ✅ `overview--getting-started` (correct)
- ❌ `features/agent-readiness-reports.md` (wrong - causes 500 error)
- ❌ `agent-readiness-reports` (wrong - page not found if in subdirectory)

When browsing the page tree with `drool wiki-read --wiki-run-id <id>`, the correct page ID is shown in parentheses next to each page title. Use those exact IDs with the `--page` parameter.

## Available commands

### Browse historical wiki runs

Use `drool wiki-read --repo-url <url>` without `--wiki-run-id` and `--page` to list all historical wiki runs for a repository:

```bash
drool wiki-read --repo-url https://github.com/org/repo
```

This prints a table of all runs with their wiki run IDs, dates, branches, commit hashes, and page counts. Use `--wiki-run-id <id>` from the output to drill into a specific run.

### Browse the page tree

Use `drool wiki-read` to see the full page tree of a wiki:

```bash
# By repository URL + page (resolves the latest wiki run automatically)
drool wiki-read --repo-url https://github.com/org/repo --page index

# By wiki run ID (from a pasted wiki URL or history listing)
drool wiki-read --wiki-run-id abc123
```

This prints a hierarchical list of all pages with their titles and page IDs.

### Search for keywords

Use `drool wiki-search` to find pages matching a keyword:

```bash
# Search by repo URL
drool wiki-search --repo-url https://github.com/org/repo --query "authentication"

# Search by wiki run ID
drool wiki-search --wiki-run-id abc123 --query "deploy"

# Limit the number of results
drool wiki-search --repo-url https://github.com/org/repo --query "API" --limit 5
```

Results include page title, path, and a text snippet showing where the keyword appears.

### Read a specific page

Use `drool wiki-read --page` to fetch the full content of a page:

```bash
# By repo URL + page ID
drool wiki-read --repo-url https://github.com/org/repo --page getting-started

# By wiki run ID + page ID
drool wiki-read --wiki-run-id abc123 --page getting-started
```

This prints the page title, path, and full markdown content.

## Chaining commands

For most user questions about wiki content, chain the commands in this order:

1. **Browse history or tree first.** Run `drool wiki-read --repo-url <url>` to see available runs, or `drool wiki-read --wiki-run-id <id>` to see the page tree of a specific run.
2. **Search for the topic.** Run `drool wiki-search --repo-url <url> --query "<keyword>"` to find pages relevant to the user's question.
3. **Read specific pages.** Run `drool wiki-read --repo-url <url> --page <pageId>` for each relevant result to get the full content.

This approach gives you the best context: history shows available runs, the tree shows overall structure, search narrows to relevant pages, and reading gives the details.

## Handling common requests

**"What does the wiki say about X?"**
Search for X, then read the top results:

```bash
drool wiki-search --repo-url <url> --query "X"
drool wiki-read --repo-url <url> --page <pageId-from-results>
```

**"Show me the architecture docs"**
Browse the tree to find architecture-related pages, then read them:

```bash
drool wiki-read --wiki-run-id <id>
# Look for pages with "architecture" in the title
drool wiki-read --wiki-run-id <id> --page architecture
```

**"Find info about authentication"**
Search and read:

```bash
drool wiki-search --repo-url <url> --query "authentication"
drool wiki-read --repo-url <url> --page <relevant-pageId>
```

**User pastes a wiki URL**
Extract the wikiRunId (and optional pageId) from the URL and use them directly:

```bash
# Full URL: https://app.example.com/wiki/abc123?page=getting-started
drool wiki-read --wiki-run-id abc123 --page getting-started
```

## Tips

- When `--repo-url` is used without `--wiki-run-id` and `--page`, the command shows a history of all wiki runs. Add `--page` to auto-resolve the latest run and fetch a specific page.
- Search is case-insensitive and matches against both page titles and content.
- If search returns no results, try broader keywords or browse the tree to discover the right terminology.
- The `--json` flag is available on both commands for machine-readable output.
