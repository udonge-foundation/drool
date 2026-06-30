#!/usr/bin/env python3
"""Triage automation tool layer (company-agnostic).

This script is NOT an autonomous agent. It is a thin CLI exposing mechanical
primitives (Slack I/O, ticketing I/O, SQLite state, report/dashboard
rendering) for an LLM-driven agent (see HEARTBEAT.md) to orchestrate. Every
judgement call -- actionability, routing, dedupe -- is the agent's job; this
file just does I/O.

It is configured entirely by `memory/config.json` (which channels to scan,
where to post the summary, and which ticketing system to file into) and
`memory/secrets.json` (never committed). Nothing about any specific company is
hardcoded.

memory/config.json:
  {
    "name": "Triage",
    "scan_channels": [{"id": "C123", "name": "engineering"}],
    "summary_channel": {"id": "C999", "name": "automation-triage"},
    "ticket_system": "linear" | "jira",
    "window_secs": 3900            # optional; lookback window per run
  }

memory/secrets.json (Slack always; ticketing depends on ticket_system):
  {
    "SLACK_BOT_TOKEN": "xoxb-...",
    "LINEAR_API_KEY": "lin_api_...",        # when ticket_system == linear
    "JIRA_BASE_URL": "https://acme.atlassian.net",  # when ticket_system == jira
    "JIRA_EMAIL": "bot@acme.com",
    "JIRA_API_TOKEN": "..."
  }

All subcommands read inputs from argv or stdin JSON and emit a single JSON
document to stdout. Errors are JSON {"ok": false, "error": "..."} with a
non-zero exit code. Never log secrets.

Subcommands:
  discover                 pull recent messages from the configured scan
                           channels, filter excluded subtypes, drop
                           already-processed (channel_id, ts) pairs, resolve
                           permalinks, and enrich attachment/block bodies.
  ticket-context           ticketing metadata for routing. Linear: teams +
                           labels + fallback team. Jira: projects + issue
                           types + labels.
  ticket-search            free-text search of existing tickets (soft dupes /
                           context).
  ticket-search-permalink  hard-duplicate check for a Slack permalink.
  ticket-create            create a ticket. Stdin JSON (provider-specific keys
                           tolerated): {team_id|project_key, title, description,
                           label_names?, issue_type?, slack_url?,
                           slack_attachment_title?, sync_to_thread?}.
  ticket-link-slack        link an existing ticket to a Slack message.
  attach-screenshots       download Slack files and attach them to a ticket.
  slack-reply              post a threaded reply. Stdin JSON: {channel, ts, text}.
  slack-post               post a non-threaded message. Stdin JSON: {channel, text}.
  resolve-summary-channel  return the configured summary channel id (joining it
                           if the bot is not yet a member).
  record-decision          persist an agent decision into processed_messages.
  finalize                 write run metrics, the markdown report, append to
                           notes.md, age out old rows, regenerate VISUAL.html,
                           and best-effort report messages consumed to the
                           Industry backend (Software Industry SIGNAL metric).
"""
from __future__ import annotations

import datetime as dt
import html
import json
import mimetypes
import os
import re as _re
import shutil
import sqlite3
import subprocess
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MEM = ROOT / "memory"
REPORTS = ROOT / "reports"
DB_PATH = MEM / "triage.db"
NOTES_PATH = MEM / "notes.md"
SECRETS_PATH = MEM / "secrets.json"
CONFIG_PATH = MEM / "config.json"
STATE_PATH = MEM / "state.json"
VISUAL_PATH = ROOT / "VISUAL.html"

SLACK = "https://slack.com/api"
LINEAR = "https://api.linear.app/graphql"

AUTOMATION_BASE_URL_DEV = "https://dev.app.example.com/automations"
AUTOMATION_BASE_URL_PROD = "https://app.example.com/automations"

EXCLUDED_SUBTYPES = {"channel_join", "channel_leave", "channel_topic",
                     "channel_purpose", "pinned_item"}
DEFAULT_WINDOW_SECS = 3900  # 65 min: hourly schedule + overlap

CATEGORY_LABEL_NAMES = ("bug", "chore", "enhancement", "feature", "papercut")


# ----- time / id helpers (timezone-aware UTC) -----

def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def iso_ts(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%MZ")


# ----- emit / errors / stdin -----

def emit(obj) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.write("\n")


def die(msg: str, code: int = 1) -> None:
    emit({"ok": False, "error": msg})
    sys.exit(code)


def read_stdin_json() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        die("expected JSON on stdin")
    try:
        return json.loads(raw)
    except Exception as e:  # noqa: BLE001
        die(f"invalid stdin JSON: {e}")
        return {}


# ----- HTTP -----

def _http(req: urllib.request.Request, timeout: int = 30) -> dict:
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode()
    return json.loads(body) if body else {}


def slack_call(method: str, token: str, params: dict | None = None,
               post: bool = False) -> dict:
    headers = {"Authorization": f"Bearer {token}"}
    url = f"{SLACK}/{method}"
    try:
        if post:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            body = urllib.parse.urlencode(params or {}).encode()
            return _http(urllib.request.Request(url, data=body, headers=headers,
                                                method="POST"))
        if params:
            url = url + "?" + urllib.parse.urlencode(params)
        return _http(urllib.request.Request(url, headers=headers, method="GET"))
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{method}: {e}"}


def linear_call(api_key: str, query: str, variables: dict | None = None) -> dict:
    headers = {"Authorization": api_key, "Content-Type": "application/json"}
    payload = json.dumps({"query": query, "variables": variables or {}}).encode()
    try:
        return _http(urllib.request.Request(LINEAR, data=payload,
                                            headers=headers, method="POST"))
    except Exception as e:  # noqa: BLE001
        return {"errors": [{"message": str(e)}]}


# ----- config / secrets -----

def load_config() -> dict:
    if not CONFIG_PATH.exists():
        die("config.json missing")
    try:
        cfg = json.loads(CONFIG_PATH.read_text())
    except Exception as e:  # noqa: BLE001
        die(f"invalid config.json: {e}")
        return {}
    if not isinstance(cfg, dict):
        die("config.json must be a JSON object")
    return cfg


def load_secrets() -> dict:
    if not SECRETS_PATH.exists():
        die("secrets.json missing")
    try:
        return json.loads(SECRETS_PATH.read_text())
    except Exception as e:  # noqa: BLE001
        die(f"invalid secrets.json: {e}")
        return {}


def automation_name(cfg: dict) -> str:
    name = cfg.get("name")
    return name if isinstance(name, str) and name.strip() else "Triage"


def window_secs(cfg: dict) -> int:
    val = cfg.get("window_secs")
    return int(val) if isinstance(val, (int, float)) and val > 0 else DEFAULT_WINDOW_SECS


# ----- automation backlink footer -----

def _automation_base_url() -> str:
    parts = {p.name for p in ROOT.parents}
    if ".industry-dev" in parts:
        return AUTOMATION_BASE_URL_DEV
    if ".industry" in parts:
        return AUTOMATION_BASE_URL_PROD
    return AUTOMATION_BASE_URL_DEV


def _automation_id() -> str | None:
    try:
        data = json.loads(STATE_PATH.read_text())
    except Exception:
        return None
    return data.get("id") if isinstance(data, dict) else None


def _automation_link() -> str | None:
    aid = _automation_id()
    return f"{_automation_base_url()}/{aid}" if aid else None


# ----- Software Industry metric reporting (best-effort) -----

def _industry_api_base_url() -> str | None:
    base = os.environ.get("INDUSTRY_API_BASE_URL")
    if base:
        return base.rstrip("/")
    derived = _automation_base_url()
    suffix = "/automations"
    return derived[: -len(suffix)] if derived.endswith(suffix) else derived


def report_messages_consumed(run_id: str, consumed: int,
                             warns: list[str]) -> None:
    """Report raw messages consumed to the Industry backend (best-effort).

    Powers the Software Industry SIGNAL metric. Prefers the hidden
    `drool record-triage-input` subcommand, which uses the CLI's built-in
    service-account auth and so works for any setup with an authenticated
    `drool` binary. Falls back to a direct API call when an explicit
    INDUSTRY_API_KEY is present. The backend restricts this route to service
    principals, so neither path is invokable by a human."""
    automation_id = _automation_id()
    if not automation_id:
        return
    occurred_at = int(utcnow().timestamp() * 1000)
    if _report_via_drool_cli(run_id, consumed, automation_id, occurred_at):
        return
    _report_via_api(run_id, consumed, automation_id, occurred_at, warns)


def _report_via_drool_cli(run_id: str, consumed: int, automation_id: str,
                          occurred_at: int) -> bool:
    """Report via `drool record-triage-input`. Returns True on success."""
    drool = shutil.which("drool")
    if not drool:
        return False
    try:
        result = subprocess.run(  # noqa: S603
            [drool, "record-triage-input",
             "--automation-id", automation_id,
             "--run-id", run_id,
             "--messages-consumed", str(int(consumed)),
             "--occurred-at", str(occurred_at)],
            capture_output=True, timeout=60, check=False)
    except Exception:  # noqa: BLE001
        return False
    return result.returncode == 0


def _report_via_api(run_id: str, consumed: int, automation_id: str,
                    occurred_at: int, warns: list[str]) -> None:
    api_key = os.environ.get("INDUSTRY_API_KEY")
    base = _industry_api_base_url()
    if not api_key or not base:
        return
    payload = json.dumps({
        "automationId": automation_id,
        "runId": run_id,
        "messagesConsumed": int(consumed),
        "occurredAt": occurred_at,
    }).encode()
    headers = {"Authorization": f"Bearer {api_key}",
               "Content-Type": "application/json"}
    url = f"{base}/api/v1/software-industry/triage-inputs"
    try:
        _http(urllib.request.Request(url, data=payload, headers=headers,
                                     method="POST"))
    except Exception as e:  # noqa: BLE001
        warns.append(f"report messages_consumed: {e}")


def _footer_label(cfg: dict) -> str:
    return f"{automation_name(cfg)} automation"


def _append_footer_to_description(description: str, cfg: dict) -> str:
    link = _automation_link()
    if not link or link in description:
        return description
    footer = f"\n\n---\n_Filed by [{_footer_label(cfg)}]({link})._\n"
    return description.rstrip() + footer


def _append_footer_to_slack(text: str, cfg: dict) -> str:
    link = _automation_link()
    if not link or link in text:
        return text
    return text.rstrip() + f"\n_via <{link}|{_footer_label(cfg)}>_"


FOOTER_MARKER = "\n\n---\n_Filed by ["


def _footer_adf_nodes(cfg: dict) -> list[dict]:
    link = _automation_link()
    if not link:
        return []
    label = _footer_label(cfg)
    return [
        {"type": "rule"},
        {"type": "paragraph", "content": [
            {"type": "text", "text": "Filed by ", "marks": [{"type": "em"}]},
            {"type": "text", "text": label,
             "marks": [{"type": "em"},
                       {"type": "link", "attrs": {"href": link}}]},
            {"type": "text", "text": ".", "marks": [{"type": "em"}]},
        ]},
    ]


# ----- DB -----

def init_db() -> sqlite3.Connection:
    MEM.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS processed_messages (
      slack_channel_id TEXT NOT NULL,
      slack_message_ts TEXT NOT NULL,
      slack_permalink  TEXT,
      ticket_id        TEXT,
      ticket_url       TEXT,
      action           TEXT NOT NULL,
      reason           TEXT,
      confidence       TEXT,
      route_key        TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (slack_channel_id, slack_message_ts)
    );
    CREATE TABLE IF NOT EXISTS run_metrics (
      run_id         TEXT PRIMARY KEY,
      started_at     TEXT NOT NULL,
      channels_scanned INTEGER,
      messages_evaluated INTEGER,
      tickets_created INTEGER,
      skipped_duplicate INTEGER,
      skipped_not_actionable INTEGER,
      errors         INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS cache (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    """)
    conn.commit()
    return conn


def cache_get(conn, key: str):
    row = conn.execute("SELECT value, updated_at FROM cache WHERE key=?",
                       (key,)).fetchone()
    return (row[0], row[1]) if row else (None, None)


def cache_put(conn, key: str, value: str):
    conn.execute(
        "INSERT INTO cache(key,value,updated_at) VALUES(?,?,datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, "
        "updated_at=excluded.updated_at",
        (key, value),
    )
    conn.commit()


def cache_age_days(updated_at: str | None) -> float:
    if not updated_at:
        return 1e9
    try:
        t = dt.datetime.fromisoformat(updated_at).replace(tzinfo=dt.timezone.utc)
    except Exception:
        return 1e9
    return (utcnow() - t).total_seconds() / 86400.0


# ----- Slack history / enrichment -----

def fetch_history(channel_id: str, oldest: float, token: str,
                  warns: list[str]) -> list[dict]:
    out: list[dict] = []
    cursor = ""
    joined = False
    while True:
        params = {"channel": channel_id, "oldest": f"{oldest:.6f}", "limit": "200"}
        if cursor:
            params["cursor"] = cursor
        resp = slack_call("conversations.history", token, params)
        if not resp.get("ok"):
            err = resp.get("error")
            if err == "not_in_channel" and not joined:
                joined = True
                join = slack_call("conversations.join", token,
                                  {"channel": channel_id}, post=True)
                if join.get("ok"):
                    continue
                warns.append(f"join {channel_id} failed: {join.get('error')}")
            warns.append(f"history {channel_id}: {err}")
            break
        out.extend(resp.get("messages", []))
        if not resp.get("has_more"):
            break
        cursor = resp.get("response_metadata", {}).get("next_cursor") or ""
        if not cursor:
            break
    return out


def get_permalink(channel_id: str, ts: str, token: str) -> str | None:
    resp = slack_call("chat.getPermalink", token,
                      {"channel": channel_id, "message_ts": ts})
    return resp.get("permalink") if resp.get("ok") else None


_INNER_PERMALINK_RE = _re.compile(
    r"https://[a-z0-9.-]+\.slack\.com/archives/[A-Z0-9]+/p\d+(?:\?[^|>\s]*)?",
    _re.IGNORECASE,
)


def _walk_blocks_text(blocks, out: list[str]) -> None:
    if not blocks:
        return
    for b in blocks:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t in ("section", "header"):
            txt = (b.get("text") or {}).get("text")
            if txt:
                out.append(txt)
            for f in b.get("fields") or []:
                ftxt = (f or {}).get("text")
                if ftxt:
                    out.append(ftxt)
        elif t == "context":
            for el in b.get("elements") or []:
                if isinstance(el, dict) and el.get("type") in ("mrkdwn", "plain_text"):
                    if el.get("text"):
                        out.append(el["text"])
        elif t == "rich_text":
            for el in b.get("elements") or []:
                for sub in (el or {}).get("elements", []) or []:
                    if isinstance(sub, dict) and sub.get("type") == "text" and sub.get("text"):
                        out.append(sub["text"])
                    elif isinstance(sub, dict) and sub.get("type") == "link" and sub.get("url"):
                        out.append(sub["url"])


def _extract_reporter_from_blocks(blocks) -> str | None:
    if not blocks:
        return None
    for b in blocks:
        if isinstance(b, dict) and b.get("type") == "context":
            for el in b.get("elements") or []:
                if isinstance(el, dict) and el.get("type") in ("mrkdwn", "plain_text"):
                    txt = (el.get("text") or "").strip()
                    if txt and not txt.lower().startswith(("view in ", "http")):
                        return txt
    return None


def enrich_message(m: dict) -> dict:
    parts: list[str] = []
    raw_text = m.get("text") or ""
    if raw_text:
        parts.append(raw_text)

    _walk_blocks_text(m.get("blocks"), parts)

    reporter_attr = None
    inner_permalink = None
    files: list[dict] = []

    for f in m.get("files", []) or []:
        files.append({"id": f.get("id"), "name": f.get("name"),
                      "mimetype": f.get("mimetype"),
                      "url_private": f.get("url_private")})

    for a in m.get("attachments") or []:
        if not isinstance(a, dict):
            continue
        for k in ("pretext", "title", "text"):
            v = a.get(k)
            if v:
                parts.append(v)
        a_blocks = a.get("blocks") or []
        block_parts: list[str] = []
        _walk_blocks_text(a_blocks, block_parts)
        if block_parts:
            parts.extend(block_parts)
        elif a.get("fallback"):
            parts.append(a["fallback"])
        if reporter_attr is None:
            reporter_attr = _extract_reporter_from_blocks(a_blocks)
        for f in a.get("files") or []:
            if isinstance(f, dict):
                files.append({"id": f.get("id"), "name": f.get("name"),
                              "mimetype": f.get("mimetype"),
                              "url_private": f.get("url_private")})

    body = "\n".join(p for p in (p.strip() for p in parts) if p)

    if inner_permalink is None:
        match = _INNER_PERMALINK_RE.search(body)
        if match:
            inner_permalink = match.group(0)

    seen = set()
    dedup_files = []
    for f in files:
        key = f.get("id") or f.get("url_private") or f.get("name")
        if key in seen:
            continue
        seen.add(key)
        dedup_files.append(f)

    return {"text": body, "files": dedup_files,
            "reporter_attribution": reporter_attr,
            "source_permalink": inner_permalink,
            "had_attachments": bool(m.get("attachments")),
            "had_blocks": bool(m.get("blocks"))}


def _slack_download(url: str, token: str) -> bytes:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


# ----- ticket provider abstraction -----

class TicketProvider:
    """Provider-agnostic ticketing interface. Concrete providers implement the
    mechanical I/O; the agent supplies all routing/dedupe judgement."""

    def context(self, conn, cfg: dict) -> dict:
        raise NotImplementedError

    def search(self, term: str) -> list[dict]:
        raise NotImplementedError

    def search_permalink(self, url: str) -> dict:
        raise NotImplementedError

    def create(self, conn, body: dict, cfg: dict) -> dict:
        raise NotImplementedError

    def link_slack(self, body: dict) -> dict:
        raise NotImplementedError

    def attach_screenshots(self, body: dict, slack_token: str, cfg: dict) -> dict:
        raise NotImplementedError


def _permalink_variants(url: str) -> list[str]:
    bare = url.split("?", 1)[0] if "?" in url else url
    variants: list[str] = []
    seen: set[str] = set()
    for u in (bare, url):
        if u and u not in seen:
            seen.add(u)
            variants.append(u)
    return variants


class LinearProvider(TicketProvider):
    def __init__(self, secrets: dict):
        self.api = secrets.get("LINEAR_API_KEY")
        if not self.api:
            die("LINEAR_API_KEY missing from secrets.json")

    def _fetch_teams(self) -> list[dict]:
        r = linear_call(self.api, "query { teams { nodes { id name key } } }")
        return r.get("data", {}).get("teams", {}).get("nodes", []) if not r.get("errors") else []

    def _fetch_labels(self) -> list[dict]:
        out: list[dict] = []
        after = None
        while True:
            q = ("query($after: String) { issueLabels(first: 250, after: $after) "
                 "{ pageInfo { hasNextPage endCursor } "
                 "nodes { id name team { id key } } } }")
            r = linear_call(self.api, q, {"after": after})
            if r.get("errors"):
                return out
            page = r.get("data", {}).get("issueLabels", {})
            out.extend(page.get("nodes", []))
            info = page.get("pageInfo", {})
            if not info.get("hasNextPage"):
                return out
            after = info.get("endCursor")

    def _load_labels(self, conn) -> list[dict]:
        labels_raw, l_at = cache_get(conn, "linear_labels_v2")
        if not labels_raw or cache_age_days(l_at) > 7:
            labels = self._fetch_labels()
            if labels:
                cache_put(conn, "linear_labels_v2", json.dumps(labels))
            return labels
        return json.loads(labels_raw)

    def context(self, conn, cfg: dict) -> dict:
        teams_raw, t_at = cache_get(conn, "linear_teams")
        if not teams_raw or cache_age_days(t_at) > 7:
            teams = self._fetch_teams()
            if teams:
                cache_put(conn, "linear_teams", json.dumps(teams))
        else:
            teams = json.loads(teams_raw)

        labels = self._load_labels(conn)
        teams_by_key = {t["key"]: t for t in teams}
        dd = cfg.get("default_destination") or {}
        fallback = None
        if dd.get("id"):
            fallback = next((t for t in teams if t["id"] == dd["id"]), None)
        if not fallback and dd.get("key"):
            fallback = teams_by_key.get(dd["key"])
        if not fallback and teams:
            fallback = teams[0]

        category_labels_by_team: dict[str, dict[str, str]] = {}
        for lbl in labels:
            team = lbl.get("team")
            if not team:
                continue
            name = lbl["name"].lower()
            if name not in CATEGORY_LABEL_NAMES:
                continue
            category_labels_by_team.setdefault(team["key"], {})[name] = lbl["id"]

        return {"provider": "linear", "teams": teams, "labels": labels,
                "fallback_team_id": fallback["id"] if fallback else None,
                "fallback_team_key": fallback["key"] if fallback else None,
                "category_labels_by_team": category_labels_by_team,
                "category_label_names": list(CATEGORY_LABEL_NAMES),
                "teams_by_key": list(teams_by_key.keys())}

    def search(self, term: str) -> list[dict]:
        q = ("query($term: String!) { searchIssues(term: $term, first: 5) { "
             "nodes { id identifier url title description "
             "state { name type } team { key name } } } }")
        r = linear_call(self.api, q, {"term": term})
        if r.get("errors"):
            die(f"linear: {r['errors']}")
        nodes = r.get("data", {}).get("searchIssues", {}).get("nodes", [])
        for n in nodes:
            desc = n.get("description") or ""
            if len(desc) > 600:
                n["description"] = desc[:600] + "..."
        return nodes

    def search_permalink(self, url: str) -> dict:
        hits: list[dict] = []
        seen: set[str] = set()
        variants = _permalink_variants(url)
        att_q = ("query($url:String!){ attachmentsForURL(url:$url, first:5){"
                 " nodes { id issue { id identifier url title state { name } } } } }")
        for variant in variants:
            ra = linear_call(self.api, att_q, {"url": variant})
            if ra.get("errors"):
                die(f"linear: {ra['errors']}")
            for n in (ra.get("data", {}).get("attachmentsForURL", {}).get("nodes") or []):
                iss = n.get("issue") or {}
                iid = iss.get("id")
                if iid and iid not in seen:
                    seen.add(iid)
                    tagged = dict(iss)
                    tagged["matched_via"] = "attachment"
                    tagged["matched_url"] = variant
                    hits.append(tagged)
        desc_q = ("query($f: IssueFilter) { issues(filter: $f, first: 5) { "
                  "nodes { id identifier url title state { name } } } }")
        for variant in variants:
            rd = linear_call(self.api, desc_q,
                             {"f": {"description": {"contains": variant}}})
            if rd.get("errors"):
                die(f"linear: {rd['errors']}")
            for iss in (rd.get("data", {}).get("issues", {}).get("nodes") or []):
                iid = iss.get("id")
                if iid and iid not in seen:
                    seen.add(iid)
                    tagged = dict(iss)
                    tagged["matched_via"] = "description"
                    tagged["matched_url"] = variant
                    hits.append(tagged)
        return {"hits": hits, "variants_checked": variants}

    def _link_slack(self, issue_id: str, url: str, title: str | None,
                    sync_to_thread: bool) -> dict:
        q = ("mutation($issueId:String!,$url:String!,$title:String,"
             "$syncToCommentThread:Boolean){"
             " attachmentLinkSlack(issueId:$issueId,url:$url,title:$title,"
             " syncToCommentThread:$syncToCommentThread){"
             " success attachment{ id url title } } }")
        r = linear_call(self.api, q, {"issueId": issue_id, "url": url,
                                      "title": title,
                                      "syncToCommentThread": sync_to_thread})
        if r.get("errors"):
            raise RuntimeError(f"attachmentLinkSlack: {r['errors']}")
        data = (r.get("data") or {}).get("attachmentLinkSlack") or {}
        if not data.get("success"):
            raise RuntimeError(f"attachmentLinkSlack not success: {r}")
        return data.get("attachment") or {}

    def create(self, conn, body: dict, cfg: dict) -> dict:
        for k in ("team_id", "title", "description"):
            if not body.get(k):
                die(f"missing field: {k}")
        label_ids: list[str] = list(body.get("label_ids") or [])
        warnings: list[str] = []
        requested_names = body.get("label_names") or []
        if requested_names:
            labels = self._load_labels(conn)
            team_id = body["team_id"]
            name_to_id = {l["name"].lower(): l["id"] for l in labels
                          if l.get("team") and l["team"].get("id") == team_id}
            for n in requested_names:
                lid = name_to_id.get(str(n).lower())
                if lid and lid not in label_ids:
                    label_ids.append(lid)
                elif not lid:
                    warnings.append(f"label '{n}' not found on team {team_id}; skipped")
        q = ("mutation($input: IssueCreateInput!) { issueCreate(input: $input) { "
             "success issue { id identifier url } } }")
        variables = {"input": {
            "teamId": body["team_id"],
            "title": body["title"],
            "description": _append_footer_to_description(body["description"], cfg),
            "labelIds": label_ids,
        }}
        r = linear_call(self.api, q, variables)
        if r.get("errors"):
            die(f"issueCreate: {r['errors']}")
        data = r.get("data", {}).get("issueCreate", {})
        if not data.get("success"):
            die(f"issueCreate not success: {r}")
        issue = data["issue"]
        out = {"ticket": {"id": issue["id"], "identifier": issue.get("identifier"),
                          "url": issue.get("url")},
               "label_ids": label_ids}
        slack_url = body.get("slack_url")
        if slack_url:
            try:
                out["slack_attachment"] = self._link_slack(
                    issue["id"], slack_url,
                    body.get("slack_attachment_title"),
                    bool(body.get("sync_to_thread", True)))
            except Exception as e:  # noqa: BLE001
                warnings.append(f"attachmentLinkSlack failed: {e}")
        if warnings:
            out["warnings"] = warnings
        return out

    def link_slack(self, body: dict) -> dict:
        for k in ("issue_id", "url"):
            if not body.get(k):
                die(f"missing field: {k}")
        att = self._link_slack(body["issue_id"], body["url"],
                               body.get("title"),
                               bool(body.get("sync_to_thread", True)))
        return {"attachment": att}

    # screenshot upload helpers ------------------------------------------
    def _file_upload(self, content_type: str, filename: str, size: int) -> dict:
        q = ("mutation($contentType:String!,$filename:String!,$size:Int!){"
             " fileUpload(contentType:$contentType,filename:$filename,size:$size){"
             " success uploadFile{ uploadUrl assetUrl contentType size filename"
             " headers{ key value } } } }")
        r = linear_call(self.api, q, {"contentType": content_type,
                                      "filename": filename, "size": size})
        if r.get("errors"):
            raise RuntimeError(f"fileUpload: {r['errors']}")
        data = (r.get("data") or {}).get("fileUpload") or {}
        if not data.get("success"):
            raise RuntimeError(f"fileUpload not success: {r}")
        return data["uploadFile"]

    @staticmethod
    def _put_signed(upload_url: str, content_type: str, data: bytes,
                    headers: list[dict]) -> None:
        hdrs = {"Content-Type": content_type}
        for h in headers or []:
            hdrs[h["key"]] = h["value"]
        req = urllib.request.Request(upload_url, data=data, headers=hdrs,
                                     method="PUT")
        with urllib.request.urlopen(req, timeout=120) as r:
            if r.status >= 300:
                raise RuntimeError(f"PUT signed url status={r.status}")

    def _attachment_create(self, issue_id: str, title: str, url: str) -> dict:
        q = ("mutation($input:AttachmentCreateInput!){ attachmentCreate(input:$input){"
             " success attachment{ id url } } }")
        r = linear_call(self.api, q, {"input": {"issueId": issue_id,
                                                "title": title, "url": url}})
        if r.get("errors"):
            raise RuntimeError(f"attachmentCreate: {r['errors']}")
        return (r.get("data") or {}).get("attachmentCreate") or {}

    def _get_description(self, issue_id: str) -> str | None:
        q = "query($id:String!){ issue(id:$id){ description } }"
        r = linear_call(self.api, q, {"id": issue_id})
        if r.get("errors"):
            raise RuntimeError(f"issue(description): {r['errors']}")
        return ((r.get("data") or {}).get("issue") or {}).get("description")

    def _update_description(self, issue_id: str, desc: str) -> None:
        q = ("mutation($id:String!,$input:IssueUpdateInput!){"
             " issueUpdate(id:$id,input:$input){ success } }")
        r = linear_call(self.api, q, {"id": issue_id, "input": {"description": desc}})
        if r.get("errors"):
            raise RuntimeError(f"issueUpdate: {r['errors']}")

    @staticmethod
    def _insert_embeds(desc: str, embeds: list[str]) -> str:
        new_embeds = [e for e in embeds if e not in desc]
        if not new_embeds:
            return desc
        block = "\n\n" + "\n\n".join(new_embeds)
        idx = desc.find(FOOTER_MARKER)
        if idx == -1:
            return desc.rstrip() + block + "\n"
        return desc[:idx].rstrip() + block + desc[idx:]

    def attach_screenshots(self, body: dict, slack_token: str, cfg: dict) -> dict:
        issue_id = body.get("issue_id")
        files = body.get("files") or []
        if not issue_id:
            die("missing field: issue_id")
        if not files:
            return {"uploaded": [], "attachments": [], "note": "no files"}
        uploaded: list[dict] = []
        attachments: list[dict] = []
        errors: list[str] = []
        for f in files:
            url_private = f.get("url_private")
            if not url_private:
                errors.append("file missing url_private")
                continue
            name = f.get("name") or "screenshot.png"
            ctype = f.get("mimetype") or "application/octet-stream"
            try:
                data = _slack_download(url_private, slack_token)
                uf = self._file_upload(ctype, name, len(data))
                self._put_signed(uf["uploadUrl"], ctype, data, uf.get("headers") or [])
                asset_url = uf["assetUrl"]
                uploaded.append({"name": name, "asset_url": asset_url,
                                 "size": len(data), "content_type": ctype})
                try:
                    ac = self._attachment_create(issue_id, name, asset_url)
                    attachments.append({"name": name, "result": ac})
                except Exception as e:  # noqa: BLE001
                    errors.append(f"attachmentCreate {name}: {e}")
            except Exception as e:  # noqa: BLE001
                errors.append(f"upload {name}: {e}")
        updated_desc = False
        if uploaded:
            try:
                desc = self._get_description(issue_id) or ""
                embeds = [f"![{u['name']}]({u['asset_url']})" for u in uploaded]
                new_desc = self._insert_embeds(desc, embeds)
                if new_desc != desc:
                    self._update_description(issue_id, new_desc)
                    updated_desc = True
            except Exception as e:  # noqa: BLE001
                errors.append(f"description embed: {e}")
        return {"uploaded": uploaded, "attachments": attachments,
                "description_updated": updated_desc, "errors": errors}


class JiraProvider(TicketProvider):
    def __init__(self, secrets: dict):
        import base64
        base = secrets.get("JIRA_BASE_URL")
        email = secrets.get("JIRA_EMAIL")
        token = secrets.get("JIRA_API_TOKEN")
        if not (base and email and token):
            die("JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN required in secrets.json")
        self.base = base.rstrip("/")
        creds = base64.b64encode(f"{email}:{token}".encode()).decode()
        self.auth = f"Basic {creds}"

    def _request(self, method: str, path: str, body: dict | None = None,
                 query: dict | None = None) -> dict:
        url = f"{self.base}{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        headers = {"Authorization": self.auth, "Accept": "application/json"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            return _http(req, timeout=30)
        except urllib.error.HTTPError as e:  # noqa: PERF203
            detail = ""
            try:
                detail = e.read().decode()
            except Exception:
                pass
            raise RuntimeError(f"jira {method} {path}: {e.code} {detail}")

    @staticmethod
    def _adf(text: str) -> dict:
        paragraphs = []
        for line in (text or "").split("\n"):
            if line.strip():
                paragraphs.append({"type": "paragraph",
                                   "content": [{"type": "text", "text": line}]})
            else:
                paragraphs.append({"type": "paragraph", "content": []})
        if not paragraphs:
            paragraphs = [{"type": "paragraph", "content": []}]
        return {"type": "doc", "version": 1, "content": paragraphs}

    def context(self, conn, cfg: dict) -> dict:
        projects: list[dict] = []
        try:
            r = self._request("GET", "/rest/api/3/project/search",
                              query={"maxResults": 100})
            for p in r.get("values", []):
                projects.append({"id": p.get("id"), "key": p.get("key"),
                                 "name": p.get("name")})
        except Exception as e:  # noqa: BLE001
            die(f"jira project search: {e}")
        issue_types: list[str] = []
        try:
            rt = self._request("GET", "/rest/api/3/issuetype")
            issue_types = sorted({t.get("name") for t in rt if t.get("name")})
        except Exception:
            issue_types = ["Bug", "Task", "Story"]
        labels: list[str] = []
        try:
            rl = self._request("GET", "/rest/api/3/label",
                               query={"maxResults": 200})
            labels = rl.get("values", []) or []
        except Exception:
            labels = []
        dd = cfg.get("default_destination") or {}
        fallback = dd.get("key") or (projects[0]["key"] if projects else None)
        return {"provider": "jira", "projects": projects,
                "issue_types": issue_types, "labels": labels,
                "fallback_project_key": fallback}

    def search(self, term: str) -> list[dict]:
        safe = term.replace('"', '\\"')
        jql = f'text ~ "{safe}" ORDER BY updated DESC'
        try:
            r = self._request("GET", "/rest/api/3/search",
                              query={"jql": jql, "maxResults": 5,
                                     "fields": "summary,status,project"})
        except Exception as e:  # noqa: BLE001
            die(f"jira search: {e}")
            return []
        out = []
        for it in r.get("issues", []):
            fields = it.get("fields", {})
            out.append({
                "id": it.get("id"), "identifier": it.get("key"),
                "url": f"{self.base}/browse/{it.get('key')}",
                "title": fields.get("summary"),
                "state": {"name": (fields.get("status") or {}).get("name")},
                "team": {"key": (fields.get("project") or {}).get("key")},
            })
        return out

    def search_permalink(self, url: str) -> dict:
        hits: list[dict] = []
        seen: set[str] = set()
        variants = _permalink_variants(url)
        for variant in variants:
            safe = variant.replace('"', '\\"')
            jql = f'text ~ "{safe}"'
            try:
                r = self._request("GET", "/rest/api/3/search",
                                  query={"jql": jql, "maxResults": 5,
                                         "fields": "summary,status"})
            except Exception as e:  # noqa: BLE001
                die(f"jira search: {e}")
                return {}
            for it in r.get("issues", []):
                iid = it.get("id")
                if iid and iid not in seen:
                    seen.add(iid)
                    fields = it.get("fields", {})
                    hits.append({"id": iid, "identifier": it.get("key"),
                                 "url": f"{self.base}/browse/{it.get('key')}",
                                 "title": fields.get("summary"),
                                 "state": {"name": (fields.get("status") or {}).get("name")},
                                 "matched_via": "text", "matched_url": variant})
        return {"hits": hits, "variants_checked": variants}

    def create(self, conn, body: dict, cfg: dict) -> dict:
        project_key = body.get("project_key") or body.get("team_id")
        if not project_key or not body.get("title"):
            die("missing field: project_key/title")
        issue_type = body.get("issue_type") or "Task"
        doc = self._adf(body.get("description") or "")
        doc["content"].extend(_footer_adf_nodes(cfg))
        fields = {
            "project": {"key": project_key},
            "summary": body["title"],
            "issuetype": {"name": issue_type},
            "description": doc,
        }
        labels = body.get("label_names") or []
        if labels:
            fields["labels"] = [str(l).replace(" ", "-") for l in labels]
        try:
            r = self._request("POST", "/rest/api/3/issue", body={"fields": fields})
        except Exception as e:  # noqa: BLE001
            die(f"jira create: {e}")
            return {}
        key = r.get("key")
        out = {"ticket": {"id": r.get("id"), "identifier": key,
                          "url": f"{self.base}/browse/{key}" if key else None}}
        warnings: list[str] = []
        slack_url = body.get("slack_url")
        if slack_url and r.get("id"):
            try:
                self._remote_link(r["id"], slack_url,
                                  body.get("slack_attachment_title") or "Slack thread")
            except Exception as e:  # noqa: BLE001
                warnings.append(f"remote link failed: {e}")
        if warnings:
            out["warnings"] = warnings
        return out

    def _remote_link(self, issue_id: str, url: str, title: str) -> dict:
        return self._request("POST", f"/rest/api/3/issue/{issue_id}/remotelink",
                             body={"object": {"url": url, "title": title}})

    def link_slack(self, body: dict) -> dict:
        for k in ("issue_id", "url"):
            if not body.get(k):
                die(f"missing field: {k}")
        link = self._remote_link(body["issue_id"], body["url"],
                                 body.get("title") or "Slack thread")
        return {"attachment": link}

    def attach_screenshots(self, body: dict, slack_token: str, cfg: dict) -> dict:
        issue_id = body.get("issue_id")
        files = body.get("files") or []
        if not issue_id:
            die("missing field: issue_id")
        if not files:
            return {"uploaded": [], "attachments": [], "note": "no files"}
        uploaded: list[dict] = []
        errors: list[str] = []
        for f in files:
            url_private = f.get("url_private")
            if not url_private:
                errors.append("file missing url_private")
                continue
            name = f.get("name") or "screenshot.png"
            ctype = f.get("mimetype") or mimetypes.guess_type(name)[0] or "application/octet-stream"
            try:
                data = _slack_download(url_private, slack_token)
                self._multipart_attach(issue_id, name, ctype, data)
                uploaded.append({"name": name, "size": len(data),
                                 "content_type": ctype})
            except Exception as e:  # noqa: BLE001
                errors.append(f"attach {name}: {e}")
        return {"uploaded": uploaded, "attachments": uploaded, "errors": errors}

    def _multipart_attach(self, issue_id: str, name: str, ctype: str,
                          data: bytes) -> None:
        boundary = f"----triage{uuid.uuid4().hex}"
        pre = (f"--{boundary}\r\n"
               f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'
               f"Content-Type: {ctype}\r\n\r\n").encode()
        post = f"\r\n--{boundary}--\r\n".encode()
        payload = pre + data + post
        url = f"{self.base}/rest/api/3/issue/{issue_id}/attachments"
        headers = {"Authorization": self.auth,
                   "X-Atlassian-Token": "no-check",
                   "Content-Type": f"multipart/form-data; boundary={boundary}"}
        req = urllib.request.Request(url, data=payload, headers=headers,
                                     method="POST")
        with urllib.request.urlopen(req, timeout=120) as r:
            if r.status >= 300:
                raise RuntimeError(f"attach status={r.status}")


def get_provider(cfg: dict, secrets: dict) -> TicketProvider:
    system = (cfg.get("ticket_system") or "linear").lower()
    if system == "jira":
        return JiraProvider(secrets)
    if system == "linear":
        return LinearProvider(secrets)
    die(f"unknown ticket_system: {system}")
    raise SystemExit(1)


# ----- subcommand: discover -----

def cmd_discover(_args: list[str]) -> None:
    cfg = load_config()
    secrets = load_secrets()
    token = secrets.get("SLACK_BOT_TOKEN")
    if not token:
        die("SLACK_BOT_TOKEN missing from secrets.json")
    conn = init_db()
    warns: list[str] = []

    auth = slack_call("auth.test", token)
    if not auth.get("ok"):
        die(f"slack auth.test: {auth.get('error')}")

    channels = cfg.get("scan_channels") or []
    if not channels:
        die("config.json scan_channels is empty")
    cache_put(conn, "channels",
              json.dumps([{"id": c.get("id"), "name": c.get("name")} for c in channels]))

    oldest = (utcnow() - dt.timedelta(seconds=window_secs(cfg))).timestamp()
    candidates: list[dict] = []
    already_seen: dict[str, str] = {}
    messages_consumed = 0

    for ch in channels:
        cid = ch.get("id")
        if not cid:
            continue
        cname = ch.get("name")
        msgs = fetch_history(cid, oldest, token, warns)
        messages_consumed += len(msgs)
        for m in msgs:
            if m.get("subtype") in EXCLUDED_SUBTYPES:
                continue
            ts = m.get("ts")
            if not ts:
                continue
            row = conn.execute(
                "SELECT action FROM processed_messages "
                "WHERE slack_channel_id=? AND slack_message_ts=?",
                (cid, ts)).fetchone()
            if row:
                already_seen[f"{cid}:{ts}"] = row[0]
                continue
            permalink = get_permalink(cid, ts, token) or ""
            posted_iso = dt.datetime.fromtimestamp(
                float(ts), tz=dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
            enriched = enrich_message(m)
            user_name = ((m.get("user_profile") or {}).get("real_name")
                         or m.get("username")
                         or enriched.get("reporter_attribution"))
            candidates.append({
                "channel_id": cid, "channel_name": cname, "ts": ts,
                "thread_ts": m.get("thread_ts"), "subtype": m.get("subtype"),
                "bot_id": m.get("bot_id"), "user": m.get("user"),
                "user_name": user_name,
                "reporter_attribution": enriched.get("reporter_attribution"),
                "text": enriched["text"], "raw_text": m.get("text") or "",
                "had_attachments": enriched["had_attachments"],
                "had_blocks": enriched["had_blocks"], "permalink": permalink,
                "source_permalink": enriched.get("source_permalink"),
                "posted_iso": posted_iso, "files": enriched["files"]})
    emit({"ok": True, "channels_scanned": len(channels),
          "messages_consumed": messages_consumed,
          "candidates": candidates, "already_processed": already_seen,
          "warnings": warns, "window_secs": window_secs(cfg),
          "now": iso_ts(utcnow())})


# ----- ticketing subcommands -----

def cmd_ticket_context(_args: list[str]) -> None:
    cfg = load_config()
    provider = get_provider(cfg, load_secrets())
    conn = init_db()
    out = provider.context(conn, cfg)
    out["ok"] = True
    emit(out)


def cmd_ticket_search(args: list[str]) -> None:
    if not args:
        die("usage: ticket-search <query>")
    cfg = load_config()
    provider = get_provider(cfg, load_secrets())
    emit({"ok": True, "hits": provider.search(" ".join(args))})


def cmd_ticket_search_permalink(args: list[str]) -> None:
    if not args:
        die("usage: ticket-search-permalink <permalink>")
    cfg = load_config()
    provider = get_provider(cfg, load_secrets())
    result = provider.search_permalink(args[0])
    result["ok"] = True
    emit(result)


def cmd_ticket_create(_args: list[str]) -> None:
    body = read_stdin_json()
    cfg = load_config()
    provider = get_provider(cfg, load_secrets())
    conn = init_db()
    out = provider.create(conn, body, cfg)
    out["ok"] = True
    emit(out)


def cmd_ticket_link_slack(_args: list[str]) -> None:
    body = read_stdin_json()
    cfg = load_config()
    provider = get_provider(cfg, load_secrets())
    out = provider.link_slack(body)
    out["ok"] = True
    emit(out)


def cmd_attach_screenshots(_args: list[str]) -> None:
    body = read_stdin_json()
    cfg = load_config()
    secrets = load_secrets()
    provider = get_provider(cfg, secrets)
    slack_token = secrets.get("SLACK_BOT_TOKEN")
    if not slack_token:
        die("SLACK_BOT_TOKEN missing from secrets.json")
    out = provider.attach_screenshots(body, slack_token, cfg)
    out["ok"] = not out.get("errors")
    emit(out)


# ----- slack post subcommands -----

def _slack_post(payload: dict) -> None:
    if not payload.get("channel") or not payload.get("text"):
        die("missing channel/text")
    cfg = load_config()
    secrets = load_secrets()
    params = {"channel": payload["channel"],
              "text": _append_footer_to_slack(payload["text"], cfg)}
    if payload.get("ts"):
        params["thread_ts"] = payload["ts"]
    resp = slack_call("chat.postMessage", secrets["SLACK_BOT_TOKEN"], params,
                      post=True)
    if not resp.get("ok"):
        die(f"chat.postMessage: {resp.get('error')}")
    emit({"ok": True, "ts": resp.get("ts")})


def cmd_slack_reply(_args: list[str]) -> None:
    _slack_post(read_stdin_json())


def cmd_slack_post(_args: list[str]) -> None:
    p = read_stdin_json()
    p.pop("ts", None)
    _slack_post(p)


# ----- subcommand: resolve-summary-channel -----

def cmd_resolve_summary_channel(_args: list[str]) -> None:
    cfg = load_config()
    secrets = load_secrets()
    token = secrets.get("SLACK_BOT_TOKEN")
    summary = cfg.get("summary_channel") or {}
    cid = summary.get("id")
    if not cid:
        die("config.json summary_channel.id missing")
    info = slack_call("conversations.info", token, {"channel": cid})
    if info.get("ok"):
        ch = info.get("channel", {})
        if not ch.get("is_member") and not ch.get("is_private"):
            slack_call("conversations.join", token, {"channel": cid}, post=True)
    emit({"ok": True, "channel_id": cid, "name": summary.get("name")})


# ----- subcommand: record-decision -----

ALLOWED_ACTIONS = {"created", "skipped_duplicate",
                   "skipped_not_actionable", "skipped_bot_noise"}


def cmd_record_decision(_args: list[str]) -> None:
    d = read_stdin_json()
    for k in ("channel_id", "ts", "action"):
        if not d.get(k):
            die(f"missing field: {k}")
    if d["action"] not in ALLOWED_ACTIONS:
        die(f"action must be one of {sorted(ALLOWED_ACTIONS)}")
    conn = init_db()
    conn.execute(
        "INSERT OR REPLACE INTO processed_messages("
        "slack_channel_id, slack_message_ts, slack_permalink, "
        "ticket_id, ticket_url, action, reason, confidence, route_key"
        ") VALUES (?,?,?,?,?,?,?,?,?)",
        (d["channel_id"], d["ts"], d.get("permalink"),
         d.get("ticket_id") or d.get("linear_issue_id"),
         d.get("ticket_url") or d.get("linear_issue_url"),
         d["action"], (d.get("reason") or "")[:1000],
         d.get("confidence"), d.get("route_key") or d.get("team_key")))
    conn.commit()
    emit({"ok": True})


# ----- subcommand: finalize -----

def cmd_finalize(_args: list[str]) -> None:
    body = read_stdin_json()
    cfg = load_config()
    name = automation_name(cfg)
    now = utcnow()
    run_id = str(uuid.uuid4())
    run_ts = iso_ts(now)
    scanned = int(body.get("scanned") or 0)
    evaluated = int(body.get("evaluated") or 0)
    consumed = evaluated
    if "consumed" in body:
        consumed = int(body.get("consumed") or 0)
    created = int(body.get("created") or 0)
    dup = int(body.get("dup") or 0)
    na = int(body.get("na") or 0)
    tickets = body.get("tickets") or []
    errors = list(body.get("errors") or [])
    warns = list(body.get("warnings") or [])

    conn = init_db()
    try:
        conn.execute(
            "INSERT INTO run_metrics(run_id,started_at,channels_scanned,"
            "messages_evaluated,tickets_created,skipped_duplicate,"
            "skipped_not_actionable,errors) VALUES (?,?,?,?,?,?,?,?)",
            (run_id, run_ts, scanned, evaluated, created, dup, na, len(errors)))
        conn.commit()
    except Exception as e:  # noqa: BLE001
        errors.append(f"run_metrics insert: {e}")

    report_messages_consumed(run_id, consumed, warns)

    conn.execute("DELETE FROM processed_messages "
                 "WHERE created_at < datetime('now', '-14 days')")
    conn.execute("DELETE FROM run_metrics WHERE run_id NOT IN ("
                 "SELECT run_id FROM run_metrics ORDER BY started_at DESC LIMIT 30)")
    conn.commit()

    REPORTS.mkdir(parents=True, exist_ok=True)
    report_path = REPORTS / f"{now.strftime('%Y-%m-%d-%H-%M')}.md"
    lines = [f"# {name} Run - {run_ts}", "", "## Run summary",
             f"- Channels scanned: {scanned}",
             f"- Messages consumed: {consumed}",
             f"- Messages evaluated: {evaluated}",
             f"- Tickets created: {created}",
             f"- Skipped (dupes): {dup}",
             f"- Skipped (not actionable): {na}",
             f"- Errors: {len(errors)}", "", "## Tickets created"]
    if tickets:
        for t in tickets:
            lines.append(f"- **{t.get('title','')}** -> "
                         f"[{t.get('identifier','')}]({t.get('url','')}) "
                         f"— route: {t.get('route','')} "
                         f"— [source]({t.get('permalink','')})")
            if t.get("reason"):
                lines.append(f"  - Reasoning: {t['reason']} "
                             f"(confidence: {t.get('confidence','')})")
    else:
        lines.append("_None._")
    skipped = body.get("skipped") or []
    if skipped:
        lines += ["", "## Skipped details"]
        for s in skipped:
            lines.append(f"- [{s.get('reason_kind','')}] "
                         f"{s.get('permalink','(no permalink)')}: "
                         f"{s.get('reason','')}")
    lines += ["", "## Skipped counts", f"- Duplicates: {dup}",
              f"- Not actionable / bot noise: {na}", ""]
    if errors:
        lines.append("## Errors")
        lines += [f"- {e}" for e in errors]
    if warns:
        lines.append("## Warnings")
        lines += [f"- {w}" for w in warns]
    report_path.write_text("\n".join(lines) + "\n")

    notes = NOTES_PATH.read_text() if NOTES_PATH.exists() else ""
    if "## Run log" not in notes:
        notes += "\n## Run log\n"
    notes += (f"- {run_ts}: scanned={scanned} consumed={consumed} "
              f"evaluated={evaluated} created={created} dup={dup} "
              f"not_actionable={na} errors={len(errors)}\n")
    NOTES_PATH.write_text(notes)

    last_runs = conn.execute(
        "SELECT started_at, channels_scanned, messages_evaluated, "
        "tickets_created, skipped_duplicate, skipped_not_actionable, errors "
        "FROM run_metrics ORDER BY started_at DESC LIMIT 10").fetchall()
    recent_tickets = conn.execute(
        "SELECT created_at, slack_permalink, ticket_url, route_key, "
        "confidence, reason FROM processed_messages WHERE action='created' "
        "ORDER BY created_at DESC LIMIT 20").fetchall()
    skip_dist = conn.execute(
        "SELECT action, COUNT(*) FROM processed_messages "
        "WHERE created_at > datetime('now','-7 days') GROUP BY action").fetchall()
    channel_map_raw, _ = cache_get(conn, "channels")
    channels_cached = json.loads(channel_map_raw) if channel_map_raw else []

    write_visual(name, run_ts, scanned, evaluated, created, dup, na,
                 last_runs, recent_tickets, skip_dist,
                 channels_cached, tickets, errors, warns)

    emit({"ok": True, "run_id": run_id, "report": str(report_path),
          "visual": str(VISUAL_PATH)})


def write_visual(name, run_ts, scanned, evaluated, created, dup, na,
                 last_runs, recent_tickets, skip_dist,
                 channels_cached, tickets_this_run, errors, warns):
    def esc(x):
        return html.escape(str(x) if x is not None else "")

    last_runs_rows = "\n".join(
        f"<tr><td>{esc(r[0])}</td><td>{esc(r[1])}</td><td>{esc(r[2])}</td>"
        f"<td>{esc(r[3])}</td><td>{esc(r[4])}</td><td>{esc(r[5])}</td>"
        f"<td>{esc(r[6])}</td></tr>" for r in last_runs
    ) or '<tr><td colspan="7" class="empty">No runs recorded yet.</td></tr>'

    recent_tk_rows = "\n".join(
        f"<tr><td>{esc(r[0])}</td><td>{esc(r[3])}</td><td>{esc(r[4])}</td>"
        f"<td><a href=\"{esc(r[2])}\">ticket</a></td>"
        f"<td><a href=\"{esc(r[1])}\">source</a></td>"
        f"<td>{esc((r[5] or '')[:140])}</td></tr>" for r in recent_tickets
    ) or '<tr><td colspan="6" class="empty">No tickets filed yet.</td></tr>'

    skip_rows = "\n".join(
        f"<tr><td>{esc(a)}</td><td>{esc(c)}</td></tr>" for a, c in skip_dist
    ) or '<tr><td colspan="2" class="empty">No skips recorded yet.</td></tr>'

    channel_rows = "\n".join(
        f"<tr><td>#{esc(c.get('name'))}</td><td>{esc(c.get('id'))}</td></tr>"
        for c in channels_cached
    ) or '<tr><td colspan="2" class="empty">No channels cached.</td></tr>'

    err_rows = "\n".join(f"<tr><td>ERROR</td><td>{esc(e)}</td></tr>" for e in errors) + \
        "\n" + "\n".join(f"<tr><td>WARN</td><td>{esc(w)}</td></tr>" for w in warns)
    if not err_rows.strip():
        err_rows = '<tr><td colspan="2" class="empty">No errors or warnings.</td></tr>'

    this_run_rows = "\n".join(
        f"<tr><td>{esc(t.get('identifier'))}</td><td>{esc(t.get('title'))}</td>"
        f"<td>{esc(t.get('route'))}</td><td>{esc(t.get('confidence'))}</td>"
        f"<td><a href=\"{esc(t.get('url'))}\">link</a></td></tr>"
        for t in tickets_this_run
    ) or '<tr><td colspan="5" class="empty">No tickets created this run.</td></tr>'

    status_ok = len(errors) == 0
    status_cls = "ok" if status_ok else "err"
    status_label = "OK" if status_ok else "ERRORS"
    title = esc(name)

    html_out = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{title} - Dashboard</title>
<style>
:root {{ --bg:#0b0d10; --panel:#14181d; --panel2:#1a1f26; --border:#262d36;
  --text:#e6e8eb; --muted:#8a94a3; --accent:#EE6018; --ok:#4ade80; --err:#ff6b6b; --warn:#f0b429; }}
*{{box-sizing:border-box}} body{{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}}
.wrap{{max-width:1180px;margin:0 auto;padding:28px 24px 60px}}
h1{{font-size:22px;margin:0 0 4px}} h2{{font-size:14px;margin:24px 0 10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}}
.sub{{color:var(--muted);font-size:13px;margin-bottom:20px}}
.grid{{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}}
.card{{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:14px 16px}}
.card .label{{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}}
.card .value{{font-size:22px;font-weight:600;margin-top:4px}}
table{{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden;font-size:13px}}
th,td{{text-align:left;padding:9px 12px;border-bottom:1px solid var(--border)}}
th{{background:var(--panel2);color:var(--muted);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.05em}}
tr:last-child td{{border-bottom:none}} a{{color:var(--accent);text-decoration:none}} a:hover{{text-decoration:underline}}
.empty{{color:var(--muted);font-style:italic;text-align:center}}
.badge{{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}}
.badge.ok{{background:rgba(74,222,128,.15);color:var(--ok)}} .badge.err{{background:rgba(255,107,107,.15);color:var(--err)}}
</style></head><body><div class="wrap">
<h1>{title} - Dashboard <span class="badge {status_cls}">{status_label}</span></h1>
<div class="sub">Last run: {run_ts}</div>
<div class="grid">
  <div class="card"><div class="label">Channels scanned</div><div class="value">{scanned}</div></div>
  <div class="card"><div class="label">Messages evaluated</div><div class="value">{evaluated}</div></div>
  <div class="card"><div class="label">Tickets created</div><div class="value">{created}</div></div>
  <div class="card"><div class="label">Skipped (dupes)</div><div class="value">{dup}</div></div>
  <div class="card"><div class="label">Skipped (not actionable)</div><div class="value">{na}</div></div>
</div>
<h2>Tickets created this run</h2>
<table><thead><tr><th>ID</th><th>Title</th><th>Route</th><th>Conf.</th><th>Link</th></tr></thead><tbody>{this_run_rows}</tbody></table>
<h2>Recent runs</h2>
<table><thead><tr><th>Started (UTC)</th><th>Chan</th><th>Eval</th><th>Created</th><th>Dup</th><th>NA</th><th>Errors</th></tr></thead><tbody>{last_runs_rows}</tbody></table>
<h2>Recent tickets (last 20)</h2>
<table><thead><tr><th>Created</th><th>Route</th><th>Conf.</th><th>Ticket</th><th>Slack</th><th>Reason</th></tr></thead><tbody>{recent_tk_rows}</tbody></table>
<h2>Skip-reason distribution (7d)</h2>
<table><thead><tr><th>Action</th><th>Count</th></tr></thead><tbody>{skip_rows}</tbody></table>
<h2>Channel cache</h2>
<table><thead><tr><th>Channel</th><th>ID</th></tr></thead><tbody>{channel_rows}</tbody></table>
<h2>Errors / warnings this run</h2>
<table><thead><tr><th>Sev</th><th>Message</th></tr></thead><tbody>{err_rows}</tbody></table>
</div></body></html>
"""
    VISUAL_PATH.write_text(html_out)


# ----- dispatch -----

COMMANDS = {
    "discover":                 cmd_discover,
    "ticket-context":           cmd_ticket_context,
    "ticket-search":            cmd_ticket_search,
    "ticket-search-permalink":  cmd_ticket_search_permalink,
    "ticket-create":            cmd_ticket_create,
    "ticket-link-slack":        cmd_ticket_link_slack,
    "attach-screenshots":       cmd_attach_screenshots,
    "slack-reply":              cmd_slack_reply,
    "slack-post":               cmd_slack_post,
    "resolve-summary-channel":  cmd_resolve_summary_channel,
    "record-decision":          cmd_record_decision,
    "finalize":                 cmd_finalize,
}


def main(argv: list[str]) -> None:
    if len(argv) < 2 or argv[1] in {"-h", "--help", "help"}:
        sys.stdout.write(__doc__ or "")
        sys.exit(0 if len(argv) >= 2 else 2)
    cmd = argv[1]
    if cmd not in COMMANDS:
        die(f"unknown subcommand: {cmd}. Try --help.", code=2)
    try:
        COMMANDS[cmd](argv[2:])
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        die(f"unhandled: {e}\n{traceback.format_exc()}", code=1)


if __name__ == "__main__":
    main(sys.argv)
