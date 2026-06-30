---
name: install-triage
description: >
  Scaffold a scheduled Slack triage automation, generalized to any company.
  Sets up a Python tool layer (run_triage.py) plus a HEARTBEAT.md agent loop that
  scans configured Slack channels for actionable messages, dedupes against a
  ticketing system (Linear or Jira), files tickets, and posts a run summary.
  Use when the user wants to stand up an automated triage bot.
user-invocable: true
---

# Install Triage

Clear all previous plans and todos. Your previous task is complete. Your new task is to scaffold a scheduled **triage automation** for this user.

A triage automation runs on a schedule, scans a set of Slack channels for messages that represent distinct, actionable work, dedupes them against an existing ticketing backlog (Linear or Jira), files tickets for the genuinely new/actionable ones, and posts a run summary to a Slack channel. The Python tool layer below does only mechanical I/O; the deployed automation's agent makes every judgement call (actionability, routing, dedupe).

**Before starting, create a todo list from the phases below.**

## Where to scaffold

Automations live at `~/.industry/automations/<slug>/` (or `~/.industry-dev/automations/<slug>/` in dev). If you were invoked from the automations UI, the create prompt has already told you the exact automation root and slug, and has pre-written `memory/config.json` and `memory/state.json`. Use that root. Otherwise, ask the user for an automation name, derive a kebab-case slug, and use `~/.industry/automations/<slug>/`.

All paths below are **relative to the automation root**.

## Phase 1 — Gather configuration

The automation is configured entirely by `memory/config.json`:

```json
{
  "name": "Triage",
  "scan_channels_description": "the eng on-call and support channels",
  "scan_channels": [{ "id": "C0123", "name": "engineering" }],
  "summary_channel_description": "#automation-triage",
  "summary_channel": { "id": "C0999", "name": "automation-triage" },
  "ticket_system": "linear",
  "default_destination_description": "Engineering",
  "default_destination": {
    "key": "ENG",
    "id": "<team id>",
    "name": "Engineering"
  },
  "ticket_guidance": "Routing rules, labels, default team/project...",
  "window_secs": 3900
}
```

`scan_channels` (an array of `{ "id": "C…", "name": "…" }`), `summary_channel` (a single `{ "id": "C…", "name": "…" }`), and `default_destination` are **required at runtime** — `run_triage.py discover` reads `scan_channels`, posting the summary reads `summary_channel`, and `ticket-context` uses `default_destination` as the low-confidence fallback (the team for Linear, the project for Jira; Jira needs a project to file at all). The `*_description` fields are the user's plain-language descriptions; they are hints for resolving the real values, not substitutes for them.

- **If `memory/config.json` already exists** (UI flow), read it and use it as the source of truth for the ticket system and guidance — do NOT re-ask for those. However, the UI does **not** resolve the channels or destination: the file has `scan_channels_description`, `summary_channel_description`, and `default_destination_description` but may have no resolved `scan_channels` / `summary_channel` / `default_destination`. You MUST:
  1. Resolve `scan_channels_description` and `summary_channel_description` into actual Slack channels — list the available channels with the Slack tooling (or ask the user to paste channel ids) and match them to the descriptions.
  2. Resolve `default_destination_description` into a real team (Linear) / project (Jira) — run `python3 run_triage.py ticket-context` (after secrets are written) to list teams/projects and match it.
  3. Confirm the resolved scan-channel set, the single summary channel, and the default destination with the user via the `AskUser` tool (let them add/remove channels).
  4. Write them back into `memory/config.json` as `scan_channels`, `summary_channel`, and `default_destination` before finishing. The summary channel may be one the bot has not joined yet — that is fine, `run_triage.py` auto-joins it on first post.
- **If it does not exist** (standalone `/install-triage`), use the `AskUser` tool to collect:

  1. Which Slack channels to scan (resolve names to channel ids — list channels with the Slack tooling or ask the user to paste ids), and confirm the resolved set with the user.
  2. Which Slack channel to post the run summary to (resolve to a channel id; the bot auto-joins on first post).
  3. Which ticketing system (`linear` or `jira`).
  4. The default destination — the Linear team / Jira project tickets route to when there's no clear owner (resolve to `{key,id?,name}` via `ticket-context`).
  5. Ticket-filing guidance: routing rules, which labels/issue types to apply, and the default team (Linear) or project (Jira).

  Then write `memory/config.json` with those values (including a populated `scan_channels`, `summary_channel`, and `default_destination`). `window_secs` should be roughly the schedule interval plus a small overlap (e.g. `3900` for an hourly schedule).

## Phase 2 — Secrets (NEVER COMMIT)

The tool layer reads credentials from `memory/secrets.json`. Before writing any secret:

1. Create `.gitignore` at the automation root containing:

   ```
   memory/secrets.json
   memory/*.db
   ```

2. Use `AskUser` to collect the credentials and write `memory/secrets.json`:

   - Always: `SLACK_BOT_TOKEN` — a Slack bot token with scopes to read the scan channels (`channels:history`, `groups:history`, `channels:read`, `channels:join`) and post to the summary channel (`chat:write`), plus `files:read` if screenshots are needed.
   - When `ticket_system` is `linear`: `LINEAR_API_KEY`.
   - When `ticket_system` is `jira`: `JIRA_BASE_URL` (e.g. `https://acme.atlassian.net`), `JIRA_EMAIL`, and `JIRA_API_TOKEN`.

   Never echo the secret values back to the user, into logs, reports, or `VISUAL.html`.

## Phase 3 — Write the tool layer

Write the following file verbatim to `run_triage.py` at the automation root. Do NOT modify it — it is company-agnostic and reads everything from `memory/config.json` and `memory/secrets.json`. After writing it, run `python3 run_triage.py --help` and confirm it prints the usage text with no error.

```python
{{RUN_TRIAGE_PY}}
```

## Phase 4 — Write HEARTBEAT.md

Write `HEARTBEAT.md` at the automation root. Use the template below, then **fill the "Routing & filing guidance" section with the user's `ticket_guidance` from `config.json`** (reproduce it, and expand it into concrete rules if helpful). Set the `schedule` frontmatter to the schedule the automation was created with (default `0 * * * *`). Keep the agent loop intact — it references the `ticket-*` subcommands of the tool layer, which abstract over Linear and Jira.

```markdown
---
name: '<automation name>'
description: 'Scans Slack channels for actionable work, dedupes against the ticketing system, files tickets, posts a summary'
schedule: '0 * * * *'
templateId: triage
tags:
  - automations
---

# <automation name>

You are a triage agent. Every run you scan the configured Slack channels for
messages that represent distinct, actionable work items, check the ticketing
system for duplicates, file tickets when missing, route them per the guidance
below, and post a summary.

**You make the judgement calls.** The Python tool layer (`run_triage.py`) only
does mechanical I/O. Actionability, routing, and dedupe are your decisions.

## Tool layer

A single CLI at `run_triage.py` exposes the I/O primitives. Every subcommand
reads inputs from argv or stdin JSON and emits one JSON document on stdout. Run
`python3 run_triage.py --help` for the full list. The ones you use each run:

| Subcommand                                                                            | What it does                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discover`                                                                            | pulls recent messages from the configured scan channels, drops excluded subtypes and already-processed `(channel_id, ts)` pairs, resolves permalinks, enriches attachment/block bodies. Returns `candidates` plus `messages_consumed` (raw count pulled before filtering).                  |
| `ticket-context`                                                                      | ticketing metadata for routing. Linear: teams + labels + fallback team. Jira: projects + issue types + labels.                                                                                                                                                                              |
| `ticket-search-permalink <url>`                                                       | hard-duplicate check for a Slack permalink.                                                                                                                                                                                                                                                 |
| `ticket-search <query>`                                                               | semantic search of existing tickets (title/state/preview).                                                                                                                                                                                                                                  |
| `ticket-create` (stdin JSON)                                                          | create a ticket. Linear keys: `{team_id, title, description, label_names?, slack_url?, sync_to_thread?}`. Jira keys: `{project_key, title, description, issue_type?, label_names?, slack_url?}`. Returns `{ticket:{id,identifier,url}, warnings?}`.                                         |
| `ticket-link-slack` (stdin JSON `{issue_id, url, title?, sync_to_thread?}`)           | link an existing ticket to a Slack message (Linear native attachment / Jira remote link).                                                                                                                                                                                                   |
| `attach-screenshots` (stdin JSON `{issue_id, files:[{url_private,name?,mimetype?}]}`) | download Slack files and attach them to the ticket.                                                                                                                                                                                                                                         |
| `slack-reply` (stdin JSON `{channel, ts, text}`)                                      | threaded reply.                                                                                                                                                                                                                                                                             |
| `slack-post` (stdin JSON `{channel, text}`)                                           | non-threaded message (run summary).                                                                                                                                                                                                                                                         |
| `resolve-summary-channel`                                                             | returns the configured summary channel id (joining it if needed).                                                                                                                                                                                                                           |
| `record-decision` (stdin JSON)                                                        | persist your decision. Required: `channel_id`, `ts`, `action` ∈ {`created`, `skipped_duplicate`, `skipped_not_actionable`, `skipped_bot_noise`}. Optional: `permalink`, `ticket_id`, `ticket_url`, `reason`, `confidence`, `route_key`.                                                     |
| `finalize` (stdin JSON)                                                               | writes run metrics, the markdown report, the run-log line in `notes.md`, ages out old rows, regenerates `VISUAL.html`, and best-effort reports messages consumed to the Industry backend. Accepts `{scanned, consumed, evaluated, created, dup, na, tickets, skipped?, errors?, warnings?}`. |

Credentials live in `memory/secrets.json`; the tool layer reads them itself.
Never log or echo their values.

## What counts as "actionable"

INCLUDE — file a ticket for:

- Bug reports with observable symptoms ("X is broken", "Y returns 500")
- Concrete requests ("we should add…", "can we change…", "would be nice if…")
- Customer escalations with a clear ask or reproduction
- Regressions ("this used to work", "since deploy X…")
- Specific design/performance feedback with a proposed change or impact

EXCLUDE — skip and `record-decision` with a reason:

- Status updates, FYIs, acknowledgements, venting without a request
- Already-resolved threads ("nvm fixed it")
- Jokes, social messages, emoji-only replies
- Replies/discussion on an existing thread (`thread_ts` set and ≠ `ts`)
- Open questions whose resolution is an _answer_, not a change ("do we
  support X?", "is there interest in Y?"). File only when the resolution is a
  change to code, config, or design.

Borderline test: **"Would a reasonable tech lead, reading this cold, say
'someone should look into this'?"** Politeness phrasing does not make a concrete
request non-actionable — read for the underlying ask. Bot-authored messages
(`bot_id` set) are NOT auto-skipped; many bots relay human content — read the
body and apply the same test.

## Routing & filing guidance

<!-- Fill this in from config.json `ticket_guidance`. Describe how to choose the
target team (Linear) or project (Jira), which labels / issue types to apply, the
default/fallback destination when confidence is low, and how aggressively to
dedupe. Track recurring channel→destination patterns in notes.md. -->

When confidence is low or a message is cross-cutting, route to the configured
default/fallback destination rather than guessing.

## Run flow

1. **Discover.** `python3 run_triage.py discover`. Read `memory/notes.md` first
   for tuning observations. If `candidates` is empty, skip to step 6.
2. **Pull ticket context.** `python3 run_triage.py ticket-context`. Cache it for
   this run (teams/projects, labels/issue types, fallback destination).
3. **For each candidate — judge, dedupe, file:**
   - **a. Actionable?** Apply the rubric. If not, `record-decision` with
     `skipped_not_actionable` (or `skipped_bot_noise`).
   - **b. Split bundled asks** into separate candidates.
   - **c. Synthesize** title (≤ 80 chars, paraphrased), a short prose
     description, and 3–6 dedupe keywords.
   - **d. Dedupe.** First `ticket-search-permalink "<permalink>"` (hard check);
     each hit carries `matched_via`. Then `ticket-search "<keywords>"` and read
     the hits — ask "would the owning team close my new ticket as a duplicate of
     one of these?". When uncertain, err toward filing.
   - **e. On a duplicate**, link the permalink to the existing ticket
     (`ticket-link-slack`) and post a threaded `slack-reply` pointing to it,
     then record `skipped_duplicate`.
   - **f. Route** per the guidance section; pick a confidence (high/medium/low).
   - **g. Create the ticket** with `ticket-create`. Pass the Slack permalink as
     `slack_url` (do not put it in the description). Apply labels / issue type
     per guidance. Fold any returned `warnings` into the run warnings — never
     roll back a filed ticket.
   - **h. Reply in Slack** (`slack-reply`, ≤ 3 lines) pointing at the new ticket
     and why it was actionable.
   - **i. Record** with `record-decision` `action: created`, including
     `ticket_id`, `ticket_url`, `confidence`, and `route_key`.
4. **Attachments.** If a candidate's `files` array is non-empty, call
   `attach-screenshots` right after the ticket is created.
5. **Run summary.** `resolve-summary-channel`, then `slack-post` a short summary
   to that channel. If zero tickets, say "No new tickets this window."
6. **Finalize.** Always run `finalize` (even with zero candidates) so the report,
   run log, and dashboard stay fresh. `evaluated` = candidates you looked at;
   `consumed` = `messages_consumed` from `discover` (raw messages pulled before
   filtering); `scanned` = `channels_scanned` from `discover`; merge `discover`
   warnings in.
7. **Tuning notes.** Append terse observations to `memory/notes.md` under a
   `## Tuning` section (false negatives, stable channel→destination mappings,
   channels with no actionable traffic).

## Memory layout

| Path                          | Purpose                                                                         | Mutability                               |
| ----------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------- |
| `memory/config.json`          | channels, summary channel, ticket system, guidance                              | read-only at runtime                     |
| `memory/triage.db`            | `processed_messages` (dedupe + audit, 14-day retention), `run_metrics`, `cache` | rewritten by tools                       |
| `memory/notes.md`             | tuning observations + run log                                                   | append-only by you                       |
| `memory/secrets.json`         | Slack + ticketing credentials                                                   | read-only, never committed               |
| `memory/state.json`           | automation `id` (for the backlink footer); `runCount`                           | `id` read-only; bump `runCount` each run |
| `reports/YYYY-MM-DD-HH-mm.md` | per-run report                                                                  | written by `finalize`                    |
| `VISUAL.html`                 | dashboard                                                                       | written by `finalize`                    |

## Operational guardrails

- Never log or echo any secret.
- One ticket per discrete issue. Split bundled Slack asks.
- `record-decision` is what marks a message handled — always call it for every
  candidate, including skips, or it will be re-evaluated next run.
- `finalize` must always run, even with zero candidates.
- If a subcommand returns non-zero or `{"ok": false}`, treat it as a hard error:
  collect it into `errors` for `finalize`, do not pretend success, and continue
  with the next candidate unless the failure is catastrophic (auth failure, no
  destinations available).
```

## Phase 5 — Scaffold state, memory, and dashboard

1. **`memory/state.json`** — if the create prompt assigned a UUID, it is already
   written; otherwise create `{ "id": "<uuid>", "runCount": 0 }`. The `id` is
   permanent and must never change; `runCount` is bumped each run.
2. **`memory/notes.md`** — create with a `## Tuning` heading and an empty
   `## Run log` section.
3. **`reports/`** — create the empty directory.
4. **`VISUAL.html`** — write a self-contained "awaiting first run" placeholder
   dashboard with `data-industry-visual-scaffold="true"` on the `<body>`. The
   `finalize` subcommand regenerates this with real data on the first run, so a
   simple branded placeholder is fine. Use the Industry accent `#EE6018` and the
   automation name as the `<h1>`.

## Phase 6 — Verify

- `python3 run_triage.py --help` prints usage with no error.
- `memory/config.json` and `memory/secrets.json` exist and parse as JSON.
- `.gitignore` excludes `memory/secrets.json` and `memory/*.db`.
- `HEARTBEAT.md`, `run_triage.py`, `memory/state.json`, and `VISUAL.html` exist.

## Definition of done

The automation root contains `HEARTBEAT.md`, `run_triage.py`, `VISUAL.html`,
`.gitignore`, `memory/config.json`, `memory/state.json`, `memory/notes.md`, and
an empty `reports/` directory; secrets are captured in `memory/secrets.json`
(gitignored); and `run_triage.py --help` runs cleanly.
