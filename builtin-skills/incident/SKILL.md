---
name: incident
description: RCA runbook for alerts. Given an alert link (or prompted to provide one), identifies the alert type, verifies tooling/auth, and walks through root cause analysis using deep research. Persists learnings to incident-guidelines for future reuse.
user-invocable: true
---

# Incident Response

**IMPORTANT:** This is a built-in skill -- its content is already in context. If the Observability Tools Reference table at the end of this file isn't fully visible, ask the user which observability tools are involved and continue. When a provided alert link is auth-gated or FetchUrl fails, do **not** ask the user to paste alert text yet -- install/auth the required tool first.

## How to Use

```
/incident <alert-link>
```

If no alert link is provided, ask the user for one.

## Workflow

### Step 0: Check for Existing Guidelines

1. Use the Skill tool to invoke `incident-guidelines`
2. If the skill is found, parse the alert (Step 1) and check if it matches a known alert type in the guidelines
   - **Match found**: follow that alert type's documented tools/interfaces/auth/repos. Verify prerequisites (Step 2), then proceed to RCA (Step 3).
   - **No match found**: proceed with full discovery (Steps 1-3) as if no guidelines exist
3. If the skill is not found (doesn't exist yet), proceed with full discovery (Steps 1-3)

### Step 1: Fetch and Classify the Alert (tool-first)

1. Use FetchUrl to retrieve the alert content from the provided link (typically a Slack message)
2. If FetchUrl fails or the link is auth-gated, infer the platform from the URL/domain, choose the preferred interface from the Observability Tools Reference (CLI > API > MCP), and proceed to Step 2 to install/authenticate **before** asking for manual paste.
3. Once tool access is available, retrieve the alert details via the tool/API, then parse the alert to identify:
   - Which observability tools generated or are referenced by the alert
   - The error message, affected component, severity, and resolution status
   - Any run IDs, job names, timestamps, service names, or responder info
4. Identify which tools from the Observability Tools Reference table (at the end of this file) are needed to investigate
5. Only if the user explicitly declines tool install/auth or the tool cannot access the data, ask the user to paste the alert text/details.

### Step 2: Verify Prerequisites (install/auth before manual paste)

Consult the Observability Tools Reference table to choose the preferred interface and auth method before prompting the user.

**2.1 Tool availability (no auth yet)**

- Run `which <cli>` or `<cli> --version` to check if CLIs are installed
- Check if relevant MCP tools are available in the current session by looking for tool names with the expected prefix (e.g., `sentry___*` for Sentry MCP, `datadog___*` for Datadog MCP)
- If missing, AskUser whether to install the preferred interface (list preferred first per the table)
- Install (if approved), then verify version

**2.2 Authentication (after tool exists)**

- Check environment variables with `echo "${VAR:+set}"`
- Run documented test commands from the Observability Tools Reference table
- Only use AskUser to prompt for auth setup if no existing credentials are found

> **WARNING:** If any required tool is not installed or not authenticated, warn the user that proceeding without it will produce an inaccurate or incomplete RCA. Strongly recommend installing and authenticating before continuing. If the user declines, proceed but clearly note the limitation.

**Auth selection rules:**

- If a tool has multiple interfaces (e.g., CLI and MCP), use AskUser to let the user choose. List the preferred interface first (per the table's "Preferred?" column).
- Bias towards CLI when the platform has one.
- For auth, use AskUser to let the user choose their auth method. List persistent auth first as the recommended choice, followed by ephemeral options. If there are multiple ephemeral methods (e.g., browser-based vs. device-code), list device-code before browser since it doesn't require a local browser.
- Never ask for long-lived tokens or API keys. Exception: OAuth device-code or remote-bootstrap responses may be pasted once to complete auth. If the response includes an access/refresh token (or JWT), abort and restart with a safer method. Use AskUser to let them choose the auth method, then give the setup instructions as an assistant message and verify auth by running a test command.
- If Slack is needed: check the Observability Tools Reference table for the auth method.

**Repo discovery:**

- If the alert type was found in incident-guidelines, use the repos listed there -- no need to re-confirm with the user unless something looks wrong.
- If this is a new alert type (no guidelines match), you MUST search for repos BEFORE prompting the user. First, search the local filesystem for relevant repos and use `gh repo list` / `glab project list` to discover repos in the org. Only AFTER you have gathered candidates, present your findings to the user via AskUser and ask them to confirm which are relevant and add any you missed. Do not present any RCA until the repo list is confirmed.
- Clone any repos not already on the filesystem
- Do a deep search of the codebase(s) to understand the RCA flow -- read AGENTS.md and README files in the repo(s) first, then trace from the error through instrumentation, route handlers, and dependency calls

### Step 3: Investigate and Present RCA

Perform deep research using the verified tools and repos to determine root cause. Do NOT follow a rigid script -- use the tools to query logs, metrics, traces, and code to build a comprehensive understanding.

Present the RCA to the user including:

- The specific error and what caused it
- Why it happened (contributing factors)
- The failure pattern (intermittent vs consistent, frequency)
- Impact scope
- Suggested fixes

Iterate with the user until they are satisfied with the RCA.

### Step 4: Persist Guidelines

After the user confirms the RCA is correct, only proceed with persisting guidelines if the investigation produced meaningful findings worth reusing (e.g., new tool/auth/repo mappings, non-obvious gotchas). If so, ask if they'd like to save the alert type mapping as reusable guidelines so future alerts of this type can be RCA'd without rediscovering from scratch. Otherwise, skip this step entirely.

If yes:

1. If `incident-guidelines` skill doesn't exist yet, use AskUser to ask whether to write it at the project level (`.industry/skills/incident-guidelines/` in the repo, shared with teammates) or the user level (`~/.industry/skills/incident-guidelines/`, personal and cross-project)
2. Create or update the `incident-guidelines/SKILL.md` file
3. The guidelines entry should be concise -- list the alert type name, required tools/interfaces/auth methods, repos, and any generically-applicable gotchas discovered during the investigation
4. Do NOT include inline bash scripts, hardcoded API URLs, account IDs, step-by-step commands, or RCA findings specific to the particular alert that was investigated
5. Gotchas should be things that would help future investigations of the same alert type (e.g., auth quirks, tool-specific pitfalls, non-obvious configuration requirements, which dataset/table to query in which tool)
6. Never include sensitive data (API keys, tokens, secrets) in the guidelines file

If the guidelines file already exists and the alert matches an existing type, only prompt the user to update the entry if this RCA surfaced meaningful new gotchas or corrections not already captured. Otherwise, skip persisting any new guidelines.

The incident-guidelines skill should have the following frontmatter:

```yaml
---
name: incident-guidelines
description: Learned alert type mappings from /incident runs. Maps alert types to required tools, interfaces, auth methods, repos, and gotchas for faster RCA on recurring alert patterns.
user-invocable: false
---
```

---

## Observability Tools Reference

This table is a non-exhaustive reference for common observability tools. Do not install interfaces for every tool listed -- only install and authenticate into the tools that the specific alert requires. The table is a lookup guide for which interface and auth method to use when a given tool is needed.

Preference follows CLI > API > MCP. All persistent auth methods are headless.

Ephemeral auth annotations:

- `[headless]` = terminal-only, no browser needed
- `[browser]` = requires opening a browser on the local machine
- `[device-code]` = prints a URL + code to the terminal, no local browser needed. Run the command and present the output to the user -- it will contain a URL and code they can use to complete authentication on any device.
- `[remote-bootstrap]` = two-step headless flow requiring a persistent process. Each invocation generates a unique PKCE state, so you MUST keep the original process alive -- do NOT run the command twice or pipe into a new process. Steps:
  1. Write a Python script (stdlib only, no pip installs) using `subprocess.Popen(stdin=subprocess.PIPE, stdout=subprocess.PIPE, env={...,'PYTHONUNBUFFERED':'1'})`
  2. Read stdout char-by-char with `p.stdout.read(1)` until the prompt appears
  3. Extract the bootstrap command from the output and present it to the user via AskUser -- they run it on a machine with a browser and paste back the output
  4. Feed the response with `p.stdin.write(response + '\n'); p.stdin.flush()`

| Tool                          | Interface                      | Preferred? | Persistent Auth `[headless]`                                                                                                    | Ephemeral Auth                                                        |
| ----------------------------- | ------------------------------ | :--------: | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Slack (read threads/messages) | Industry integration (FetchUrl) |    Yes     | Pre-configured at https://app.example.com/settings/integrations. Test: FetchUrl a Slack link; prompt to connect only if it fails | None                                                                  |
| Sentry                        | CLI (`sentry`)                 |    Yes     | `SENTRY_AUTH_TOKEN`                                                                                                             | `sentry auth login` `[device-code]`                                   |
| Sentry                        | MCP (`sentry-mcp`)             |     No     | `SENTRY_AUTH_TOKEN` (stdio transport)                                                                                           | MCP OAuth 2.0 `[browser]` (cloud transport)                           |
| Datadog                       | API                            |    Yes     | `DD-API-KEY` + `DD-APPLICATION-KEY` headers                                                                                     | None                                                                  |
| Datadog                       | MCP                            |     No     | `DD_API_KEY`+`DD_APP_KEY`                                                                                                       | MCP OAuth 2.0 `[browser]`                                             |
| AWS                           | CLI (`aws`)                    |    Yes     | `AWS_ACCESS_KEY_ID`+`AWS_SECRET_ACCESS_KEY`                                                                                     | `aws sso login` `[browser]` / `--no-browser` `[device-code]`          |
| GCP                           | CLI (`gcloud`/`bq`)            |    Yes     | `GOOGLE_APPLICATION_CREDENTIALS` (SA key JSON)                                                                                  | `gcloud auth login` `[browser]` / `--no-browser` `[remote-bootstrap]` |
| Grafana                       | API                            |    Yes     | `Authorization: Bearer <sa-token>`                                                                                              | None                                                                  |
| Grafana                       | MCP (`mcp-grafana`)            |     No     | `GRAFANA_SERVICE_ACCOUNT_TOKEN` (+ `GRAFANA_URL`)                                                                               | None                                                                  |
| Elasticsearch                 | API                            |    Yes     | `Authorization: ApiKey <base64>` or Basic Auth                                                                                  | None                                                                  |
| Elasticsearch                 | MCP                            |     No     | `ES_API_KEY` / `ELASTICSEARCH_USERNAME`+`PASSWORD`                                                                              | None                                                                  |
| PagerDuty                     | CLI (`pd`)                     |    Yes     | `pd auth:set --token <token>`                                                                                                   | `pd auth:web` `[browser]`                                             |
| PagerDuty                     | MCP                            |     No     | `PAGERDUTY_API_TOKEN`                                                                                                           | None                                                                  |
| Prometheus                    | CLI (`promtool`)               |    Yes     | Bearer token / basic auth via `--http.config.file` YAML                                                                         | None                                                                  |
| Splunk (on-prem)              | CLI (`splunk`)                 |    Yes     | Auth Token via `-token` flag                                                                                                    | `splunk login` (user/pass prompt) `[headless]`                        |
| Splunk (Cloud)                | API                            |    Yes     | `Authorization: Bearer <token>`                                                                                                 | None                                                                  |
| Splunk (Cloud)                | MCP                            |     No     | `SPLUNK_TOKEN` + `SPLUNK_URL`                                                                                                   | None                                                                  |
| New Relic                     | CLI (`newrelic`)               |    Yes     | `NEW_RELIC_API_KEY` via `newrelic profile add`                                                                                  | None                                                                  |
| New Relic                     | MCP                            |     No     | `NEW_RELIC_API_KEY` + `NEW_RELIC_ACCOUNT_ID`                                                                                    | None                                                                  |
| Loki                          | CLI (`logcli`)                 |    Yes     | `LOKI_BEARER_TOKEN` / `LOKI_USERNAME`+`LOKI_PASSWORD`                                                                           | None                                                                  |
| Dynatrace                     | API                            |    Yes     | `Authorization: Api-Token <token>`                                                                                              | None                                                                  |
| Dynatrace                     | MCP                            |     No     | `DT_API_TOKEN` / `DT_CLIENT_ID`+`DT_CLIENT_SECRET`                                                                              | MCP OAuth `[browser]`                                                 |
| Axiom                         | CLI (`axiom`)                  |    Yes     | `AXIOM_TOKEN`                                                                                                                   | `axiom auth login` `[browser]`                                        |
| Axiom                         | MCP (`mcp.axiom.co`)           |     No     | `AXIOM_TOKEN`                                                                                                                   | None                                                                  |
| Databricks                    | CLI (`databricks`)             |    Yes     | `DATABRICKS_TOKEN` / `DATABRICKS_CLIENT_ID`+`SECRET`                                                                            | `databricks auth login` `[browser]`                                   |
| Opsgenie                      | API                            |    Yes     | `Authorization: GenieKey <key>`                                                                                                 | None                                                                  |
| Honeycomb                     | API                            |    Yes     | `X-Honeycomb-Team: <api-key>`                                                                                                   | None                                                                  |
| Honeycomb                     | MCP                            |     No     | `HONEYCOMB_API_KEY`                                                                                                             | MCP OAuth 2.0 `[browser]`                                             |
| Snowflake                     | CLI (`snowsql`/`snow`)         |    Yes     | Key pair (`private_key_path`) / `SNOWSQL_PWD`                                                                                   | `--authenticator externalbrowser` `[browser]`                         |
| Jaeger                        | API                            |    Yes     | No built-in auth (reverse proxy dependent)                                                                                      | None                                                                  |
| Bugsnag                       | API                            |    Yes     | `Authorization: token <token>`                                                                                                  | None                                                                  |
| Sumo Logic                    | API                            |    Yes     | HTTP Basic Auth (`accessId:accessKey`)                                                                                          | None                                                                  |
| Rollbar                       | API                            |    Yes     | `X-Rollbar-Access-Token` header                                                                                                 | None                                                                  |
| incident.io                   | API                            |    Yes     | `Authorization: Bearer <api-key>`                                                                                               | None                                                                  |
| incident.io                   | MCP                            |     No     | `INCIDENT_IO_API_KEY`                                                                                                           | MCP OAuth 2.0 `[browser]`                                             |
| Rootly                        | API                            |    Yes     | `Authorization: Bearer <token>`                                                                                                 | None                                                                  |
| Rootly                        | MCP                            |     No     | `ROOTLY_API_TOKEN`                                                                                                              | None                                                                  |
| Betterstack                   | API                            |    Yes     | `Authorization: Bearer <token>`                                                                                                 | None                                                                  |
| Betterstack                   | MCP                            |     No     | `BETTER_STACK_API_TOKEN`                                                                                                        | None                                                                  |
| Papertrail                    | CLI (`papertrail`)             |    Yes     | `PAPERTRAIL_API_TOKEN`                                                                                                          | None                                                                  |
| Honeybadger                   | CLI (`hb`)                     |    Yes     | `HONEYBADGER_PERSONAL_AUTH_TOKEN` / `HONEYBADGER_API_KEY`                                                                       | None                                                                  |
| Honeybadger                   | MCP                            |     No     | `HONEYBADGER_PERSONAL_AUTH_TOKEN`                                                                                               | None                                                                  |
| Zipkin                        | API                            |    Yes     | No built-in auth (reverse proxy dependent)                                                                                      | None                                                                  |
| FireHydrant                   | API                            |    Yes     | `Authorization: Bearer <token>`                                                                                                 | None                                                                  |
| Statuspage                    | API                            |    Yes     | `Authorization: OAuth <key>`                                                                                                    | None                                                                  |
| Lightstep                     | API                            |    Yes     | `Authorization: Bearer <key>`                                                                                                   | None                                                                  |
| VictorOps                     | API                            |    Yes     | `X-VO-Api-Key`+`X-VO-Api-Id`                                                                                                    | None                                                                  |
