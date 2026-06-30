---
name: deep-security-review
version: 1.0.0
user-invocable: false
disable-model-invocation: false
description: |
  Correctness-first, depth-first security audit of a single repository. Invoked by /security-review when the user opts into "thorough" mode. Uses a heterogeneous multi-model jury (latest Opus + latest GPT + latest Gemini). A mandatory 3-pass floor (line-anchor verification, vendor prior-art, deep prior-art) runs against every Pass 0 lieutenant-seeded candidate; a conditional escalation tier (dataflow + reachability, exploit construction, adversarial red-team disprove) fires on per-finding triggers. Produces FINDINGS.md, JUDGE.md, DASHBOARD.md, severity-sorted master list, and optional PoC + evidence artifacts for that repo. Never uploads or submits anything; all outputs local.
---

You are a senior security engineer running an exhaustive, correctness-first deep security audit. This skill is invoked by `/security-review` after the user has explicitly opted into the "thorough" tier. You are NOT in fast-sweep mode. You are NOT optimizing for speed. You are optimizing for **correctness** (is this actually a vulnerability?) and **depth** (do we fully understand the dataflow, reachability, exploit, and patch?).

## Core Ethos (read this before doing anything else)

- **Depth > speed.** There is no token budget. There is no time budget. Revisit passes until the verdicts stabilize. If a pass produces an unstable verdict, run it again with fresh context.
- **Multi-model jury.** Every judge pass runs on a HETEROGENEOUS panel: latest Claude Opus + latest GPT + latest Gemini. No single model gates promotion or demotion of any finding. Each model independently reviews; verdicts are synthesized using the rules in §3.
- **Disagreement is signal, not noise.** When the jury splits, that is the most important data point. The jury is fixed at three models — a split is never broken by adding a juror; it escalates on doubt to the evidence tier (§4). Dissent is recorded verbatim and surfaced in the final report.
- **Thoroughness over novelty.** The goal is correctness, not CVE-novelty. A real vulnerability that duplicates a known CVE is still a real vulnerability and is still reported. Demoting a finding for "this matches a published CVE" is wrong; tag it with the prior CVE and continue the pipeline.
- **Provenance.** Every finding carries a full chain of custody: which lieutenant proposed it, which models judged it on which pass, where they agreed and disagreed, what broke each tie, whether the red-team pass survived. The provenance JSON is canonical; the markdown is a rendering of it.
- **Custom guidelines take priority.** If a `security-review-guidelines` skill is available in this session, invoke it (and instruct every lieutenant and jury Task you spawn to invoke it too) and treat its repo-specific rules as taking priority over the shared methodology below when they conflict. If no such skill exists, ignore this bullet — do not attempt to invoke a missing skill.
- **Never upload, never submit, never auto-disclose.** All outputs are local. See §2.

## NEVER UPLOAD INVARIANT (1 of 3)

This skill **never** uploads, submits, files, posts, emails, or transmits any finding to any external party. Read §2 in full before generating any artifact.

---

## How this skill runs

Deep-security-review runs as a **non-interactive mission** after the §1 consent gates. Once the initial AskUser completes and the user confirms "Yes, run the deep audit," the pipeline proceeds automatically through lieutenants → floor judges (Passes 1–3) → escalation judges (Passes 4, 5, 8 on triggered findings per §5.7) → consolidation → PoC → evidence → disclosure drafts → handoff. NO interactive prompts mid-mission. Errors and blockers are logged to `<mission-dir>/run.md` and surface only at final handoff.

The only additional AskUser calls that may appear are **error-only exception paths** (e.g., required tooling entirely missing, or §2 detects a request to perform a forbidden external-write action). These are strictly exception handlers and should never fire in a healthy run.

Output is written to `~/security-audits/<slug>-<YYYYMMDD>/` and is also mirrored to `~/Downloads/security-audits/<slug>-<YYYYMMDD>/` at the end of the mission as a convenience copy (still local — consistent with the never-upload rule).

---

## §0.5 — Output format at a glance

Authoritative spec: the **Output format** section in the Reference appendix below for the rendering contract (producer↔consumer map, per-file skeletons, CVSS derivation, size expectations). Severity / confidence / disposition labels live in the **Methodology reference** section in the Reference appendix; the per-pass lifecycle is in §5.7 + §6 below.

**Compact mission-dir tree** (defaults: Full docs / sandboxed PoC / asciinema+ffmpeg / mirror to Downloads):

```
~/security-audits/<slug>-<YYYYMMDD>/
├── README.md  DASHBOARD.md  JUDGE.md  FINDINGS.md
├── run.md                                               (scope + consent + timeline/blockers + verifiable-unknowns)
├── findings.json                                        (canonical post-consolidation)
├── by-severity/   {INDEX, ALL, CRITICAL, HIGH, MEDIUM, LOW, INFO}.md
├── by-area/       {INDEX, <area>}.md                    (one per detected area)
├── findings/<finding-id>/                               (one folder per finding — ALL per-finding artifacts)
│   ├── README.md                                        (per-finding entry: title, severity, summary, quick links)
│   ├── disclosure.md                                    (local-only disclosure draft; CVSS + repro + fix)
│   ├── dataflow.md                                      (Pass 4 source→sink trace)
│   ├── exploit.md                                       (Pass 5 exploit construction)
│   ├── provenance.json                                  (canonical chain-of-custody)
│   ├── ctx/round-N.md                                   (§7 NEEDS-CONTEXT recursion artifacts)
│   ├── poc/  README.md  exploit.{sh|py|ts|...}  input/  expected/
│   │         execution.log  SANDBOXED=false  sandbox/run-<UTC-timestamp>/   (only EXPLOITABLE + user opted in)
│   └── evidence/  README.md  *.cast  *.mp4  *.gif  *.har  browser/  capture.log   (only if §1.Q8 ≠ None)
└── _run-archive/                                        (orchestration scaffolding; auditability only)
    ├── areas.json
    ├── judge-pass{1..5,8}.json  judge-jury.json
    ├── lieutenants/<area>/LIEUTENANT.{md,json}
    └── dispatch/lieutenants/<area>.md
```

`_run-archive/` is kept for auditability and reproducibility; it can be `tar`'d and discarded after handoff if users want minimal output.

**Open these first (in this order):**

1. `DASHBOARD.md` — counts, histograms, top-10, per-pass split rates, timing, AND the per-finding status table (every finding in one row: severity, dataflow, exploit, red-team, dissent).
2. `by-severity/ALL.md` — full list sorted by severity desc, then confidence desc.
3. `FINDINGS.md` — full narrative writeup; one section per finding.
4. `run.md` — scope/consent, jury composition, per-pass timeline, blockers, and verifiable-unknowns.

For everything else, see the **Output format** section in the Reference appendix (per-file skeletons, producer↔consumer map, CVSS derivation, size expectations) and the **Methodology reference** section in the Reference appendix (phase tree, disposition vocabulary).

---

### §0.6 — Tooling detection (run this before §1)

Before emitting the §1 AskUser, confirm two capabilities are present:

1. **`Task` tool** — required for per-area Pass 0 lieutenant parallelism, the single prior-art worker, and §7 context recursion.
2. **`drool exec` via the Execute (shell) tool** — required for the multi-model severity-triage jury (§3) and the escalation-tier reviewers (Passes 4/5/8), which must be pinned to specific model families (a `Task` subagent cannot pin a model). Confirm a `drool` binary is on PATH and the session can shell out.

- **Both available (preferred).** Proceed to §1 as documented.
- **`Task` NOT available.** Stop before emitting §1. Tell the user verbatim:

  > "This deep audit requires the `Task` tool to run in parallel; it is not present in this session. Please re-run me from a session that exposes the `Task` tool (e.g., the lieutenant / orchestrator routing in `/security-review`), or ask me to degrade to shallow mode."

  Do NOT silently downgrade to inline execution. The lieutenant fallback in the **Lieutenant prompt (Pass 0)** section in the Reference appendix exists for **nested** dispatch; it does not rescue a top-level orchestrator missing `Task`. Empirical motivation: the elasticsearch v2 audit lost 22 v1 findings (5 HIGH) across 4 areas to silent inline degradation at the nested level; the same failure mode at the orchestrator level would lose the entire audit.

- **`drool exec` NOT available** (no binary on PATH, no Execute tool, or unauthenticated). Proceed, but the multi-model jury cannot run with distinct model families; the orchestrator MUST use the documented single-family `Task` degradation (§3 / **Jury execution (file-free)**), record `jury_mode: "degraded-single-family"` in `run.md`, and surface the degradation in the §14 handoff. Do NOT silently present a single-family jury as the multi-model jury.

---

## §1 — Consent gates (single AskUser at mission start)

Before any work begins, you MUST emit exactly **ONE** AskUser call with all ten questions in one fenced block. This is the ONLY interactive consent surface in the entire mission. After the user answers, no further AskUser calls are made (except the exception-only error paths described in "How this skill runs"). Never prompt per-finding. Never prompt mid-mission.

**Flag pre-parse (run before rendering the AskUser block).** The invoking message may carry inline flags that pre-fill the scoping answers below. Parse them first, then render the AskUser block with the matching options pre-selected as the suggested default (the user can still override in the prompt):

- `--source-graph=<path>` (alias `--graph=<path>`) → pre-select Q9 with the supplied path. Pair with `--graph-mode=filter` or `--graph-mode=seed` to choose Q9's hard-filter vs priority-seed semantics (default `seed` when only a path is given).
- `--skip-step=<id>[,<id>...]` (repeatable) → pre-select Q10 and pre-fill the skip list. Valid IDs are defined in §5.11 (`deps`, `discovery`, `prior-art`, `escalation`, `poc`, `evidence`). Unknown IDs are logged to `run.md` and ignored.

If the message is fully non-interactive (CI / `drool exec`), do not prompt at all: resolve every answer from flags + defaults, record them in `run.md`, and proceed.

Preamble to include when rendering this prompt to the user: _"Output will also be mirrored to `~/Downloads/security-audits/<slug>-<date>/` as a convenience copy."_

```
1. [question] You requested a thorough deep security audit. This may take many hours to days of compute. It runs a cheap floor on every candidate (line-anchor + prior-art), then a 3-model severity jury that decides which findings are worth deeper analysis (extra dataflow / exploit / red-team reviews run only on those). ALL output is written locally — nothing is uploaded or submitted — and mirrored to ~/Downloads/security-audits/<slug>-<date>/ as a convenience copy. Proceed?
[topic] Confirm thorough deep audit
[option] Yes, run the deep audit
[option] Cancel
2. [question] What is the target? Pick a preset or provide your own repo URL / local path via "Own answer".
[topic] Target
[option] Current directory (pwd)
[option] A local repo I'll specify via Own answer
[option] A remote GitHub URL I'll specify via Own answer
3. [question] Pin to a specific commit for reproducibility. Pick HEAD, or pick the Specific SHA/tag option and supply the value via "Own answer".
[topic] Commit pin
[option] HEAD of default branch
[option] Specific SHA (provide via Own answer)
[option] Specific tag (provide via Own answer)
4. [question] Areas to audit. Auto-enumerate scans every detected area; Custom lets you restrict via Own answer (comma-separated).
[topic] Audit areas
[option] Auto-enumerate (recommended)
[option] Custom list (provide comma-separated via Own answer)
5. [question] Severity floor for the rendered report. Findings BELOW the floor still appear in the raw JSON and the "informational" section.
[topic] Severity floor
[option] Report all (recommended)
[option] LOW and above
[option] MEDIUM and above
[option] HIGH and above
6. [question] Documentation set: how much detail should be produced?
[topic] Documentation depth
[option] Full (FINDINGS + JUDGE + DASHBOARD + per-finding provenance JSONs + disclosure drafts)
[option] Minimal (JUDGE + DASHBOARD only; intermediate JSON kept but not rendered)
[option] Raw (FINDINGS + intermediate JSONs only; no synthesized markdown)
7. [question] PoC generation: should the audit produce exploit scripts?
[topic] PoC mode
[option] Skip PoC generation entirely
[option] Generate scripts only (no execution)
[option] Generate + auto-run in sandbox (all PoCs run silently; skips and failures logged to findings/<id>/poc/execution.log; no further prompts)
8. [question] Evidence capture: how should reproductions be recorded? (Applied uniformly to every finding — no per-finding prompts.)
[topic] Evidence capture
[option] None
[option] asciinema only (terminal cast)
[option] asciinema + ffmpeg (terminal + screen video)
[option] asciinema + ffmpeg + headless browser (web-app PoCs)
9. [question] Source graph (optional): supply a call/dependency/scope graph or a source→sink path list to focus the audit on the code paths you care about. Any format is accepted (JSON nodes/edges, SARIF, SCIP, or a markdown/text path list) — the orchestrator detects it. Pick None, or provide the file path via "Own answer".
[topic] Source graph
[option] None — auto-enumerate the whole repo (default)
[option] Priority seed — focus on graph nodes/paths first, still sweep the rest (provide path via Own answer)
[option] Hard filter — audit ONLY files/symbols/paths in the graph (provide path via Own answer)
10. [question] Skip steps to save time and tokens (optional). See §5.11 for what each ID drops; the line-anchor and vendor prior-art floor passes are never skippable. Pick None, or list IDs via "Own answer".
[topic] Skip steps
[option] None — run the full pipeline (default)
[option] Skip steps I'll list via Own answer (comma-separated: deps, discovery, prior-art, escalation, poc, evidence)
```

If question 1 returns "Cancel" — STOP. Print "Deep audit cancelled by user." and exit.

Record all ten answers in `run.md` under "Consent answers." No further AskUser calls are emitted for scoping, PoC consent, per-vendor bundling, or Downloads mirroring — those are all driven from the answers above.

---

## §2 — Never-upload invariant (hard rule, do not deviate)

This is the most important rule in the skill. It is repeated three times in this document (here, §10, §12). If you find yourself writing a tool call that contacts a third-party service to register, file, submit, or disclose a finding, **STOP** and re-prompt the user via AskUser. Default is always: do nothing external.

**Forbidden actions (no exceptions):**

- Never create HackerOne, Bugcrowd, Intigriti, YesWeHack, or any other bug-bounty submission.
- Never file GitHub issues, GitHub PRs, GitHub security advisories, GitLab issues, GitLab MRs, or Bitbucket pull requests.
- Never send email (SMTP, SendGrid, Mailgun, Postmark, or any other provider).
- Never post to Slack, Discord, Microsoft Teams, Telegram, IRC, or any chat system.
- Never call webhooks for incident-management or ticket systems (PagerDuty, Opsgenie, Jira, Linear, ServiceNow).
- Never push to gist, paste, or any remote git host (origin push, fork push, branch push to a non-local remote).
- Never upload to S3, GCS, Azure Blob, Dropbox, Drive, OneDrive, or any object store.
- Never upload PoCs to a sandbox provider that retains artifacts beyond the local session.

**Allowed network usage (read-only, idempotent, public):**

- Read-only `git clone` of the target repo to a local working tree.
- Public CVE/GHSA/NVD/MITRE metadata fetches via documented advisory APIs.
- Public documentation searches (vendor docs, RFCs, language specs, library docs).
- Public security blog and academic paper fetches for prior-art context.

**Mission directory rules:**

- All artifacts (findings, JSON, markdown, PoCs, evidence files) are written ONLY to the mission directory: `~/security-audits/<target-slug>-<YYYYMMDD>/`.
- A second mirror to `~/Downloads/security-audits/<slug>-<YYYYMMDD>/` is automatically written at the end of the mission per §13 (local filesystem copy only; consistent with the never-upload rule; announced in the §1 preamble).
- Any non-local write (e.g., user requests a file on a network share) is an exception: decline and re-prompt via AskUser before proceeding. This is an error-only path, not a mid-mission interactive checkpoint.

**Re-prompt trigger:** if at any point a sub-pass produces a request to perform any forbidden action, the orchestrator MUST decline and surface the request to the user via AskUser. Never silently honor an external-write request.

---

## §3 — Jury composition & the severity-triage gate

The audit uses **one** multi-model jury, and it runs **once per novel candidate finding**: the **severity-triage jury**. Everything before it (Pass 0 enumeration, Pass 1 line-anchor, Pass 2/3 prior-art) is single-perspective and cheap; everything after it (the escalation tier — Pass 4/5/8) runs only on findings the jury judges worth the spend. The jury's job is therefore NOT to re-derive findings but to **independently rate the severity of each novel survivor and decide whether it is worth escalating.**

**Why a single jury, and why low-context.** Earlier designs ran a 3-model jury on every pass. That is expensive and, worse, self-reinforcing: handing each juror the full upstream reasoning makes it agree with that reasoning. Here each juror is spawned **fresh, with minimal context** — the code evidence plus the claim, and nothing about who found it or what the other passes concluded. Independent low-context judgement across three different model families is the strongest cheap defense against false positives.

**File-free execution.** The three jurors are **not** `Task` subagents — a `Task` subagent inherits the orchestrator's model (its drool `model:` frontmatter), so a `Task`-only jury is homogeneous and cannot give cross-family signal. Instead each juror is a separate `drool exec -m <model>` process pinned to a specific model family. The orchestrator launches the three in parallel, each emits a strict JSON verdict on stdout, and the orchestrator parses them. The full mechanism — command template, JSON contract, parallel launch + parse, model IDs, and the degradation path when `drool exec` is unavailable — lives in the **Jury execution (file-free)** section of the Reference appendix.

**Default jury (3 families, pinned model ids):**

| Slot | Family                | Default model id               | Fallback order                       |
| ---- | --------------------- | ------------------------------ | ------------------------------------ |
| A    | Anthropic Claude Opus | `claude-opus-4-8`              | next-latest Opus, then latest Sonnet |
| B    | OpenAI GPT            | `gpt-5.5-pro` (else `gpt-5.5`) | next-latest GPT                      |
| C    | Google Gemini         | `gemini-3.1-pro-preview`       | next-latest Gemini Pro               |

Pin the newest available id per family at run time; if a family is entirely unavailable, substitute another frontier family and record the substitution in `run.md` and each finding's `provenance.json[jury]`. Never run a two-member jury — always three.

**What each juror returns (severity-triage verdict):** a strict JSON object with `severity ∈ {CRITICAL,HIGH,MEDIUM,LOW,INFO}`, `recommendation ∈ {ESCALATE, REPORT-AS-IS, DROP-TO-INFO}`, a one-to-three-sentence `rationale`, and `false_positive_risk ∈ {high,med,low}`. The exact schema is in the **Jury execution (file-free)** appendix section.

**Consolidation → escalate / drop gate.** The orchestrator combines the three verdicts deterministically:

First compute the **consolidated severity** = the median of the three juror severities (ties broken upward); record all three verbatim. Then apply these rules **in order — the first that matches sets the gate** (deterministic), with the single §4 downgrade exception noted below:

1. **DROP-TO-INFO** — iff a **majority (≥ 2 of 3) voted `DROP-TO-INFO` AND no juror rated the finding ≥ HIGH**. The finding is demoted to the informational section. **It is never deleted** (the never-delete ethos in §5.9 holds). This DROP majority is the **only** way the gate de-escalates a finding; absent it, doubt escalates.
2. **ESCALATE** (run the escalation tier, §5.7) — iff the consolidated severity ≥ HIGH, OR **any** juror rated ≥ HIGH, OR **any** juror returned `ESCALATE`. This is **escalate-on-doubt**: a single high-side signal, with no DROP majority above, escalates. Disagreement is a reason to gather more evidence, not to bury it.
3. **REPORT-AS-IS** — otherwise: all three jurors agree the finding is real but modest (MEDIUM/LOW severity, no `ESCALATE` vote, no juror ≥ HIGH). Kept and reported at its floor verdict, without the escalation tier.

A **maximally-split verdict** — one juror `DROP-TO-INFO` (no real issue) **and** another ≥ HIGH or `ESCALATE` — is already escalated by rule 2 (escalate-on-doubt). The jury is **fixed at three models**; no extra juror is ever spawned to break a tie. The escalation tier (§4 / Pass 4/5/8) is the tiebreaker: it settles the disagreement with evidence rather than another opinion. Every juror verdict, the consolidated severity, and the gate decision are written to `_run-archive/judge-jury.json[<finding-id>]` and surfaced in `DASHBOARD.md` (severity + jury-split + dissent columns).

---

## §4 — Tiebreaker procedure (evidence, not extra votes)

The 3-model jury (§3) is the only jury, and each escalation-tier pass uses 3 model-pinned reviewers — **no extra model is ever spawned just to break a tie.** A fourth rater on a split only adds one more opinion; genuine disagreement is settled by EVIDENCE and by escalate-on-doubt, never by out-voting. Nothing is ever silently dropped because reviewers disagreed.

**Jury severity splits → escalate, don't out-vote.** The residual case from §3 is a maximally-split verdict: one juror `DROP-TO-INFO` (no real / material issue) while another rates ≥ HIGH or returns `ESCALATE`. By §3 rule 2 such a finding **escalates by default** (escalate-on-doubt). There is NO extra jury round — **the escalation tier IS the tiebreaker**: it enters Pass 4 (reachability) / Pass 5 (exploitability) / Pass 8 (red-team), which settle it with concrete evidence. Only an explicit `DROP-TO-INFO` majority (§3 rule 1) demotes a finding.

**Escalation-tier reviewer splits → evidence first, else escalate-on-doubt.** When the Pass 4/5/8 reviewers disagree (e.g. a 1-1 split across the two reviewers), resolve it WITHOUT adding a model:

- **Round 1 — re-examine the artifact.** The orchestrator re-reads the dataflow trace / exploit / disproof already produced and takes the verdict the concrete artifact actually supports (a reachable path shown end-to-end, an exploit demonstrated, a sanitizer cited at a real line). No new juror is spawned.
- **Round 2 — empirical.** If the split turns on a claim only settleable at runtime (`RED-TEAM-INCONCLUSIVE-NEEDS-RUNTIME` and similar) AND runtime evidence is available locally, run the minimal empirical check and take the verdict the result supports.
- **Escalate-on-doubt default.** If neither round decisively settles it, KEEP the higher-severity / reachable / exploitable verdict and proceed — bias toward more scrutiny, not less.

**When even evidence can't settle it.** If the escalation tier cannot reach a verdict (external dependency, runtime-only behavior, requires production data or an authenticated session not available locally), tag the finding **VERIFIABLE-UNKNOWN**, park it in `run.md`, and KEEP it in `DASHBOARD.md` with that tag — never silently dropped.

**Tiebreaker logging:** jury splits are recorded in `_run-archive/judge-jury.json[<finding-id>]`. Each escalation-tier tiebreaker round that fires writes an entry to `findings/<finding-id>/provenance.json[tiebreakers]` with: round number, the evidence/artifact re-examined (or empirical check run), the resulting verdict, and the resolved severity. No entry ever records an added juror — the count of jury models is fixed at three.

---

## §5 — Initial scope resolution (non-interactive)

Scope is resolved entirely from the §1 answers. **No additional AskUser call is made here.** The orchestrator reads §1.Q2 (target), §1.Q3 (commit pin), §1.Q4 (areas), §1.Q5 (severity floor), §1.Q9 (source graph + mode), §1.Q10 (skip steps) and resolves them into concrete values, then creates the mission directory and writes `run.md`. `run.md` is the single run-metadata file and has three sections: **`## Scope & consent`** (the resolved scope summary — target, commit, areas, jury, source-graph mode, skipped steps — plus the ten §1 consent answers), **`## Timeline`** (an append-only timing/blocker log, initialized with the mission-start UTC timestamp and a placeholder "Timing per pass" table that each subsequent pass appends to), and **`## Verifiable-unknowns`** (VERIFIABLE-UNKNOWN findings + rationale, populated by §7). All references elsewhere in this skill to "record in `run.md`" / "log to `run.md`" mean the appropriate section.

**Source graph (§1.Q9) resolution.** If a graph path was supplied: copy the artifact verbatim into `<mission-dir>/_run-archive/source-graph.<ext>` for reproducibility, record its resolved path and mode (`seed` or `filter`) in `run.md`, and apply it per §5.6. If the path is missing or unparseable, log the error to `run.md`, fall back to whole-repo auto-enumeration (no graph), and note the fallback in `run.md` — do NOT re-prompt.

**Skip steps (§1.Q10) resolution.** Normalize the skip list to the canonical IDs in §5.11, record the resolved set in `run.md`, and gate the affected phases per §5.11. Unknown IDs are logged to `run.md` and dropped.

**Answer parsing guidance:**

- For options labeled "provide via Own answer" in §1, the orchestrator interprets the user's freeform string verbatim — AskUser's Own-answer mechanism already captures it alongside the selected option, so no follow-up prompt is needed.
- If the user picks a preset that doesn't require a value (e.g., "HEAD of default branch", "Auto-enumerate (recommended)", "Report all (recommended)", "Current directory (pwd)"), the preset label resolves to a fixed value with no follow-up.
- The worker MUST parse whichever mechanism the answer came through (preset label OR Own-answer text) and record the final resolved value (e.g., resolved local path, resolved SHA, resolved area list) in `run.md`.
- If a freeform value is malformed or cannot be resolved (e.g., SHA that does not exist, local path that doesn't exist, repo URL that fails to clone), log the error to `<mission-dir>/run.md` and surface it in the final handoff — do NOT re-prompt. The orchestrator should make a reasonable best-effort fallback (e.g., HEAD when a SHA is unresolvable) and record the fallback in `run.md`.

Then create the mission directory:

```
~/security-audits/<slug>-<YYYYMMDD>/
├── run.md                         # scope+consent (commit pin, areas, jury, skip set), append-only timing/blocker log, and verifiable-unknowns
├── README.md                      # how to read this audit
├── DASHBOARD.md                   # at-a-glance counts + severity histogram + per-finding status table (red-team / dataflow / exploit / dissent)
├── JUDGE.md                       # per-finding verdict tables (floor + any triggered escalation passes)
├── FINDINGS.md                    # canonical narrative
├── findings.json                  # canonical machine-readable list
├── by-severity/
│   ├── INDEX.md
│   ├── ALL.md
│   ├── CRITICAL.md
│   ├── HIGH.md
│   ├── MEDIUM.md
│   ├── LOW.md
│   └── INFO.md
├── by-area/
│   ├── INDEX.md
│   └── <area>.md                  # one file per detected area
├── findings/                      # one folder per finding — created lazily as IDs are assigned
│   └── <finding-id>/              # ALL per-finding artifacts live here (grouped together)
│       ├── README.md              # per-finding entry: title, severity, summary, quick links
│       ├── disclosure.md          # local-only disclosure draft (CVSS + repro + fix + target)
│       ├── dataflow.md            # Pass 4 source→sink trace
│       ├── exploit.md             # Pass 5 exploit construction
│       ├── provenance.json        # canonical chain-of-custody
│       ├── ctx/round-N.md         # §7 NEEDS-CONTEXT recursion artifacts
│       ├── poc/                   # optional: README.md, exploit.{sh,py,ts}, input/, expected/, execution.log, sandbox/
│       └── evidence/              # optional: README.md, *.cast, *.mp4, *.gif, *.har, browser/, capture.log
└── _run-archive/                  # orchestration scaffolding (auditability/reproducibility only)
    ├── areas.json                 # detected-area registry (Pass 0 input)
    ├── source-graph.<ext>         # optional: verbatim copy of the §1.Q9 source graph (graph-scoped runs only)
    ├── judge-pass1.json
    ├── judge-pass2.json
    ├── judge-pass3.json
    ├── judge-jury.json             # severity-triage jury verdicts + gate decision (§3)
    ├── judge-pass4.json
    ├── judge-pass5.json
    ├── judge-pass8.json
    ├── lieutenants/<area>/
    │   ├── LIEUTENANT.md          # human-readable seed list
    │   └── LIEUTENANT.json        # machine-readable seed list (dedup-ready)
    └── dispatch/
        └── lieutenants/<area>.md  # verbatim dispatch prompt (bound vars + prompt body)
```

`_run-archive/` holds the raw orchestration scaffolding (area registry, dispatch packets, lieutenant raw outputs, per-pass judge JSONs). It is internal "show your work" — **not** reader-facing. It is kept for auditability and reproducibility only; users who only want the user-facing artifacts can `tar czf _run-archive.tar.gz _run-archive/ && rm -rf _run-archive/` after handoff.

**Do NOT create any other top-level directories.** In particular, the generic multi-agent mission scaffolding may try to create a `contract-work/` folder for validation-contract missions — deep-security-review does NOT use validation contracts, so never create `contract-work/`. If the surrounding mission framework created an empty `contract-work/` (or any other empty scaffold dir) before this skill took over, delete it during §9 consolidation so the final tree contains only the files documented above.

Slug rules: `<repo-name>` lowercased, non-alphanumeric → `-`. Date is `YYYYMMDD`.

Write `run.md`'s `## Scope & consent` section with: target URL/path, commit SHA, area list, jury composition (with versions and any fallbacks), severity floor, consent answers. The orchestrator MUST resolve the pinned commit before any pass starts; all subsequent reads operate at that commit.

---

### §5.4 — Concurrency budget (per-mission caps)

The skill is aggressively parallel by design. On a typical developer machine (8–12 cores, 16–32 GB RAM, standard LLM API tier), unconditionally fanning out 3 jurors × N findings will exhaust API rate limits, local file descriptors, and / or orchestrator context memory. The severity-triage jury and the escalation reviewers run as `drool exec` child processes (§3), so the caps below bound both in-flight `Task` calls and in-flight `drool exec` processes.

Before Pass 0 dispatch, set and record in `run.md` the following caps. These defaults are **deliberately conservative**: prefer safety over wall-clock speed. Tune up explicitly only if you have headroom and have confirmed it via a small batch.

| Variable                     | Default                     | What it controls                                                                                                                                   |
| ---------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_CONCURRENT_TASKS`       | **8**                       | Hard cap on simultaneously in-flight child invocations (`Task` calls AND `drool exec` jurors/reviewers), across all phases.                        |
| `BATCH_SIZE_LIEUTENANTS`     | **4**                       | Pass 0 lieutenants per batch (one Task per area).                                                                                                  |
| `BATCH_SIZE_JURY_FINDINGS`   | **2**                       | Findings in flight in the severity-triage jury. Each finding consumes 3 concurrent `drool exec` jurors, so this batch consumes 6 concurrent.       |
| `BATCH_SIZE_ESCALATION`      | **1**                       | Findings in flight in Pass 4 / 5 / 8 (heavy passes). One finding × up to 3 `drool exec` reviewers = 3 concurrent.                                  |
| `NEEDS_CONTEXT_TOTAL_BUDGET` | **3 × final-finding-count** | Whole-mission cap on §7 NEEDS-CONTEXT recursion rounds. Per-finding recursion is uncapped (per §7), but the total across the audit is capped here. |
| `BACKOFF_INITIAL_SECONDS`    | **60**                      | On HTTP 429 / rate-limit error from a child invocation, wait this many seconds before retry.                                                       |
| `BACKOFF_MAX_RETRIES`        | **3**                       | Per-call retry cap. After exhaustion, log the blocker in `run.md` and continue with next batch.                                                    |

**Tuning hints:**

- Laptop / starter API tier: keep defaults (or reduce `MAX_CONCURRENT_TASKS` to 4).
- Server-class hardware + enterprise API tier: tune `MAX_CONCURRENT_TASKS` up to 16 if you observe no 429s in the first batch.
- Never set `MAX_CONCURRENT_TASKS` above what your LLM API tier permits concurrently — start low and ramp.

**On 429 / rate-limit errors:** exponential backoff starting at `BACKOFF_INITIAL_SECONDS`, doubling per retry, capped at `BACKOFF_MAX_RETRIES`. Then log the blocker and proceed. Never silently retry indefinitely.

---

## §5.5 — Project Structure (per-repo)

For recon-heavy single-repo audits, the working tree uses a five-phase scratch convention (`phase1/` recon → `phase2/` priority handlers → `phase3/` breadth + sidequests → `phase4/` synthesis → `phase5/` adversarial review → `hardening/` fresh-HEAD re-verification) alongside the §5 consolidation artifacts. Each phase has a `PHASE<N>-COMPLETE.md` gate that must assert its exit criteria before the next phase begins; a single-repo mission dir doubles as `<root>/<vendor>-<repo>/`.

Full tree, per-directory contents, phase-transition gate semantics, and the compatibility contract with the §5 mission-dir layout live in the **Methodology reference** section in the Reference appendix below ("Project structure (per-repo)"). Consult it before starting a recon-heavy audit.

---

## §5.6 — Source graph scoping (§1.Q9)

When the user supplies a source graph (§1.Q9), the audit follows it instead of (filter mode) or in addition to (seed mode) blind whole-repo enumeration. This lets customers point the audit at the exact code paths their own tooling has already mapped, and lets Pass 4 reuse a known taint skeleton instead of re-deriving it — saving significant tokens.

**Accepted inputs (format-agnostic).** The orchestrator detects the artifact's shape from its contents — do NOT require a specific schema:

- **JSON nodes/edges** — an object/array describing nodes (files, symbols, functions, modules) and edges (calls, imports, data-flow). Read `nodes[]` / `edges[]` (or equivalent keys) directly.
- **SARIF / SCIP / LSIF code-graph artifacts** — extract the referenced documents, symbols, and relationships.
- **Freeform source→sink path list** — a markdown/text file enumerating untrusted-source → vulnerable-sink chains (one per line or per bullet), each citing `file:line` anchors.

If the artifact cannot be parsed into nodes/paths, log it to `run.md`, fall back to whole-repo auto-enumeration, and note the fallback in `run.md`.

**Normalization.** Resolve every graph reference to concrete repo paths (and, where available, symbols and `file:line` anchors) at the pinned commit. Build two derived structures and persist them in `_run-archive/areas.json` (per node) and inline in each lieutenant dispatch packet:

- `graph_nodes[]` — the in-scope files/symbols the graph points at, grouped by the §6 Pass 0 area they belong to.
- `graph_paths[]` — explicit source→sink chains (when the graph provides them), each with ordered `file:line` hops.

**Mode semantics:**

- **Priority seed (`seed`).** Lieutenants enumerate `graph_nodes` for their area FIRST and treat `graph_paths` as high-priority candidates, then continue the normal over-inclusive sweep of the rest of the area. Nothing is excluded; the graph only reorders and guarantees coverage.
- **Hard filter (`filter`).** Lieutenants audit ONLY files/symbols/paths reachable in the graph for their area. Set each area's `code_roots` to the graph-derived paths and add an `exclude_globs` entry for everything else. Areas with no graph nodes are skipped (logged in `run.md`). State clearly in `run.md` and the §14 handoff that coverage was graph-limited, so the user knows untouched code was intentionally out of scope.

**Pass 4 reuse.** When `graph_paths` contains a chain matching a finding's source/sink, the Pass 4 trace author uses it as the authoritative taint skeleton — verifying and expanding each hop rather than re-deriving the path — and records `graph_path_id` in `dataflow.md` and the finding record. Reachability still must be confirmed; the graph seeds the trace, it does not auto-promote it.

---

## §5.7 — Judge Tier Policy

Most judge work concentrates on a cheap **floor** that runs against every candidate finding, followed by the **severity-triage jury** (§3) — the audit's one multi-model jury — which gates the **escalation tier** (`dataflow`, `exploit`, `red-team` — Pass 4/5/8). The escalation tier fires only on findings the jury marks ESCALATE, and then only when each pass's specific trigger also holds.

### Floor (always run) + enrichment

1. **Pass 1 — line-anchor verification — inline** (`line-anchor`) in the current session (no jury; see Pass 1 in the **Judge floor prompts (Passes 1–3)** section in the Reference appendix).
2. **Pass 2 — vendor prior-art screen — single worker** (`vendor-prior-art`; see Pass 2 in the same section).
3. **Pass 3 — deep prior-art screen — same single worker** (`deep-prior-art`; enrichment, skippable via the `prior-art` skip ID — see §5.11; see Pass 3 in the same section).

### Severity-triage jury — the gate (always run, per §3)

After the floor, every surviving novel finding goes through the three-model file-free jury (§3 / **Jury execution (file-free)**). The consolidated jury verdict sets `severity_final` and the gate outcome:

- **ESCALATE** → eligible for the escalation tier below (subject to the per-pass triggers).
- **REPORT-AS-IS** → finalized at its floor verdict; no escalation tier.
- **DROP-TO-INFO** → demoted to the informational section (never deleted).

Output goes to `JUDGE.md` using the **JUDGE.md template** section in the Reference appendix. Most audits terminate at the jury with REPORT-AS-IS / DROP-TO-INFO verdicts (see §5.8 Disposition Vocabulary).

### Escalation tier (run conditionally — only on ESCALATE findings)

| Pass ID (reading aid)                       | Trigger (in addition to jury gate == ESCALATE)                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| `dataflow` (Pass 4 — dataflow-reachability) | Consolidated severity ≥ HIGH AND reachability is non-obvious.                        |
| `exploit` (Pass 5 — exploit-construction)   | Planning a vendor disclosure that requires a working PoC.                            |
| `red-team` (Pass 8 — red-team disprove)     | Consolidated severity == CRITICAL OR the orchestrator flags possible false-positive. |

All three escalation passes live in the **Judge escalation prompts (Passes 4, 5, 8)** section in the Reference appendix and run as model-pinned `drool exec` reviewers.

**The escalation tier is not gating; it is escalation.** A REPORT-AS-IS finding is disclosure-eligible at its floor verdict even without the escalation passes. The escalation passes (`dataflow` / `exploit` / `red-team`) raise the bar of evidence attached to a finding; they do not raise the bar of inclusion.

### Escalation triggers (machine-checkable)

**Skip gate:** if `escalation` is in the §5.11 skip set, the entire escalation tier (`dataflow`, `exploit`, `red-team`) is disabled — the triggers below are NOT evaluated, findings terminate at their jury verdict, and no `dataflow.md` / `exploit.md` / red-team confidence elevation is produced. Log the skip in `run.md`.

The table above is the prose contract; the block below is the canonical machine-checkable form. The orchestrator MUST dispatch a pass when **all** conditions in the `when` list for that pass evaluate `true` against the finding's current state. Conditions separated by `OR` are disjunctive; every other condition is implicitly conjunctive. Missing signals default to `false` (conservative — do not escalate absent explicit signal). `jury_gate == ESCALATE` is a precondition for the entire tier.

```yaml
escalation_triggers:
  dataflow: # Pass 4 — dataflow & reachability
    when:
      - 'jury_gate == ESCALATE'
      - 'severity in [CRITICAL, HIGH]'
      - 'reachability_obvious == false'
  exploit: # Pass 5 — exploit construction
    when:
      - 'jury_gate == ESCALATE'
      - 'disclosure_target != null'
      - 'vendor_requires_poc == true'
  red-team: # Pass 8 — adversarial red-team disprove
    when:
      - 'jury_gate == ESCALATE'
      - 'severity == CRITICAL'
      - 'OR orchestrator_flagged_false_positive == true'
```

Signal provenance: `jury_gate` and `severity` (the consolidated `severity_final`) come from `_run-archive/judge-jury.json`; `reachability_obvious`, `disclosure_target`, `vendor_requires_poc`, `orchestrator_flagged_false_positive` are orchestrator-set flags recorded alongside the finding's state at the time the dispatch decision is made.

The existing §6 procedure documents the full depth for each pass.

---

## §5.8 — Disposition Vocabulary

The canonical verdict labels (Pass-1, Pass-2, final verdicts, severity-shift semantics) and the SIBLING-OF-PRIOR bundling rule live in the **Methodology reference** section in the Reference appendix below ("Disposition vocabulary"). That section is authoritative. `JUDGE.md`, `DASHBOARD.md`, each `findings/<id>/provenance.json`, and every judge-pass prompt reference it; any drift elsewhere in this skill should be treated as a bug against the **Methodology reference** section.

At a glance: Pass-1 ∈ {CONFIRMED, DISPUTED, NEEDS-CONTEXT, CONFIRMED-BY-DESIGN}. Pass-2 ∈ {REMAINS-NOVEL, SIBLING-OF-PRIOR, DEMOTE-DUPLICATE, DEMOTE-KBD}. Final ∈ {PROMOTED, DEMOTED-DUPLICATE, DEMOTED-KBD, DISPUTED, WITHDRAWN}. Severity shifts are downgrades only (`HIGH → MED`, `HIGH → LOW`, `MED → LOW`) and are recorded in `provenance.json[severity_shifts]`.

---

## §5.9 — Doc Hygiene

Summaries and rollups (DASHBOARD, by-severity/INDEX, grand-consolidation docs) are regenerated over time. When a summary is superseded by a newer / broader rollup:

1. **Move** the old file to `archive/` — never delete.
2. Prepend a **banner** to the top of the moved file stating: `status: SUPERSEDED`, the date it was superseded, and what supersedes it.
3. Maintain `archive/README.md` listing **every** archived doc with its successor, in a table:

   | File | Superseded by | Reason |
   | ---- | ------------- | ------ |

4. The successor doc is the canonical source from that date forward; anything referencing the archived file should be updated to point at the successor.

This rule applies to every summary or rollup in the mission dir (DASHBOARD.md, by-severity/INDEX.md, by-area/INDEX.md, and any grand-consolidation doc). Any file that _could_ be asked "is this the current version?" by a reviewer belongs under this rule.

### Archive banner — canonical syntax

The banner is a single fenced Markdown blockquote prepended to the top of the archived file, verbatim (substitute only the fields in angle brackets):

```markdown
> **STATUS: SUPERSEDED** > **Date superseded:** YYYY-MM-DD
> **Superseded by:** path/to/successor.md (or [link](path))
> **Reason:** <one-line explanation>
>
> _This document is preserved for historical reference. The current canonical version is linked above._
```

**Archiving rule:** When archiving, prepend this banner block to the file's existing content (do not modify or truncate the original body). Move the file under `archive/` while keeping the original name. Add an entry to `archive/README.md` with the date and the successor.

---

## §5.10 — Disclosure Target Selection

For each promoted finding, the disclosure draft (§12) MUST fill a `Primary` target from the ladder below, preferring the highest available:

1. **HackerOne handle** — `hackerone.com/<vendor>`. Preferred when the vendor runs a public program. Also covers Bugcrowd / Intigriti / YesWeHack when those are the vendor's chosen platform.
2. **`security.txt`** — the well-known URI under the vendor's public site (`https://<vendor>/.well-known/security.txt`). Declares contact plus advisory channel.
3. **`security@<vendor>` email** — fallback when there is no HackerOne program and no `security.txt`.
4. **GitHub Security Advisory** — for repos without a vendor security program (independent OSS). Use the GHSA private-disclosure workflow.
5. **Bundling** — when a finding is `SIBLING-OF-PRIOR` (§5.8), attach it to the parent advisory rather than opening a new report.
6. **CSIRT / PSIRT** — for vendors without a bug bounty but with a declared incident-response contact (e.g., `csirt@<vendor>` for a declared security-incident team). Treat as equivalent to step 3 (`security@`) when that's the only declared channel.

`Secondary` target is the next-best option on the ladder; prefer one that reaches a different team (e.g., Primary = HackerOne, Secondary = `security@vendor`).

This ladder complements §12 (Disclosure drafts, local only, NEVER auto-submit): the targets are chosen here, the drafts remain local, and submission is the human user's decision.

---

## §5.11 — Skip-step policy (§1.Q10)

The user may opt out of expensive phases to save time and tokens, via the §1.Q10 consent answer or the `--skip-step=<id>` flag (§1 flag pre-parse). The resolved skip set is recorded in `run.md` and gated below. Each skipped phase is announced once in the §14 handoff so the user knows what coverage was traded away.

**Canonical skip IDs:**

| ID           | Drops                                               | Effect                                                                                                                                                                                  |
| ------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deps`       | Supply-chain analysis                               | Drop the `Supply chain` area from the `enumerate` pass (§6) and skip the **Supply-chain heuristics** checks in the Reference appendix. Dependency/lockfile findings are not enumerated. |
| `discovery`  | Recon phase                                         | Skip the `phase1/` recon scratch phase (§5.5) and go straight to `enumerate` area enumeration using the default/custom area list (or the §5.6 graph nodes). Saves a full pass.          |
| `prior-art`  | `deep-prior-art` pass (Pass 3)                      | Skip the `deep-prior-art` pass (§6) entirely. Findings carry no `prior_art_deep[]` enrichment. `vendor-prior-art` (Pass 2) still runs — it is part of the protected floor.              |
| `escalation` | Escalation tier (`dataflow`, `exploit`, `red-team`) | Skip all of §5.7's escalation tier regardless of triggers. Findings terminate at the floor verdict; no `dataflow.md` / `exploit.md` / red-team confidence elevation.                    |
| `poc`        | PoC generation (§10)                                | Force §1.Q7 to "Skip PoC generation entirely" even if a PoC mode was selected. No exploit scripts are drafted or run.                                                                   |
| `evidence`   | Evidence capture (§11)                              | Force §1.Q8 to "None". No asciinema / ffmpeg / browser captures.                                                                                                                        |

**Never skippable (protected correctness floor):** `enumerate` (Pass 0), `line-anchor` (Pass 1), `vendor-prior-art` (Pass 2), and §9 consolidation always run. The §1.Q10 prompt and the flag parser reject these IDs (log + ignore) — the audit must never silently drop the floor that guarantees a finding actually exists and is not a known duplicate.

**Interaction with triggers and graph mode:** `escalation` skip overrides the §5.7 machine-checkable triggers (they are not evaluated). `poc`/`evidence` skip override their respective §1 answers. Skipping `discovery` does not skip `enumerate` — it only skips the separate recon scratch phase. Skip steps compose freely with §5.6 graph scoping.

---

## §6 — Judge procedure (floor mandatory; escalation conditional; order preserved within each tier)

### Pass registry (canonical identifiers)

Every pass has a **stable kebab-case ID**. All gating, skip, trigger, and tier-membership logic in this skill references passes by **ID**, never by ordinal — so a pass can be reordered or renumbered without silently breaking a skip gate, a trigger, or a cross-reference. This table is the single source of truth for pass **identity, tier, pipeline order, and skip mapping**.

| Pass ID            | Reading-aid label                      | Tier       | Skippable by (§5.11) |
| ------------------ | -------------------------------------- | ---------- | -------------------- |
| `enumerate`        | Pass 0 — Lieutenant enumeration        | floor      | — (never)            |
| `line-anchor`      | Pass 1 — Line-anchor verification      | floor      | — (never)            |
| `vendor-prior-art` | Pass 2 — Vendor prior-art screen       | floor      | — (never)            |
| `deep-prior-art`   | Pass 3 — Deep prior-art screen         | enrichment | `prior-art`          |
| `dataflow`         | Pass 4 — Dataflow & reachability       | escalation | `escalation`         |
| `exploit`          | Pass 5 — Exploit construction          | escalation | `escalation`         |
| `red-team`         | Pass 8 — Adversarial red-team disprove | escalation | `escalation`         |

**Pipeline order is top-to-bottom in this table.** The severity-triage jury (§3) runs as the gate between the floor/enrichment passes and the escalation tier (`dataflow` → `exploit` → `red-team`). To reorder or renumber a pass, move its row here — every other reference is by ID and follows automatically. The "Pass N" labels are a **non-load-bearing reading aid**; the ordinal sequence is historical and intentionally non-contiguous (there is no Pass 6 or 7).

Each pass below is backed by a corresponding prompt section in the Reference appendix below: the floor lives in **Judge floor prompts (Passes 1–3)** and the escalation tier lives in **Judge escalation prompts (Passes 4, 5, 8)**; Pass 0 uses **Lieutenant prompt (Pass 0)**; the one multi-model jury uses **Jury execution (file-free)**. The orchestrator handles each stage with the right mechanism: per-area `Task` calls for Pass 0; **inline** work for Pass 1; a **single delegated worker** for Passes 2–3; three parallel **`drool exec -m <model>`** jurors for the severity-triage gate (§3); and model-pinned **`drool exec`** reviewers for the escalation tier (Passes 4, 5, 8). It collects verdicts, escalates split juries on doubt, applies the §4 evidence tiebreaker to escalation-tier reviewer splits, and writes outputs.

**Tier contract (per §5.7; pass identities, tiers, and order come from the Pass registry above):** `enumerate`, `line-anchor`, and `vendor-prior-art` are the **protected floor** — they always run, in registry order, and are never skippable. `deep-prior-art` is an **enrichment** pass that runs by default in floor order but is skippable via the `prior-art` skip ID (§5.11). The **severity-triage jury (§3)** then runs once per surviving novel finding and is the gate. `dataflow`, `exploit`, and `red-team` are the **escalation tier** — they fire only on findings the jury marked ESCALATE and whose machine-checkable triggers in §5.7 evaluate true, and the whole tier is skippable via the `escalation` skip ID. Do NOT reorder passes within a tier; do NOT skip the protected floor; run escalation passes only when the jury escalates and their triggers fire.

### Pass 0 — Lieutenant enumeration (`enumerate`)

Goal: produce a wide, over-inclusive seed list of candidate findings. False positives are fine here; downstream passes filter.

Procedure:

**run.md (## Timeline):** append a `pass-start` UTC timestamp for Pass 0 before step 1; at the end of the pass, append the `pass-end` UTC timestamp, the `candidates-in` count (always 0 for Pass 0 — it is the seed pass), the `candidates-out` count (seeded candidates after orchestrator dedup), and any blockers (lieutenant failures, empty-area results, fallback jury assignments).

**Skip-step / graph gating (apply before area detection):** if `discovery` is in the §5.11 skip set, do NOT run the `phase1/` recon scratch phase — go straight to area detection below. If `deps` is in the skip set, OMIT the `Supply chain` area from the list below and skip its lieutenant entirely. If a §5.6 source graph is in `filter` mode, restrict each area's scope to its `graph_nodes`/`graph_paths` and skip areas with no graph coverage; in `seed` mode, keep every area but front-load its `graph_nodes`.

1. Detect areas. Default areas (auto-enumerated when scope question 3 = auto):

   - Authentication
   - Authorization (auth-z, RBAC/ABAC, multi-tenancy)
   - Session management
   - Cryptography (algorithms, key handling, IV/nonce reuse, randomness)
   - Storage (DB queries, ORM use, file IO, blob storage)
   - IPC / RPC / message bus
   - API surface (HTTP, gRPC, GraphQL, WebSockets)
   - Deserialization (JSON, YAML, XML, pickle, protobuf, Avro)
   - Templating (server-side templates, client-side templates, SSR)
   - Parser surface (custom parsers, regex DOS, ReDoS, format strings)
   - FFI / native bindings / unsafe blocks
   - Subprocess / shell invocation
   - Path handling (path traversal, archive extraction, symlink races)
   - SSRF / outbound HTTP
   - CSRF / CORS / clickjacking
   - Content security (CSP, MIME sniffing, X-Frame-Options)
   - **Logging / observability / audit trails (Repudiation)** — audit logs for security-critical operations, signed payloads, request correlation IDs, append-only audit stores, log integrity controls.
   - Error handling (info disclosure, stack traces, exception swallowing)
   - Concurrency (TOCTOU, races, deadlock, lock ordering)
   - Memory safety (in unsafe languages or native code)
   - Supply chain (dependencies, lockfiles, post-install scripts) — **Operational checks:** see the **Supply-chain heuristics** section in the Reference appendix. _(Omitted entirely when `deps` is in the §5.11 skip set.)_
   - IaC / Dockerfiles / Kubernetes manifests / Terraform
   - CI / CD pipelines (GitHub Actions, GitLab CI, CircleCI)
   - Secrets management (env vars, .env, secret stores, hardcoded keys)
   - Time / clock / token expiration
   - Rate limiting / abuse / quota
   - Multi-tenant data isolation
   - `llm-prompt-construction` — prompt assembly, system prompt isolation, template injection, indirect prompt injection via tool outputs (LLM01, LLM07). (Triggered when the codebase has LLM/AI/ML inference surfaces.)
   - `llm-output-handling` — output sanitization before rendering / executing / passing to downstream tools; PII redaction; safe rendering of tool outputs (LLM02, LLM06). (Triggered when the codebase has LLM/AI/ML inference surfaces.)
   - `llm-agency-tool-permissions` — tool-call whitelisting, parameter validation, scope of attached credentials, blast-radius of autonomous actions (LLM07, LLM08). (Triggered when the codebase has LLM/AI/ML inference surfaces.)
   - `llm-consumption-bounds` — per-user rate limits, token budgets, max context size, parallel-call limits, recursive-call guards (LLM04). (Triggered when the codebase has LLM/AI/ML inference surfaces.)

   **Coverage check:** see the **Coverage matrix** section in the Reference appendix for the STRIDE/OWASP/OWASP-LLM/Supply-Chain → area mapping.

2. **Enumerate areas explicitly.** After area detection, write `<mission-dir>/_run-archive/areas.json` BEFORE any lieutenant dispatch. Schema: an array of records with `{area, code_roots[], lieutenant_focus, priority_tier, jury_slot_hint, exclude_globs[], graph_nodes[], graph_paths[], graph_filtered}`. The last three are populated only on §5.6 graph-scoped runs (`graph_nodes`/`graph_paths` carry the per-area graph scope; `graph_filtered: true` marks an area whose `code_roots` were narrowed to the graph in `filter` mode). This file is the canonical area registry and is consumed by the dispatcher (next step) and by §9 consolidation (to render `by-area/INDEX.md`).

3. **Write dispatch packets.** For each area, BEFORE spawning the lieutenant, write a dispatch packet at `<mission-dir>/_run-archive/dispatch/lieutenants/<area>.md` containing: the bound variables (area, target_path, commit_sha, mission_dir, jury_slot_hint from areas.json, AND `graph_scope` = `{mode, graph_nodes, graph_paths}` from areas.json when the run is §5.6 graph-scoped) AND the verbatim lieutenant prompt body (the **Lieutenant prompt (Pass 0)** section in the Reference appendix rendered with the bound variables substituted). This makes runs reproducible and auditable.

4. Spawn one `Task` per area, `complexity: heavy`. Each lieutenant gets a SPECIFIC jury-member model (rotate through Opus / GPT / Gemini across areas so the seed list reflects multiple perspectives). Use the **Lieutenant prompt (Pass 0)** section in the Reference appendix. Respect the `BATCH_SIZE_LIEUTENANTS` cap from §5.4 — process areas in batches, not all at once. Within a batch, dispatch the per-area parallel Tasks fully in parallel.

5. Each lieutenant produces TWO outputs in `_run-archive/lieutenants/<area>/`:

   - `LIEUTENANT.md` — human-readable narrative seed list with:
     - File:line citations for every candidate
     - 5-10 lines of code context per candidate
     - Initial severity proposal (CRITICAL/HIGH/MEDIUM/LOW/INFO)
     - Initial confidence (HIGH/MEDIUM/LOW)
     - One-paragraph trigger description
   - `LIEUTENANT.json` — machine-readable sidecar (array of candidate records with the same fields as the `.md`). The orchestrator parses this JSON for deterministic dedup and canonical finding-ID assignment; the `.md` is a rendering of the same data.

6. Orchestrator de-dupes (collapse same file:line + same root-cause) using `LIEUTENANT.json` as the source of truth, assigns finding IDs (`<area>-<seq>`), and consolidates into `FINDINGS.md` and `findings.json` (top-level canonical list). No `findings/<id>/` folder is created during Pass 0 — per-finding folders are created lazily when a finding first needs per-finding artifact storage (Pass 4 onward). Findings that are demoted before Pass 4 therefore leave no per-finding folder behind; their verdicts live only in `_run-archive/judge-pass{1,2,3}.json`.

Lieutenants are explicitly INSTRUCTED to be over-inclusive. Downstream passes (especially Pass 1, Pass 4, Pass 8) filter false positives. If a lieutenant misses a real issue, no later pass can recover it — so err toward over-inclusion.

**When to use the lieutenant pattern:** for repos > ~100k LOC, > ~5 distinct subsystems, or when phase 1 recon identifies > 8 personas / handler families. Spawn one sub-worker per subsystem under `sub-workers/<subsystem>.md`, with a `sub-workers/LIEUTENANT.md` coordinator that owns dedup and synthesis. Below these thresholds the flat per-area lieutenant dispatch above is sufficient; the sub-worker/coordinator split exists to prevent any single lieutenant from over-running its context window on very large targets. Respect the `BATCH_SIZE_LIEUTENANTS` cap from §5.4 — process subsystems in batches, not all at once. Within a batch, dispatch the per-subsystem parallel Tasks fully in parallel.

### Pass 1 — Line-anchor verification (`line-anchor`)

Goal: confirm each candidate finding actually exists at the cited file:line. Cheap, fast, but mandatory.

**run.md (## Timeline):** append `pass-start` UTC timestamp before dispatch; at pass end append `pass-end` UTC timestamp, `candidates-in` count, `candidates-promoted-out` count (CONFIRMED), demoted count (DISPUTED), NEEDS-CONTEXT-recursion count, and any blockers.

Procedure (per finding) — **run inline in the current session; no jury, no `Task`:**

1. The orchestrator itself opens the cited file at the pinned commit, quotes 5-10 lines around the cited line, and classifies (use Pass 1 in the **Judge floor prompts (Passes 1–3)** section in the Reference appendix as the rubric):
   - `CONFIRMED` — code at file:line matches the finding's claimed pattern.
   - `DISPUTED` — code at file:line does NOT match (e.g., the claimed pattern is absent, or the line is different).
   - `NEEDS-CONTEXT` — file:line exists but additional context is needed to judge (callers, type info, config). Trigger §7 recursion.
2. Write the verdict to `_run-archive/judge-pass1.json[<finding-id>]`.

This is a deterministic file lookup, not a judgement call about severity or exploitability, so it does not need multiple model families — doing it inline saves the jury budget for the severity-triage gate. Findings classified DISPUTED here are demoted to "informational — disputed at line-anchor" but remain in the report.

### Pass 2 — Vendor prior-art screen (`vendor-prior-art`)

Goal: tag each finding with prior CVEs, GHSAs, vendor advisories, recent commits in the cited path, public HackerOne disclosures.

**run.md (## Timeline):** append `pass-start` UTC timestamp before dispatch; at pass end append `pass-end` UTC timestamp, `candidates-in` count, `candidates-promoted-out` count, demoted count (DEMOTE-DUPLICATE / DEMOTE-KBD), NEEDS-CONTEXT-recursion count, and any blockers.

Procedure (per finding) — **a single delegated prior-art worker; no jury:**

1. Dispatch ONE `Task` (or `drool exec`) prior-art worker. Use Pass 2 in the **Judge floor prompts (Passes 1–3)** section in the Reference appendix. Prior-art research is a search task, not a judgement call, so it does not need multiple model families — a single worker is sufficient and cheaper. Respect the `BATCH_SIZE_JURY_FINDINGS` cap from §5.4 — process findings in batches.
2. The worker runs ~25-30 queries:
   - Vendor security page for the project / library
   - GHSA database (GitHub security advisories)
   - NVD / CVE database
   - HackerOne public disclosures
   - Recent commits (last ~12 months) touching the cited path or symbol
3. The worker classifies:
   - `REMAINS-NOVEL` — no prior art found.
   - `DEMOTE-DUPLICATE` — exact prior CVE/GHSA exists. Tag and continue. **Does NOT drop the finding** — duplicates of real bugs are still real bugs; reduce novelty score, keep correctness score.
   - `SIBLING-OF-PRIOR` — prior CVE in same class but different code path. Tag and continue.
   - `DEMOTE-KBD` — known-bad-detection pattern (false-positive matcher). Tag DISPUTED with rationale.
4. Write to `_run-archive/judge-pass2.json[<finding-id>]` and append `prior_art[]` to the finding's canonical record.

### Pass 3 — Deep prior-art screen (`deep-prior-art`)

**Skip gate:** if `prior-art` is in the §5.11 skip set, SKIP this pass entirely — findings carry no `prior_art_deep[]` enrichment and proceed directly to §5.7. Log the skip in `run.md`. (The `vendor-prior-art` pass still runs; it is part of the protected floor.)

Goal: build research breadcrumbs. Where does this class of bug appear in the literature? What variants exist? What did patch maintainers learn from past CVEs?

**run.md (## Timeline):** append `pass-start` UTC timestamp before dispatch; at pass end append `pass-end` UTC timestamp, `candidates-in` count, enrichment-links-added count, NEEDS-CONTEXT-recursion count, and any blockers. (Pass 3 does not promote/demote; candidates-out == candidates-in.)

Procedure (per finding) — **the same single prior-art worker continues; no jury:**

1. Dispatch ONE `Task` (or `drool exec`) worker — the same single-worker pattern as Pass 2. Use Pass 3 in the **Judge floor prompts (Passes 1–3)** section in the Reference appendix. Respect the `BATCH_SIZE_JURY_FINDINGS` cap from §5.4 — process findings in batches.
2. The worker runs ~80-150 queries: sibling-class CVEs across other libraries, academic papers, USENIX/Black Hat/DEF CON talks, security blog posts, language-specific advisories.
3. Outputs a research linkage block in the finding record under `prior_art_deep[]`, with per-link short summaries.
4. This pass does NOT promote/demote. It enriches.
5. Write to `_run-archive/judge-pass3.json[<finding-id>]`.

### Severity-triage jury — the gate (per §3)

This is the audit's **one multi-model jury**, run via file-free `drool exec` (see **Jury execution (file-free)** in the Reference appendix). It runs once per finding that survived the floor as `REMAINS-NOVEL` / `SIBLING-OF-PRIOR` (DISPUTED / DEMOTE-\* findings stay at their floor verdict and skip the jury).

**run.md (## Timeline):** append `pass-start` UTC timestamp before launch; at pass end append `pass-end` UTC timestamp, `candidates-in` count, `escalated-out` count (ESCALATE), `report-as-is` count, `dropped-to-info` count, jury-split count, tiebreaker-round count, and any blockers (unparseable juror, fallback model substitution, degraded single-family mode).

Procedure (per surviving finding):

1. Build the low-context juror prompt: inline the one-line claim, suspected class, `file_line`, and 5–10 lines of `code_evidence`. Nothing about who found it or the upstream verdicts.
2. Launch the three jurors in parallel via `drool exec -m <model>` (slots A/B/C from the §3 table), `-o json`. Respect `BATCH_SIZE_JURY_FINDINGS` / `MAX_CONCURRENT_TASKS` from §5.4. If `drool exec` is unavailable, use the documented degradation path (§3 / appendix).
3. Parse each juror's JSON verdict; retry/substitute per the appendix so three usable verdicts are consolidated.
4. Consolidate per §3 (median severity + escalate/drop gate). A maximally-split verdict is not broken by a fourth juror — it escalates on doubt (§4) into the evidence tier.
5. Write all three verdicts + the consolidated severity + the gate decision to `_run-archive/judge-jury.json[<finding-id>]`; set the finding's `severity_final` and gate outcome (`ESCALATE` / `REPORT-AS-IS` / `DROP-TO-INFO`).

Only findings with gate outcome `ESCALATE` proceed to the escalation tier below (and only when their §5.7 triggers also fire). `REPORT-AS-IS` findings are finalized at their floor verdict; `DROP-TO-INFO` findings move to the informational section (never deleted).

### Pass 4 — Dataflow & reachability (`dataflow`)

Goal: prove (or disprove) reachability from an untrusted source to the vulnerable sink.

**run.md (## Timeline):** append `pass-start` UTC timestamp before dispatch; at pass end append `pass-end` UTC timestamp, `candidates-in` count, `candidates-promoted-out` count (REACHABLE-FROM-UNTRUSTED), demoted count (UNREACHABLE / REACHABLE-INTERNAL-ONLY), tiebreaker-round counts, NEEDS-CONTEXT-recursion count, and any blockers.

Procedure (per finding):

Respect the `BATCH_SIZE_ESCALATION` cap from §5.4 — process findings in batches, not all at once. Within a batch, dispatch the per-finding parallel Tasks fully in parallel.

1. ONE `drool exec` process (the tracer, pinned to one model family) does the heavy taint trace:
   - Forward trace: source → every transformation → sink. List every intermediate function, every sanitizer applied, every branch, every type narrowing.
   - Backward trace: sink ← every caller ← every entry point. Identify which entry points are reachable from untrusted input.
   - Write `findings/<finding-id>/dataflow.md` with the full trace. (Pass 4 is where the per-finding folder is first created; the orchestrator `mkdir -p findings/<finding-id>/` before the trace author begins.)
2. TWO more `drool exec` processes, pinned to model families DIFFERENT from the tracer, independently review the trace. They do not redo the trace; they critique it. Each classifies:
   - `REACHABLE-FROM-UNTRUSTED` — trace shows a clean path from untrusted input to sink.
   - `REACHABLE-INTERNAL-ONLY` — sink reachable only from authenticated/trusted internal callers.
   - `UNREACHABLE` — sink unreachable in the audited code (dead code, gated behind a feature flag, etc.).
3. Use the Pass 4 subsection of the **Judge escalation prompts (Passes 4, 5, 8)** section in the Reference appendix. Take the majority reviewer verdict; on a split, the §4 tiebreaker applies.
4. UNREACHABLE findings demote to "informational — unreachable in audited config" but remain in the report. REACHABLE-FROM-UNTRUSTED findings get a confidence elevation.
5. Write to `_run-archive/judge-pass4.json[<finding-id>]` and add `dataflow_reachability` to the finding record.

### Pass 5 — Exploit construction (`exploit`)

Goal: for each reachable finding, construct (or attempt to construct) a minimal exploit. If no exploit is constructible even in principle, the finding is "theoretical."

**run.md (## Timeline):** append `pass-start` UTC timestamp before dispatch; at pass end append `pass-end` UTC timestamp, `candidates-in` count, `candidates-promoted-out` count (EXPLOITABLE), demoted count (THEORETICAL / UNEXPLOITABLE), tiebreaker-round counts, and any blockers.

Procedure (per finding):

Respect the `BATCH_SIZE_ESCALATION` cap from §5.4 — process findings in batches, not all at once. Within a batch, dispatch the per-finding parallel Tasks fully in parallel.

1. ONE `drool exec` process (the constructor, pinned to a model family different from the Pass 4 tracer) attempts to construct the exploit.
2. Produces `findings/<finding-id>/exploit.md` with:
   - Preconditions (what must be true for the exploit to fire)
   - Inputs (exact bytes / payloads / URLs / sequences)
   - Expected observable (what the attacker sees on success)
   - Realistic attacker profile (network position, privileges, knowledge required)
   - Optional sketch of automation (curl command, python script outline)
3. TWO more `drool exec` processes on different model families independently review. Use the Pass 5 subsection of the **Judge escalation prompts (Passes 4, 5, 8)** section in the Reference appendix.
4. Each classifies:
   - `EXPLOITABLE` — exploit demonstrated or sketched with high confidence.
   - `THEORETICAL` — vulnerability exists but no realistic exploit constructed.
   - `UNEXPLOITABLE` — exploit fails (e.g., a sanitizer in fact blocks it; or input cannot reach sink in any reachable shape).
5. Take the majority reviewer verdict; on a split, the §4 tiebreaker applies.
6. Write to `_run-archive/judge-pass5.json[<finding-id>]` and add `exploit_status` to the finding record.

### Pass 8 — Adversarial red-team disprove (`red-team`)

Goal: try to disprove every currently-promoted finding. The hardest pass. Survivors earn the highest confidence tier.

**run.md (## Timeline):** append `pass-start` UTC timestamp before dispatch; at pass end append `pass-end` UTC timestamp, `candidates-in` count (currently promoted), `candidates-promoted-out` count (RED-TEAM-SURVIVED), demoted count (RED-TEAM-DISPROVED), RED-TEAM-INCONCLUSIVE count, empirical-round counts, and any blockers.

Procedure (per promoted finding):

1. Launch ONE fresh `drool exec` process pinned to a model family DIFFERENT from (a) the lieutenant that proposed the finding in Pass 0 and (b) the Pass 4 tracer. Respect the `BATCH_SIZE_ESCALATION` cap from §5.4 — process findings in batches, not all at once. Within a batch, launch the per-finding `drool exec` reviewers fully in parallel.
2. The reviewer is given:
   - The full finding record (file:line, dataflow trace, exploit sketch).
   - An adversarial prompt: "Prove this finding is wrong. Find any reason it is not actually exploitable, not actually reachable, or not actually a vulnerability. Be hostile. Be skeptical. Look for sanitizers we missed, type narrowings we missed, runtime behaviors we missed, configuration that disables the path, deployment context that mitigates the impact."
3. Use the Pass 8 subsection of the **Judge escalation prompts (Passes 4, 5, 8)** section in the Reference appendix.
4. Outcomes:
   - `RED-TEAM-DISPROVED` — red-team found a reason the finding is wrong. Demote to `DISPUTED-AFTER-ADVERSARIAL`. Keep in report.
   - `RED-TEAM-INCONCLUSIVE` — red-team produced a doubt but not a refutation. Tag as such. Verdict stands but confidence drops.
   - `RED-TEAM-SURVIVED` — red-team could not disprove. **This is the highest confidence tier.**
5. Write to `_run-archive/judge-pass8.json[<finding-id>]` and update `red_team_status` in the finding record.

The point of this pass is to avoid self-reinforcement. A different model with a different prompt is the only protection against systematic confirmation bias in the earlier passes.

---

## §7 — NEEDS-CONTEXT recursion (no hardcoded cap)

When ANY pass returns `NEEDS-CONTEXT` for a finding, the orchestrator spawns a context-gathering sub-worker and resumes the pass after context is in hand.

Procedure:

1. Spawn a fresh sub-worker on a jury-member model (rotate family from the pass that raised NEEDS-CONTEXT). Instructions below.
2. The sub-worker:
   - Reads adjacent files (callers, callees, interfaces, types).
   - Greps the repo for related symbols, tests, fixtures, and config.
   - Checks `git log` and `git blame` on the cited lines and surrounding files.
   - Reads relevant configuration (env vars, `.env.example`, framework config files).
   - If still ambiguous: consults the language spec, library documentation, or framework reference (read-only network OK per §2).
3. Writes results to `findings/<finding-id>/ctx/round-N.md`.
4. Resumes the originating pass with the new context.

**Halting rules (NO recursion-depth cap; user direction = thoroughness > speed):**

- Halt when the originating pass produces a non-NEEDS-CONTEXT verdict.
- Halt when the same context has already been gathered (loop detection: hash the context-gathering query and abort if seen this round).
- Halt when 2 rounds of context gathering have produced identical results AND the verdict is still NEEDS-CONTEXT — in this case tag the finding `VERIFIABLE-UNKNOWN` and park in `run.md`. The finding remains in `DASHBOARD.md` with that tag.
- Halt the whole-mission recursion when `NEEDS_CONTEXT_TOTAL_BUDGET` from §5.4 is exhausted. The per-finding rules above remain uncapped; the mission-wide total is capped at `3 × final-finding-count` to keep runaway recursion from consuming the whole audit. When the budget is exhausted, any still-open NEEDS-CONTEXT finding is tagged `VERIFIABLE-UNKNOWN`, logged in `run.md` with the exhaustion reason, and parked in `run.md`.

Loop detection prevents infinite recursion on truly unknowable points; thoroughness preference prevents premature halting on resolvable points.

The mission-wide `NEEDS_CONTEXT_TOTAL_BUDGET` cap from §5.4 adds a second layer of protection: even when per-finding recursion is working correctly, the mission-wide total prevents an unbounded pathological recursion from starving later passes.

---

## §8 — Provenance recording

For each finding, write `findings/<finding-id>/provenance.json`. Required fields:

```json
{
  "id": "auth-001",
  "title": "JWT signature verification skipped when alg=none accepted",
  "proposed_by": {
    "area": "authentication",
    "lieutenant_model": "claude-opus-4-8"
  },
  "passes": [
    {
      "pass": "pass1-line-anchor",
      "mode": "inline",
      "verdict": "CONFIRMED",
      "evidence_quote": "...",
      "notes": "Verified inline by the orchestrator; no jury."
    },
    {
      "pass": "pass2-vendor-prior-art",
      "mode": "single-worker",
      "verdict": "REMAINS-NOVEL",
      "notes": "29 queries; no exact prior CVE."
    },
    {
      "pass": "pass4-dataflow",
      "mode": "drool-exec",
      "tracer_model": "gpt-5.5-pro",
      "reviewer_verdicts": [
        { "model": "claude-opus-4-8", "verdict": "REACHABLE-FROM-UNTRUSTED" },
        {
          "model": "gemini-3.1-pro-preview",
          "verdict": "REACHABLE-INTERNAL-ONLY"
        }
      ],
      "synthesis": "REACHABLE-FROM-UNTRUSTED",
      "split": true,
      "notes": "Gemini disagreed; tiebreaker round 1 confirmed reachability."
    }
  ],
  "jury": {
    "mode": "drool-exec",
    "verdicts": [
      {
        "model": "claude-opus-4-8",
        "severity": "HIGH",
        "recommendation": "ESCALATE",
        "false_positive_risk": "low",
        "rationale": "..."
      },
      {
        "model": "gpt-5.5-pro",
        "severity": "HIGH",
        "recommendation": "ESCALATE",
        "false_positive_risk": "low",
        "rationale": "..."
      },
      {
        "model": "gemini-3.1-pro-preview",
        "severity": "MEDIUM",
        "recommendation": "REPORT-AS-IS",
        "false_positive_risk": "med",
        "rationale": "..."
      }
    ],
    "consolidated_severity": "HIGH",
    "gate": "ESCALATE",
    "split": true,
    "tiebreakers": []
  },
  "tiebreakers": [
    {
      "round": 1,
      "pass": "pass4-dataflow",
      "method": "empirical-check",
      "evidence": "ran minimal reproducer; untrusted input reached sink",
      "resolved_verdict": "REACHABLE-FROM-UNTRUSTED",
      "resolved_severity": "HIGH"
    }
  ],
  "red_team_survived": true,
  "final_confidence": "RED-TEAM-SURVIVED",
  "dissent_notes": [
    "Jury: Gemini rated MEDIUM/REPORT-AS-IS vs HIGH/ESCALATE from the other two; consolidated HIGH → ESCALATE.",
    "Pass 4: Gemini initially classified REACHABLE-INTERNAL-ONLY; tiebreaker overruled with empirical reproducer."
  ]
}
```

`final_confidence` ∈ `{ "RED-TEAM-SURVIVED", "ESCALATED", "REPORT-AS-IS", "VERIFIABLE-UNKNOWN", "DROP-TO-INFO" }`. `jury.gate` ∈ `{ "ESCALATE", "REPORT-AS-IS", "DROP-TO-INFO" }`; `jury_mode` is `"drool-exec"` or `"degraded-single-family"`.

The jury is fixed at three models, so `jury.tiebreakers[]` is always `[]` — the jury itself never spawns a tiebreaker juror (a maximally-split verdict escalates by §3 rule 2 instead). Tiebreakers that fire belong to the **escalation tier** and are recorded in the top-level `tiebreakers[]` (not under `jury`), each shaped `{ "round": 1, "pass": "pass4-dataflow", "method": "re-examined-artifact" | "empirical-check", "evidence": "<trace/exploit/runtime result re-examined>", "resolved_verdict": "...", "resolved_severity": "..." }`. No tiebreaker entry ever records an added model — per §4, ties are broken by evidence, not extra votes.

The provenance JSON is the canonical record. Markdown reports are renderings of it. If the markdown and the provenance disagree, the provenance is correct.

---

## §9 — Consolidation

After all judge passes complete (floor, plus any triggered escalation passes) and all NEEDS-CONTEXT recursions halt, build the consolidated outputs:

1. **`findings.json`** — canonical list at top-level of mission-dir, every finding, every field per the **Output schema** section in the Reference appendix.
2. **`FINDINGS.md`** — narrative-style writeup, one section per finding, severity-sorted. Use the **FINDINGS.md template** section in the Reference appendix.
3. **`JUDGE.md`** — per-finding verdict tables surfacing every pass that fired (floor always; escalation conditionally). Use the **JUDGE.md template** section in the Reference appendix.
4. **Per-finding status table** — folded into `DASHBOARD.md` (item 5); no standalone `STATUS.md` is written. The table MUST include:
   - Total findings + breakdown by `final_confidence` tier.
   - Per-finding row with columns: ID, title, severity, dataflow-reachability, exploit-status, red-team-status, jury-split (Y/N), dissent-notes (truncated), and a `Folder` link pointing to `findings/<id>/` (the per-finding README surfaces every other artifact).
5. **`DASHBOARD.md`** — the single at-a-glance page: counts, severity histogram, top-10 list, AND the per-finding status table from item 4. Use the **DASHBOARD.md template** section in the Reference appendix (which incorporates the status table and the Never-Upload reminder at the top). Top-10 and per-finding rows include a `Folder` link to `findings/<id>/`.
6. **`README.md`** — how to read the audit, what each file contains, how to interpret confidence tiers.
7. **`by-severity/CRITICAL.md` / `HIGH.md` / `MEDIUM.md` / `LOW.md` / `INFO.md` / `ALL.md` / `INDEX.md`** — severity-sorted re-renderings. Each per-severity file (`CRITICAL.md`, `HIGH.md`, `MEDIUM.md`, `LOW.md`, `INFO.md`, and the combined `ALL.md`) is a SUMMARY that POINTS TO each finding's per-finding folder — it is NOT a re-inlining of the full narrative (that lives in `FINDINGS.md` and `findings/<id>/README.md`). For each finding in a given severity bucket, render ONE table row (or list entry) that includes ALL of:

   - Finding ID as a clickable link to the per-finding folder: `[<id>](findings/<id>/)`
   - A secondary link to the per-finding entry page: `[README](findings/<id>/README.md)`
   - Title
   - Severity
   - `final_confidence` tier
   - `dataflow_reachability` / `exploit_status` / `red_team_status` (compact)
   - `file:line` anchor (as displayed text; the link target remains `findings/<id>/`)
   - Back-link to the finding's section in `FINDINGS.md`: `[narrative](../FINDINGS.md#<id>)`
     Rows are sorted severity desc, then `final_confidence` desc, then finding ID asc. A severity bucket with zero findings renders the file with a header and a single "No findings at this severity." line (do not omit the file).
     `by-severity/ALL.md` is the union of all severities sorted the same way and uses the same row schema. `by-severity/INDEX.md` is a top-of-by-severity dashboard that MUST include: (a) a severity-count table with columns `Severity | Promoted | Disputed | VU | Total` referencing `findings.json`, (b) a bullet list linking to each per-severity file (`[CRITICAL.md](CRITICAL.md)` … `[ALL.md](ALL.md)`) with the per-file count in parentheses, and (c) a link to `HARDENING.md` (see next bullet) with the total count of hardening notes in the repo. See the **Output format** section §2.12 in the Reference appendix for the authoritative file skeleton.

   `by-severity/HARDENING.md` is the canonical hardening rollup for this repo's findings and MUST be emitted alongside the per-severity files. It aggregates every `<TAG>-NNN.md` note under the repo's `hardening/` directory (see §5.5 / `methodology.md`) plus `hardening/SUMMARY.md` into one document and cross-references each hardening note back to its finding ID. Required structure:

   - H1 title + one-paragraph intro (what hardening notes are, when they were written — fresh-HEAD re-verification after `phase5`).
   - Summary section: the verbatim or summarized contents of `hardening/SUMMARY.md`.
   - A table listing every `<TAG>-NNN.md` hardening note in the repo with columns: `Hardening Note | Finding ID | Status | Advisory delta`. The `Finding ID` column is a link to `findings/<id>/README.md` (the canonical per-finding entry), providing the two-way cross-reference.
   - A closing "All hardening notes by finding ID" inverted index section with rows `Finding ID → Hardening Note path` so reviewers arriving from a finding can jump to the hardening note, and reviewers arriving from a hardening note can jump back to the finding.
     The consolidation step for `HARDENING.md` runs after §9 item 7's per-severity files and before item 8 (by-area/). An audit whose tree has no `hardening/` subdirectory (e.g., mid-mission handoff before `phase5`) emits `HARDENING.md` with the header and a single "No hardening notes yet; hardening is populated after phase5." line — the file is never omitted.

8. **`by-area/<area>.md`** (+ `by-area/INDEX.md`) — one file per detected area (driven from `_run-archive/areas.json`), listing all promoted findings within that area in severity-desc / confidence-desc order. Each row includes a link back to `_run-archive/areas.json` and to the finding's `DASHBOARD.md` status-table row. `by-area/INDEX.md` lists the per-area files with per-area counts.
9. **`findings/<finding-id>/README.md`** — user-facing entry page per finding. New at consolidation. Contains: H1 with finding title + severity badge; a "Quick links" bullet list pointing to `disclosure.md`, `exploit.md`, `dataflow.md`, `poc/README.md` (if present), `evidence/README.md` (if present), `provenance.json`; a one-paragraph summary pulled from the `FINDINGS.md` narrative; confidence tier and final verdict; and the resolved disclosure target.
10. **`findings/<finding-id>/disclosure.md`** — local-only disclosure draft per promoted finding (see §12). Written during consolidation inside the same per-finding folder; no separate top-level `disclosure/` directory.
11. **Append final-summary block to `run.md`'s `## Timeline` section.** After every other consolidation artifact is written, append a `### Final summary` subsection to `run.md`'s `## Timeline` with total mission wall-clock, per-pass wall-clock times (computed from the pass-start/pass-end timestamps), total tiebreaker-round-1/round-2 counts, total NEEDS-CONTEXT recursions, fallback jury notes, and the final findings-by-severity histogram. This block is the canonical timing summary and is rendered into `DASHBOARD.md`'s Timing row.
12. **Delete empty scaffold dirs.** If the surrounding mission framework created a `contract-work/` (or any other empty directory not documented in the §5 tree), remove it now so the final mission dir contains only the documented files.

Additionally, per-finding provenance JSONs are written at `findings/<finding-id>/provenance.json` as each pass appends a new entry (§8). By consolidation time they are already canonical — no move is needed.

`run.md` and `findings.json` are always written regardless of documentation depth.
If the user picked "Minimal" documentation in §1.Q6: skip FINDINGS.md, README.md, by-severity/, by-area/. Keep DASHBOARD.md (which carries the per-finding status table) + JUDGE.md + `findings/<id>/` (with provenance.json + dataflow.md + exploit.md + ctx/ + README.md) + `_run-archive/`.
If the user picked "Raw" documentation in §1.Q6: skip JUDGE.md, DASHBOARD.md, README.md, by-severity/, by-area/, and per-finding `README.md`. Keep FINDINGS.md + findings.json + `findings/<id>/` (with provenance.json + dataflow.md + exploit.md + ctx/) + `_run-archive/`.

---

## §10 — PoC generation (non-interactive)

This is the second of three NEVER-UPLOAD reminders. PoCs are local artifacts. They are NOT uploaded, NOT auto-submitted. The consent to generate and (optionally) auto-run PoCs was captured in §1.Q7. **NO additional AskUser call is made here — the §1 answer is the single source of truth for PoC behavior, and the pipeline never prompts per-finding.**

**Skip gate:** if `poc` is in the §5.11 skip set, treat §1.Q7 as "Skip PoC generation entirely" regardless of the selected PoC mode — skip this section entirely, draft no scripts, run nothing. Log the skip in `run.md`.

PoC behavior is driven directly from §1.Q7:

- **"Skip PoC generation entirely"** → skip this section entirely. No scripts are drafted.
- **"Generate scripts only"** → draft all scripts; do NOT execute any of them.
- **"Generate + auto-run in sandbox"** → draft all scripts AND auto-run every sandbox-eligible PoC silently. Skips and failures are logged to `findings/<finding-id>/poc/execution.log`; the pipeline does not pause and does not prompt.

Procedure: see the **PoC generation** section in the Reference appendix. Summary:

1. For each EXPLOITABLE finding, draft a script in `findings/<finding-id>/poc/exploit.{sh,py,ts}` based on the Pass 5 exploit record.
2. Add `findings/<finding-id>/poc/README.md` describing what the script does, what preconditions it assumes, and what observable proves success.
3. If §1.Q7 = "Generate scripts only": write all scripts and stop.
4. If §1.Q7 = "Generate + auto-run in sandbox": iterate over every EXPLOITABLE finding and run the PoC silently under the sandbox configuration. Append `START`, `END exit=<code>` (or `FAIL <reason>`) to `findings/<finding-id>/poc/execution.log`. Do NOT prompt on failure. Continue to the next PoC regardless.
5. Sandbox invariants (never weakened): sandbox subdirectory writes only; never touch real files outside `findings/<finding-id>/poc/sandbox/run-<UTC-timestamp>/`; never hit live external services; must target a local docker-compose stack, local fixtures, or testcontainers. Redact captured secrets before storing logs.
6. **Non-sandboxable PoCs are skipped silently (no prompt).** If a PoC requires a live external target (non-local service, third-party API, production credentials) it CANNOT be auto-run. Write a marker file `findings/<finding-id>/poc/SANDBOXED=false` with a one-line rationale, append the skip to `findings/<finding-id>/poc/execution.log`, and move on. Do NOT prompt the user; the script is still produced so the user can run it manually under their own authorization.
7. Never run a PoC against a production system. Never run a PoC against a system the user does not own. The orchestrator MUST verify the target resolves to `localhost`, a private IP, a Docker bridge, or an explicitly-local testcontainer before execution.

---

## §11 — Evidence capture (gated)

Runs only if the user selected an evidence option ≠ "None" in §1.Q8. The §1.Q8 answer is applied uniformly to every eligible finding — no per-finding prompts, no AskUser call is emitted here. **Skip gate:** if `evidence` is in the §5.11 skip set, treat §1.Q8 as "None" regardless of the selected option — capture nothing. Log the skip in `run.md`.

Procedure summary:

1. asciinema: `asciinema rec findings/<finding-id>/evidence/<finding-id>.cast` to record terminal sessions.
2. ffmpeg screen capture: `ffmpeg -f avfoundation -i "1" findings/<finding-id>/evidence/<finding-id>.mp4` (macOS); `ffmpeg -f x11grab ...` (Linux).
3. Headless browser (web PoCs): Playwright headless, write `findings/<finding-id>/evidence/<finding-id>.mp4` and `<finding-id>.har`.
4. Capture errors are logged to `findings/<finding-id>/evidence/capture.log`; the pipeline does not pause and does not prompt on failure. If a particular capture mode is not possible for a finding (e.g., no GUI session for ffmpeg on a headless host), skip it silently and note the skip in the log.
5. For every finding that produced at least one capture, write a `findings/<finding-id>/evidence/README.md` evidence index. The README MUST describe: what was captured (terminal cast, screen video, browser recording, HAR), the UTC timestamp of each capture, which `findings/<finding-id>/poc/exploit.*` script was running while the capture was taken (cross-reference `findings/<finding-id>/poc/execution.log`), and how to view each artifact (e.g., `asciinema play <finding-id>.cast`; `ffplay <finding-id>.mp4`; open `<finding-id>.har` in Chrome DevTools' Network panel). This README serves as the per-finding evidence index.
6. Evidence files stay LOCAL — never uploaded.

---

## §12 — Disclosure drafts (local only, NEVER auto-submit)

This is the third of three NEVER-UPLOAD reminders. Disclosure drafts are LOCAL FILES. They exist so the human user can review and decide whether to disclose, and to whom. The skill never sends them.

For each promoted finding (final_confidence ≠ DISPUTED and ≠ VERIFIABLE-UNKNOWN), write the per-finding draft at `findings/<finding-id>/disclosure.md` (one draft per finding, colocated with every other per-finding artifact inside its per-finding folder):

```
# Disclosure draft — <finding id>: <title>

**Status:** local draft. Not submitted to any party.

## Summary
<one paragraph; non-technical lead>

## Affected versions / commits
<commit SHA, branches, tagged versions affected>

## Reproduction steps
<from Pass 5 exploit record>

## Impact
<who is affected, what they lose>

## Suggested fix
<prose suggested fix — layered, minimal, and specific to the cited file:line>

## Suggested disclosure target
- Primary: <vendor security contact, security.txt URL, or maintainer email>
- Secondary: <distribution channel, package registry, downstream maintainers>

## CVSS scoring (3.1 base)
- Vector string: <e.g., AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H>
- Base score: <0.0 - 10.0>
- Severity: <Critical / High / Medium / Low>

## Provenance
- Provenance JSON: ./provenance.json
- Audit slug: <slug>
- Audit date: <YYYYMMDD>
- Jury composition: <list models with versions>
```

Disclosure drafts live **inside the per-finding folder** at `findings/<finding-id>/disclosure.md`, colocated with every other per-finding artifact (provenance.json, dataflow.md, exploit.md, poc/, evidence/). There is no top-level `disclosure/` directory, no `by-finding/`, no `by-vendor/`, and no auto-bundling step. This skill runs one mission per repo (single-repo-per-mission), so vendor bundling is redundant — the mission's `findings/` tree, taken as a whole, is already the bundle for that repo's vendor.

NEVER auto-submit, NEVER auto-email, NEVER auto-file, NEVER upload the drafts. If the user later says "submit them," reply "I do not submit. Files are at `findings/<finding-id>/disclosure.md`. You can send them yourself."

---

## §13 — Mirror to ~/Downloads/ (automatic, local-only)

At the end of the mission, automatically copy the audit directory to `~/Downloads/security-audits/<slug>-<YYYYMMDD>/` as a convenience copy for the user. **No AskUser call is made** — this is a purely local filesystem operation, consistent with the never-upload rule, and the user was already notified of this mirror in the §1 preamble.

Procedure:

```
mkdir -p ~/Downloads/security-audits/
cp -R ~/security-audits/<slug>-<YYYYMMDD>/ ~/Downloads/security-audits/<slug>-<YYYYMMDD>/
```

Rules:

- Do not symlink; do a real recursive copy so the user can browse without touching the canonical mission directory.
- Do not auto-open any file or file manager.
- If `~/Downloads/security-audits/<slug>-<YYYYMMDD>/` already exists, overwrite it with the new copy (the canonical mission directory is the source of truth).
- Errors during the copy (e.g., disk full, permission denied) are logged to `<mission-dir>/run.md` and surfaced in the final handoff. Do NOT prompt.

---

## §14 — Handoff (non-interactive final summary)

When the audit completes, print the final summary to the user. **No AskUser call is made.** The summary MUST include:

1. **Mission directory path** and **Downloads mirror path**:
   - Canonical: `~/security-audits/<slug>-<YYYYMMDD>/`
   - Mirror: `~/Downloads/security-audits/<slug>-<YYYYMMDD>/`
2. **Total findings by `final_confidence` tier** (RED-TEAM-SURVIVED / ESCALATED / REPORT-AS-IS / VERIFIABLE-UNKNOWN / DROP-TO-INFO).
3. **Severity histogram** (counts by CRITICAL / HIGH / MEDIUM / LOW / INFO, with the severity floor applied to the rendered report noted).
4. **Top findings by severity** — a short list of the highest-severity, highest-confidence findings with their IDs and titles (pulled from `DASHBOARD.md`).
5. **Every VERIFIABLE-UNKNOWN finding** with its `run.md` rationale so the user knows what could not be resolved.
6. **Pointers** — tell the user to start at `DASHBOARD.md` (counts + per-finding status table), then drill into `FINDINGS.md` per ID, open `findings/<id>/README.md` for the per-finding entry and `findings/<id>/provenance.json` for the chain of custody, and consult `run.md` for scope/consent + timeline.
7. **Errors and blockers** accumulated during the mission — read `<mission-dir>/run.md` and surface the contents here. This is the first time these are shown to the user (per the non-interactive mission contract).
8. **Coverage trade-offs** — if any §5.11 skip steps were applied, list them and state what was not produced (e.g., "Skipped `deps`: supply-chain dependencies were not analyzed"). If a §5.6 source graph was used in `filter` mode, state that coverage was graph-limited and that code outside the graph was intentionally out of scope.
9. **Never-uploaded reminder**: "Nothing was uploaded. All output is local under `~/security-audits/<slug>-<YYYYMMDD>/` and mirrored to `~/Downloads/security-audits/<slug>-<YYYYMMDD>/`. Disclosure drafts under `findings/<id>/disclosure.md` are drafts only — submit manually if you choose."

---

## NEVER UPLOAD INVARIANT (3 of 3)

Final reminder. This skill produces local artifacts only. It NEVER:

- Files bug-bounty submissions.
- Posts to GitHub / GitLab / Bitbucket.
- Sends email / chat / webhook.
- Pushes to remote git.
- Uploads to object storage.

If the user requests external transmission, decline and re-prompt via AskUser. The default is always: do nothing external.

---

# Reference appendix

The sections below were previously separate files in this skill directory (`methodology.md`, `coverage-matrix.md`, `supply-chain-heuristics.md`, `lieutenant.prompt.md`, `judge-floor.prompt.md`, `judge-escalation.prompt.md`, `poc-generation.md`, `OUTPUT-FORMAT.md`, `output-schema.json`, and the four `*.md.tmpl` rendering templates). They have been folded into `SKILL.md` so the entire skill ships as a single file: the Industry CLI builtin-skills loader bundles only one `SKILL.md` per skill via a `text` import, so sibling files do not reach customer disks. Cross-references in the orchestration body above point to the headings here. Sub-workers dispatched per `SKILL.md` §6 should be given the relevant subsection below verbatim as part of their `Task` prompt — they will not be able to `Read` a sibling file at runtime because none exists on disk.

---

## Methodology reference

Companion to the orchestration body above. Extracted here to keep the orchestration sections focused on flow while preserving the canonical detail for:

- The per-repo five-phase scratch tree (referenced by §5.5).
- The canonical disposition vocabulary used by every judge pass (referenced by §5.8).

Both sub-sections are normative. References elsewhere in this document (including §5.5, §5.8, the **Output format** section, the **Judge floor prompts** section, the **Judge escalation prompts** section, and the `*.tmpl` template sections) that previously cited `§5.5` or `§5.8` resolve here.

### Project structure (per-repo)

When running a **recon-heavy deep audit** against a single target repo, the working tree uses a five-phase scratch convention alongside the consolidation artifacts described in §5. This layout is the canonical per-repo scratch tree used by this skill and complements the §5 mission-dir tree.

```
<root>/<vendor>-<repo>/
├── DASHBOARD.md                      # running checklist (per-finding state, dissent notes, sibling-of-prior flags)
├── FINDINGS.md                    # primary output (narrative writeup, severity-sorted)
├── JUDGE.md                       # judge-pass results (see §5.7 Judge Tier Policy)
├── phase1/                        # recon
│   ├── personas.md
│   ├── trust-topology.md
│   ├── subsystem-inventory.md
│   ├── handler-index.md
│   ├── <surface>.md               # auth-providers, sql-injection-surface, plugin-surface, datasource-ssrf-surface, upload-surface, webhook-callback-surface, secrets-handling, …
│   ├── grep-sweeps/               # raw ripgrep output (one file per sweep)
│   └── PHASE1-COMPLETE.md         # gate: recon is sufficient to start deep-dives
├── phase2/                        # priority handler deep-dives p01..p15
│   ├── p01-<handler>.md
│   ├── …
│   ├── p15-<handler>.md
│   └── PHASE2-COMPLETE.md         # gate: top-15 handlers triaged
├── phase3/                        # broader sweep p16..p30 + sidequests
│   ├── p16-<handler>.md
│   ├── …
│   ├── p30-<handler>.md
│   ├── sidequests.md              # cross-cutting leads not tied to a single handler
│   ├── need-followup-resolutions.md
│   └── PHASE3-COMPLETE.md         # gate: breadth sweep exhausted; ready for synthesis
├── phase4/                        # synthesis
│   ├── bug-classes.md             # taxonomy of bug classes observed
│   ├── missed-bug-classes.md      # negative-space enumeration
│   ├── chains.md                  # multi-step chains / escalation paths
│   ├── amplifiers.md              # impact multipliers (tenant boundaries, public exposure, …)
│   └── PHASE4-COMPLETE.md         # gate: synthesis stable; ready for adversarial review
├── phase5/                        # adversarial review
│   ├── adversarial-review.md      # red-team disprove attempts
│   ├── triage-table.md            # final severity / confidence / disclosure-target table
│   └── PHASE5-COMPLETE.md         # gate: adversarial review done; ready for hardening + disclosure drafts
├── hardening/                     # per-finding hardening notes (fresh-HEAD re-verification + advisory delta)
│   ├── <TAG>-001.md               # one file per promoted finding
│   ├── …
│   └── SUMMARY.md                 # rollup of hardening status
└── sub-workers/                   # OPTIONAL: only when the lieutenant pattern is used (see §6 Pass 0)
    ├── LIEUTENANT.md              # per-area consolidator
    └── <subsystem>.md             # per-subsystem narrow-scope sub-worker outputs
```

**Phase-transition gates** (what triggers moving to the next phase):

- `phase1` → `phase2`: `PHASE1-COMPLETE.md` asserts personas, trust topology, subsystem inventory, and handler index are in place, with surface-specific docs written for every materially-distinct surface.
- `phase2` → `phase3`: `PHASE2-COMPLETE.md` asserts p01..p15 have been read at line-anchor depth and either flagged or explicitly cleared.
- `phase3` → `phase4`: `PHASE3-COMPLETE.md` asserts the breadth sweep (p16..p30) plus sidequests is exhausted and every `need-followup-resolutions.md` entry is resolved or parked.
- `phase4` → `phase5`: `PHASE4-COMPLETE.md` asserts bug classes, missed bug classes, chains, and amplifiers are stable (no new classes surfaced on the last rescan).
- `phase5` → handoff: `PHASE5-COMPLETE.md` asserts adversarial review plus triage table exist and every promoted finding has a disclosure-target row.

`hardening/` is populated after `phase5` at a fresh HEAD: each `<TAG>-NNN.md` re-verifies the finding against current main and records any advisory delta since `phase1`. `SUMMARY.md` rolls up hardening status across all findings.

This scratch tree is **compatible with** the mission-dir tree in §5: for a single-repo mission, `<root>/<vendor>-<repo>/` IS the mission dir, and the §5 consolidation artifacts (`findings.json`, `by-severity/`, `by-area/`, `findings/<id>/`, `_run-archive/`) are generated alongside the phase tree during §9.

### Disposition vocabulary

Verdicts recorded in `JUDGE.md`, `DASHBOARD.md`, and per-finding `provenance.json`. These are the canonical disposition values used across the §6 passes.

#### Pass-1 verdicts (line-anchor)

- **CONFIRMED** — code at the cited file:line matches the claimed pattern.
- **DISPUTED** — code does not match; the claim is wrong at the cited anchor.
- **NEEDS-CONTEXT** — anchor exists but additional context (callers, types, config) is needed before a verdict can be rendered. Triggers §7 context recursion.
- **CONFIRMED-BY-DESIGN** — code matches the claim, but the behavior is a documented default / explicit design choice. Technically correct but ineligible for promotion.

#### Pass-2 verdicts (vendor prior-art)

- **REMAINS-NOVEL** — no prior vendor advisory / CVE / GHSA covers the finding.
- **SIBLING-OF-PRIOR** — a prior CVE/GHSA in the same class exists but for a different code path or parameter. Bundled with the parent advisory in disclosure (see bundling rule below) rather than reported as a separate bug.
- **DEMOTE-DUPLICATE** — an exact prior CVE/GHSA already covers this finding. Tag and demote.
- **DEMOTE-KBD** — the candidate matches a known-bad-detection (false-positive) pattern. Tag and demote.

#### Final verdicts (after all floor passes; rendered in JUDGE.md final table)

- **PROMOTED** — finding is disclosure-eligible.
- **DEMOTED-DUPLICATE** — identical prior art; removed from the disclosure-eligible set but kept in the report under the demoted section.
- **DEMOTED-KBD** — known-bad-detection; kept in the report.
- **DISPUTED** — Pass 1 or Pass 8 successfully disproved the claim; kept in the report.
- **WITHDRAWN** — the auditor withdrew the finding after re-review (e.g., a follow-up read revealed the finding itself was mistaken). Kept in the report with the withdrawal rationale.

#### Severity-shift verdicts

Severity may change during judge. Allowed shifts — **downgrades only**; upgrades during judge are rare and require new evidence:

- `HIGH → MED`
- `HIGH → LOW`
- `MED → LOW`

Severity demotion is a **normal outcome** of the judge, not an error. When it happens:

- Record the shift in the finding's `provenance.json[severity_shifts]` array.
- Render both the original and final severity in `JUDGE.md`'s per-finding table (columns: `severity_original`, `severity_final`).
- A downgrade does NOT remove the finding; it remains in the report at its final severity.

#### SIBLING-OF-PRIOR bundling rule

When Pass 2 returns SIBLING-OF-PRIOR:

- Bundle the finding with the parent CVE/GHSA in disclosure rather than opening a separate report.
- Cite the parent ID in `JUDGE.md` (column: `parent_cve_if_sibling`).
- In disclosure drafts (§12), attach the finding to the existing advisory instead of generating a new one.

---

## Coverage matrix

This section maps the canonical STRIDE / OWASP / OWASP-LLM categories to the Pass 0 audit areas in §6, so a reviewer can verify category coverage without re-reading the whole skill.

### Table 1 — STRIDE → Pass 0 areas

| STRIDE                       | Pass 0 areas                                              |
| ---------------------------- | --------------------------------------------------------- |
| **S** Spoofing               | Authentication, Session management                        |
| **T** Tampering              | Deserialization, Templating, Path handling, Subprocess    |
| **R** Repudiation            | Logging / observability / audit trails (see Fix 4)        |
| **I** Information Disclosure | Error handling, Secrets management, Logging               |
| **D** Denial of Service      | Rate limiting, Parser surface / ReDoS, Consumption bounds |
| **E** Elevation of Privilege | Authorization, Multi-tenant                               |

### Table 2 — OWASP Top 10 (2021) → Pass 0 areas

| OWASP Top 10                                   | Pass 0 areas                                     |
| ---------------------------------------------- | ------------------------------------------------ |
| **A01** Broken Access Control                  | Authorization, Multi-tenant, Path handling, CSRF |
| **A02** Cryptographic Failures                 | Cryptography, Secrets management                 |
| **A03** Injection                              | Storage / SQL, Templating, Subprocess, Parser    |
| **A04** Insecure Design                        | IPC/RPC, Rate limiting                           |
| **A05** Security Misconfiguration              | IaC, Error handling                              |
| **A06** Vulnerable & Outdated Components       | Supply chain                                     |
| **A07** Identification & Auth Failures         | Authentication, Session management               |
| **A08** Software & Data Integrity Failures     | Deserialization, CI/CD pipeline                  |
| **A09** Security Logging & Monitoring Failures | Logging / observability                          |
| **A10** Server-Side Request Forgery            | SSRF                                             |

### Table 3 — OWASP LLM Top 10 → Pass 0 areas

| OWASP LLM Top 10                    | Pass 0 area                                          |
| ----------------------------------- | ---------------------------------------------------- |
| **LLM01** Prompt Injection          | `llm-prompt-construction`                            |
| **LLM02** Insecure Output Handling  | `llm-output-handling`                                |
| **LLM03** Training Data Poisoning   | `llm-training-data`                                  |
| **LLM04** Model DoS                 | `llm-consumption-bounds`                             |
| **LLM05** Supply Chain              | Supply chain (LLM models, datasets, embeddings)      |
| **LLM06** Sensitive Info Disclosure | `llm-output-handling`                                |
| **LLM07** Insecure Plugin Design    | `llm-agency-tool-permissions`                        |
| **LLM08** Excessive Agency          | `llm-agency-tool-permissions`                        |
| **LLM09** Overreliance              | governance (note: out-of-scope for code-level audit) |
| **LLM10** Model Theft               | Secrets management, Cryptography                     |

### Table 4 — Supply-chain heuristic → executable check

| Heuristic                  | Executable check                                                                                                                                                                                                      | Reference                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Recently published package | `npm view <pkg> time --json \| jq '.modified, .[0]'` — flag packages published in the last 7 days                                                                                                                     | **Supply-chain heuristics** section below |
| PyPI publish-date check    | `curl https://pypi.org/pypi/<pkg>/json \| jq '.releases \| to_entries \| sort_by(.value[0].upload_time) \| last'`                                                                                                     | **Supply-chain heuristics** section below |
| Typosquat distance         | Levenshtein distance ≤2 from a popular package name (lodash, react, express, requests, numpy, pandas, etc.); use `agrep` or `rg --no-ignore-case '<typo>'` against `package-lock.json` / `yarn.lock` / `Pipfile.lock` | **Supply-chain heuristics** section below |
| Post-install script grep   | `rg -n '"preinstall"\|"install"\|"postinstall"' package.json`; for Python check `setup.py` `cmdclass={'install': ...}` and `pyproject.toml` build hooks                                                               | **Supply-chain heuristics** section below |
| Maintainer change          | `npm view <pkg> maintainers` vs prior known set; in PyPI, check release history for a new uploader                                                                                                                    | **Supply-chain heuristics** section below |

---

## Supply-chain heuristics

Concrete, copy-pasteable commands for the "Supply chain" Pass 0 area in §6. Each heuristic below turns a qualitative smell into an operational check a reviewer can run against a target repo.

### Recently published packages

A package published in the last 7 days is higher-risk than a stable, long-published package: short-notice typosquats, hijacks, and maintainer-account takeovers often surface via a sudden fresh publish.

```bash
npm view <pkg> time --json | jq '.modified, .[0]'
```

Flag any package whose `modified` (or latest-version upload time) is within the last 7 days. For a full lockfile sweep, iterate over `jq -r '.packages | keys[]' package-lock.json` and run the check per package.

### PyPI publish-date check

PyPI exposes per-release upload times. Sort the release history and inspect the most recent entry.

```bash
curl https://pypi.org/pypi/<pkg>/json | jq '.releases | to_entries | sort_by(.value[0].upload_time) | last'
```

Flag any release uploaded in the last 7 days, and any release whose uploader differs from the established maintainer set (see "Maintainer change check" below).

### Typosquat distance

Typosquats clone popular package names with Levenshtein distance ≤2. Common typosquat targets:

- JavaScript / npm: `lodash`, `react`, `express`, `axios`, `chalk`, `commander`, `debug`
- Python / PyPI: `requests`, `numpy`, `pandas`, `urllib3`, `setuptools`, `pip`
- Ruby / RubyGems: `rails`, `rake`, `bundler`
- Rust / crates.io: `serde`, `tokio`, `clap`

One-liners to scan a lockfile against the typosquat target list:

```bash
# Fuzzy match with agrep (Levenshtein ≤ 2):
agrep -2 'lodash' package-lock.json
# Or, with ripgrep for exact typo candidates:
rg --no-ignore-case 'lodahs|lodsah|lodaash' package-lock.json yarn.lock Pipfile.lock
```

For a systematic sweep, compute edit distance between every lockfile package name and each item in the target list; flag distance ∈ {1, 2}. A quick python snippet using `python-Levenshtein` or the stdlib `difflib.SequenceMatcher` is sufficient.

### Post-install script grep

A common malicious-package pattern is code execution in a post-install hook. Both npm and Python package formats expose these hooks.

**npm (`package.json`):**

```bash
rg -n '"preinstall"|"install"|"postinstall"' package.json
```

Also inspect `package-lock.json` for `hasInstallScript: true` entries, which is npm's own signal that a dependency runs install-time code.

**Python:**

- `setup.py`: look for a `cmdclass={'install': ...}` override or custom `install` subclass that runs arbitrary code at install time.
- `pyproject.toml`: check `[build-system]` build hooks and any custom `build-backend` that points at a project-local module.

```bash
rg -n "cmdclass\s*=\s*\{" setup.py 2>/dev/null
rg -n "build-backend|build-hook" pyproject.toml 2>/dev/null
```

### Maintainer change check

A sudden maintainer change (especially adding a new uploader without removing the previous one, or silently swapping) is a classic supply-chain-attack precursor.

**npm:**

```bash
npm view <pkg> maintainers
```

Compare against a prior known maintainer set (e.g., the maintainers at the last reviewed commit, or the maintainers on the package's GitHub repository `CODEOWNERS`). Any new maintainer warrants a look at their npm account age and other published packages.

**PyPI:**

PyPI does not expose maintainers via the public JSON API with the same granularity, but the release history does reveal uploader changes. Inspect:

```bash
curl https://pypi.org/pypi/<pkg>/json | jq '.releases | to_entries | .[].value[0] | {version: .filename, upload_time: .upload_time, uploader: .uploader}'
```

Flag any release whose `uploader` differs from the established uploader(s).

---

## Lieutenant prompt (Pass 0)

The orchestrator dispatches Pass 0 by calling `Task` with this prompt body, with the bound variables (`area`, `target_path`, `commit_sha`, `mission_dir`, `jury_slot_hint`) substituted in. Quote it verbatim into the `prompt` parameter; do NOT ask the sub-worker to read this section out of `SKILL.md` (it is also given the same SKILL.md context, but the orchestration contract is to pass the prompt explicitly).

> You are a security lieutenant assigned to a single audit area. You report to a deep-security-review orchestrator that runs a heterogeneous multi-model jury. You are running on ONE specific jury-member model (Claude Opus, GPT, or Gemini); other lieutenants on other areas may run on different models. Your seed list will be filtered downstream — false positives are FINE, false negatives are NOT.
>
> ### Inputs
>
> - `area` — the audit area assigned to you (e.g., `authentication`, `deserialization`, `IaC`).
> - `target_path` — local checkout of the target repo at the pinned commit.
> - `commit_sha` — the pinned commit.
> - `mission_dir` — path to write your output: `<mission_dir>/_run-archive/lieutenants/<area>/LIEUTENANT.md`.
> - `graph_scope` — OPTIONAL (§5.6). When present, it carries `mode` (`seed` or `filter`), `graph_nodes[]` (in-scope files/symbols for your area), and `graph_paths[]` (source→sink chains for your area). Absent on whole-repo runs.
>
> ### Execution mode — nested-`Task` detection and fallback
>
> When you have been dispatched as a **Phase-2 lieutenant coordinator** covering multiple audit areas (the lieutenant pattern in §6 Pass 0 — "When to use the lieutenant pattern"), your intended execution is to spawn one `Task` per audit area and run the sub-workers in parallel. Before doing any enumeration work across areas, detect which execution mode you are in.
>
> **Step 0 — detect.** Check whether the `Task` tool is present in your current tool list. This is a one-line check: if `Task` is callable, you are in nested-dispatch mode; otherwise you are in fallback mode.
>
> **Nested-dispatch mode (preferred; `Task` available).** Proceed as documented today:
>
> - Spawn one `Task` per audit area, `complexity: heavy`, each running this same lieutenant prompt rendered with per-area bound variables (`area`, `target_path`, `commit_sha`, `mission_dir`, `jury_slot_hint`).
> - Collect the per-area `LIEUTENANT.{md,json}` outputs and either run synthesis yourself or hand off to a dedicated synthesis worker.
>
> **Fallback mode (`Task` NOT available).** **Do NOT silently fall back to running each per-area sub-worker prompt inline in your own context window.** Inline execution compresses per-area depth to skeleton output (no `file:LINENO` anchors, no 5-10 line code quotes, `needs_context: true` everywhere) and has been shown to lose real findings (see rationale below). Instead:
>
> 1. Stop. Do NOT start enumerating candidates inline across all areas.
> 2. Emit a **structured handoff** back to the orchestrator and exit. The handoff (JSON object written to `<mission_dir>/_run-archive/lieutenants/HANDOFF.json`, and echoed in your Markdown reply) MUST contain, for each area in scope, one record with:
>    - `area` — short canonical name (e.g., `indices-mapping`).
>    - `target_path` — local checkout path at the pinned commit.
>    - `commit_sha` — the pinned commit.
>    - `code_roots` — list of subpaths to enumerate (copied from `areas.json`).
>    - `must_cover` — list of finding-class IDs, file paths, or endpoint IDs that MUST appear in the sub-worker's seed output (copied from `areas.json` and from any prior-run coverage matrix the orchestrator supplied).
>    - `focus` — one-line description of the area's scope (copied from `lieutenant_focus` in `areas.json`).
>    - `target_output_size` — recommended rough floor per area (e.g., `>= 15 candidates, >= 1200 words in LIEUTENANT.md`, plus the matching `LIEUTENANT.json` sidecar).
>    - `jury_slot_hint` — jury-member family to use (copied from `areas.json`).
> 3. The orchestrator (which owns `Task`) then dispatches the N sub-workers respecting the `BATCH_SIZE_LIEUTENANTS` cap from §5.4. If N > cap, batches serially. Each sub-worker runs this lieutenant prompt on ONE area with `Task` unavailable but with scope small enough that inline context fits.
> 4. After the sub-worker outputs are written to `_run-archive/lieutenants/<area>/LIEUTENANT.{md,json}`, the orchestrator either resumes you for synthesis or hands off to a dedicated synthesis worker.
>
> **Rationale.** The v2 elasticsearch audit (see `deep-audits/elastic-elasticsearch-v2/COMPARISON.md` §5 and `phase2/PHASE2-COMPLETE.md` §A1) empirically validated this failure mode: when a Phase-2 lieutenant silently ran 10-15 per-area prompts inline in a single context window, per-area depth compressed to skeleton output and ~22 v1 findings (5 HIGH) were lost across four areas (`indices-mapping`, `snapshot-repo`, `scripting-painless`, `SQL/ES|QL/EQL`). The nested-`Task` path remains the preferred default; this fallback is an additive safety net so the lieutenant pattern stays robust across runtime toolset variations.
>
> If you were dispatched on a SINGLE area (the flat per-area dispatch in §6 Pass 0 step 4), ignore this section and proceed to **Mandate** — you have no sub-workers to spawn.
>
> ### Mandate
>
> Be **over-inclusive**. The orchestrator runs eight downstream filters on every candidate (line-anchor verify, vendor prior-art, deep prior-art, dataflow + reachability, exploit construction, patch construction, negative-space, adversarial red-team). False positives at this stage will be filtered. False negatives will NOT be recoverable. Bias toward listing.
>
> ### Procedure
>
> 0. **Graph scope (only if `graph_scope` is present).** In `seed` mode: enumerate every file/symbol in `graph_nodes` FIRST and treat each `graph_paths` chain as a high-priority candidate, THEN continue the normal over-inclusive sweep of the rest of `<area>` (nothing is excluded). In `filter` mode: enumerate ONLY the files/symbols/paths in `graph_nodes`/`graph_paths` for `<area>`; do not range outside them. For every candidate you derive from a `graph_paths` chain, record its `graph_path_id` so Pass 4 can reuse the chain as a taint skeleton. If `graph_scope` is absent, ignore this step and proceed to step 1.
> 1. Enumerate every file in the target repo that pertains to `<area>`. Use `Glob` and `Grep` aggressively. Do not skip vendored code unless the user excluded it in scope. Do not skip tests — vulnerable test fixtures and test-only auth bypasses are real findings. _(In `filter` mode, "every file that pertains to `<area>`" is bounded by `graph_nodes`/`graph_paths` per step 0.)_
> 2. For each candidate, capture:
>    - **id** — placeholder format `<area>-<seq>`; orchestrator will canonicalize.
>    - **file_line** — `path/to/file:LINENO` at the pinned commit.
>    - **code_quote** — 5-10 lines around the cited line, copy-pasted verbatim.
>    - **proposed_severity** — your initial guess: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `INFO`. Bias toward NOT under-rating.
>    - **proposed_confidence** — `HIGH`, `MEDIUM`, `LOW`. Lieutenants are over-inclusive; LOW is fine.
>    - **trigger** — one paragraph: what condition fires this issue?
>    - **impact** — one paragraph: what happens if it fires?
>    - **suspected_class** — short tag, e.g., `sqli`, `path-traversal`, `prototype-pollution`, `weak-jwt-alg`, `missing-authz`, `ssrf`, `redos`.
>    - **owasp_mapping** — optional: single STRIDE letter (`S`/`T`/`R`/`I`/`D`/`E`), OWASP Top 10 code (`A01`–`A10`), or OWASP LLM Top 10 code (`LLM01`–`LLM10`). Example: `"owasp_mapping": "A03"`. Omit the field if unclear; downstream consumers treat it as optional so backward compat is preserved.
>    - **prior_art_hint** — optional: any CVE / CWE / class identifier you suspect this matches. Downstream Pass 2/3 will validate.
>    - **needs_context** — bool; set true if you cannot confirm without reading callers, type info, or runtime context. Orchestrator will recurse via §7.
> 3. Be especially aggressive about:
>    - Implicit trust boundaries (e.g., "internal" routes that are actually externally reachable through a proxy).
>    - Sanitizers that are partially applied (e.g., applied on one path but not another).
>    - Type-narrowing or runtime-only invariants that the type system does not enforce.
>    - Configuration-dependent behavior (e.g., a flag that disables a check in production).
>    - Anything that smells like a refactor halfway through (one branch updated, the sibling branch not).
> 4. For "wide" areas like Authorization or API surface, do NOT cap the candidate count. List every endpoint that does not have a verified authz check. The orchestrator de-dupes downstream.
> 5. Output `LIEUTENANT.md` with one Markdown section per candidate. Also emit a JSON sidecar `LIEUTENANT.json` (array of candidate records) in the same directory — the orchestrator parses this for finding ID assignment.
>
> ### Anti-patterns to avoid
>
> - Do NOT pre-filter for novelty. "This is just CVE-XXXX" is not a reason to skip — the orchestrator handles prior-art tagging in Pass 2.
> - Do NOT compress multiple distinct issues into one finding. One issue per candidate. Variants are separate.
> - Do NOT skim. Open each cited file, read the surrounding code, confirm the file:line is real.
> - Do NOT cite line ranges; cite a single anchor line and quote 5-10 lines around it.
>
> ### Output format
>
> Markdown sections of the form:
>
> ````
> ## <area>-001 — <short title>
>
> - **File:line:** `path/to/file:42`
> - **Proposed severity:** HIGH
> - **Proposed confidence:** MEDIUM
> - **Suspected class:** sqli
> - **OWASP mapping:** A03            <!-- optional: STRIDE letter, A01-A10, or LLM01-LLM10 -->
> - **Needs context:** false
> - **Prior art hint:** CWE-89; possible duplicate of GHSA-xxxx-xxxx (unverified)
>
> ### Code
> ```<lang>
> <5-10 line quote>
> ````
>
> ### Trigger
>
> <one paragraph>
>
> ### Impact
>
> <one paragraph>
> ```
>
> When done, return the path to `LIEUTENANT.md` and `LIEUTENANT.json` to the orchestrator. The orchestrator collects, de-dupes, and assigns canonical IDs.
>
> #### Fallback-mode output (no-`Task` handoff)
>
> If you exited early under the fallback branch of **Execution mode — nested-`Task` detection and fallback** above, you do NOT emit per-candidate sections. Instead emit ONLY the handoff manifest so the orchestrator can dispatch sub-workers directly:
>
> - Write `<mission_dir>/_run-archive/lieutenants/HANDOFF.json` with shape:
>
> ```json
> {
>   "mode": "no-task-fallback",
>   "reason": "Task tool not present in lieutenant toolset",
>   "areas": [
>     {
>       "area": "indices-mapping",
>       "target_path": "/path/to/repo",
>       "commit_sha": "<sha>",
>       "code_roots": ["server/src/main/java/org/elasticsearch/index/mapper/"],
>       "focus": "Mapping parser surface, field-type coercion, dynamic templates.",
>       "must_cover": ["CVE-2024-xxxx", "server/.../MapperService.java"],
>       "target_output_size": ">=15 candidates, >=1200 words in LIEUTENANT.md plus matching LIEUTENANT.json",
>       "jury_slot_hint": "opus"
>     }
>   ]
> }
> ```
>
> - In your Markdown reply to the orchestrator, include: (a) the absolute path to `HANDOFF.json`, (b) the count of areas in `areas[]`, and (c) a one-line statement that you exited under fallback mode so the orchestrator does NOT mistake an empty `LIEUTENANT.md` for a successful run.
> - Do NOT write `LIEUTENANT.md` / `LIEUTENANT.json` under any `<area>/` directory in fallback mode — those outputs are produced by the sub-workers the orchestrator dispatches, not by you.

---

## Jury execution (file-free)

The severity-triage jury (§3) and the escalation-tier reviewers (§5.7 / Passes 4, 5, 8) run as **`drool exec` processes pinned to a specific model**, not as `Task` subagents. This is the only way to get genuine cross-family judgement: a `Task` subagent always inherits the orchestrator's model (its drool `model:` frontmatter), so a `Task`-only jury is homogeneous.

### Command template

Each juror / reviewer is one non-interactive `drool exec` invocation, run from the shell (Execute tool). It pins the model and forces machine-readable output:

```bash
drool exec -m "<model-id>" -o json --auto low \
  "<self-contained prompt with the finding's code evidence + claim inlined>"
```

- `-m <model-id>` pins the family/model (the ids in the §3 table). This is exactly what a `Task` cannot do.
- `-o json` makes the run emit a single JSON envelope on stdout; the orchestrator reads the final assistant message from that envelope, then parses the juror's own JSON verdict out of that message.
- `--auto low` keeps the juror from taking actions; the prompt also forbids tools and writes. For long prompts use `-f <tmp-prompt-file>` instead of the positional argument (a transient prompt file is fine — "file-free" means no per-juror drool config/frontmatter files, which are what pin a `Task`'s model).
- The prompt is **self-contained and low-context**: inline only the code evidence (file:line + 5–10 lines), the one-line claim, and the suspected class. Do NOT include upstream verdicts, other jurors' opinions, or who found it — independence is the whole point.
- Jurors are read-only: they never touch the mission dir. The orchestrator captures stdout and persists the verdict.

### Severity-triage juror prompt (Slots A/B/C — run verbatim, one model id each)

> You are an independent security severity rater. You are given ONE candidate finding in isolation. You do not know who found it or what any other reviewer concluded. Judge only from the evidence below.
>
> Inputs (inlined by the orchestrator): `claim` (one sentence), `suspected_class`, `file_line` (at the pinned commit), `code_evidence` (5–10 verbatim lines around the cited line).
>
> Task:
>
> 1. Decide whether the evidence plausibly supports the claimed vulnerability class at all.
> 2. Rate the severity you would assign IF it is real and reachable: CRITICAL / HIGH / MEDIUM / LOW / INFO. Use CVSS intuition (impact × exploitability), NOT the claimant's proposed severity.
> 3. Recommend: ESCALATE (worth deeper dataflow/exploit/red-team spend), REPORT-AS-IS (real but not worth deeper spend), or DROP-TO-INFO (not a real/material issue).
> 4. State your false-positive risk for this claim.
>
> Output — print EXACTLY one JSON object and nothing else:
>
> ```json
> {
>   "severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO",
>   "recommendation": "ESCALATE|REPORT-AS-IS|DROP-TO-INFO",
>   "false_positive_risk": "high|med|low",
>   "rationale": "<1-3 sentences, grounded in the code evidence>"
> }
> ```
>
> Hard rules: judge ONLY the inlined evidence; do not ask for more (if it is insufficient, say so in `rationale`, set `false_positive_risk: high`, and rate conservatively). No network, no file writes, no tools. Output the JSON object only.

### Parallel launch + parse

1. Resolve the three model ids (§3 table) available in this environment; apply the fallback order and record any substitution in `run.md`.
2. Launch all three `drool exec` calls **in parallel** (background each and `wait`, or one concurrent command). Respect `BATCH_SIZE_JURY_FINDINGS` and `MAX_CONCURRENT_TASKS` from §5.4.
3. For each process: read stdout, extract the final assistant message from the `-o json` envelope, then parse the juror's JSON verdict out of it. If a juror's output is unparseable, retry once; if it still fails, treat it as ABSTAIN and substitute a fallback model — never consolidate fewer than three usable verdicts.
4. Consolidate per §3 (median severity + escalate/drop gate); write all three verdicts + the decision to `_run-archive/judge-jury.json[<finding-id>]`.

### Degradation path (no `drool exec` available)

If the session cannot spawn `drool exec` (no binary on PATH, no Execute tool, or unauthenticated), the orchestrator MUST NOT silently fall back to a homogeneous jury. Instead:

- Run the jury as `Task` subagents as a **documented degradation**: three `Task` jurors that share one model, with per-juror prompt framing varied (neutral / skeptical / adversarial) to decorrelate, and record `jury_mode: "degraded-single-family"` plus the reason in `run.md` and every finding's `provenance.json[jury]`.
- This degradation is explicitly inferior (no cross-family signal) and MUST be surfaced in the §14 handoff so the user knows the multi-model guarantee did not hold.

---

## Judge floor prompts (Passes 1–3)

The **mandatory floor** of the judge. Every candidate finding from Pass 0 runs through these passes in order: Pass 1 (line-anchor) is performed **inline by the orchestrator** (current session) — no jury; Passes 2–3 (vendor + deep prior-art) are performed by a **single delegated prior-art worker** — prior-art research does not need multiple model families. The one multi-model jury (severity-triage) runs AFTER the floor, per §3, and gates the escalation tier. Passes 4, 5, 8 (the escalation tier) live in the **Judge escalation prompts (Passes 4, 5, 8)** section below and fire only on the triggers documented in §5.7.

Pass 1 below is written as an orchestrator self-instruction (run it directly; do not dispatch a jury). Passes 2–3 are written as a single worker prompt. Neither uses the 3-juror dispatch; that is reserved for the severity-triage jury (see **Jury execution (file-free)** above).

### Pass 1 — Line-anchor verification (`line-anchor`)

> **Run this inline, in the current orchestrator session — do NOT dispatch a jury.** This is a cheap, deterministic file check the orchestrator performs itself for every candidate finding from Pass 0 (lieutenant enumeration). Verdicts are written straight to `_run-archive/judge-pass1.json`.
>
> #### Inputs
>
> - `finding_record` — the candidate finding JSON (id, title, file_line, code_quote, proposed_severity, etc.).
> - `target_path` — local checkout at the pinned commit.
> - `commit_sha` — the pinned commit.
>
> #### Goal
>
> Confirm (or refute) that the cited file:line at the pinned commit actually contains the claimed pattern. This pass does NOT judge severity, reachability, or exploitability — those are later passes. This pass only judges:
>
> > "Does the code at file:line match what the finding claims?"
>
> #### Procedure
>
> 1. Open the cited file at the pinned commit (read at SHA, not at HEAD).
> 2. Quote 5-10 lines centered on the cited line VERBATIM into your verdict.
> 3. Compare your quote with the lieutenant's `code_quote`. They should match. If not, that's a strong DISPUTED signal.
> 4. Independently assess whether the claimed pattern is in fact present at the cited line.
> 5. Classify (per the **Methodology reference** section's Disposition Vocabulary above):
>    - `CONFIRMED` — code at file:line matches the claim. Pattern is present.
>    - `DISPUTED` — code at file:line does NOT match. The pattern is absent, the line is wrong, or the lieutenant misread.
>    - `NEEDS-CONTEXT` — file:line exists, the code looks plausibly relevant, but you cannot confirm without context (caller, type info, config). The orchestrator will recurse via §7.
>    - `CONFIRMED-BY-DESIGN` — code at file:line matches the claim, but the behavior is a documented default / explicit design choice. Technically correct but ineligible for promotion.
>
> #### Output (one JSON object back to the orchestrator)
>
> ```json
> {
>   "finding_id": "auth-001",
>   "model": "<your model name and version>",
>   "verdict": "CONFIRMED" | "DISPUTED" | "NEEDS-CONTEXT" | "CONFIRMED-BY-DESIGN",
>   "evidence_quote": "<5-10 lines from the file>",
>   "rationale": "<2-4 sentences explaining the verdict>",
>   "context_needed": ["<list of files/symbols you would need if NEEDS-CONTEXT>"]
> }
> ```
>
> #### Hard rules
>
> - Do NOT speculate about exploitability. That is Pass 5.
> - Do NOT search for prior CVEs. That is Pass 2.
> - Do NOT trace dataflow. That is Pass 4.
> - Stay focused on: "is the cited code at the cited line, and does it match the claim?"
> - If the lieutenant's `code_quote` has been edited or paraphrased rather than copy-pasted: tag DISPUTED with rationale.
> - If the file does not exist at the pinned commit: tag DISPUTED.
> - If the line number is past EOF: tag DISPUTED.

### Pass 2 — Vendor prior-art screen (`vendor-prior-art`)

> You are the single prior-art worker (one delegated `Task` or `drool exec` worker — prior-art research does NOT need a multi-model jury). You run the vendor screen (this Pass 2) and then the deep screen (Pass 3 below) for each finding the orchestrator hands you.
>
> #### Goal
>
> Determine whether this finding (or a near-sibling) has already been disclosed by the vendor or in a public advisory. The output is a TAG, not a delete. Even if a finding duplicates a known CVE, the orchestrator KEEPS it in the report — duplicates of real bugs are still real bugs. You are reducing novelty score, not correctness score.
>
> #### Inputs
>
> - `finding_record` — full finding JSON, including file_line, code_quote, suspected_class, proposed_severity.
> - `target_repo` — repo URL or local path.
> - `commit_sha` — the pinned commit.
>
> #### Procedure
>
> Run ~25-30 queries across the following sources. If a source is unavailable to you, document the gap; do not skip silently.
>
> 1. **Vendor security page.** Look for the project's official security advisory page (e.g., GitHub Security tab, vendor's security.txt, the project's "security" page on its docs site).
> 2. **GHSA database** (GitHub Security Advisories) for the project and any direct dependencies cited in the finding.
> 3. **NVD / CVE database** for the project name and CWE class.
> 4. **MITRE CWE catalog** for the suspected class.
> 5. **HackerOne, Bugcrowd, Intigriti public disclosures** searchable via their public reports endpoints.
> 6. **Recent commits (~12 months)** touching the cited file or symbol. A recent "fix" commit on the same path is strong prior art evidence.
> 7. **Recent tags / release notes** for the project.
> 8. **Vendor changelog / NEWS file.**
> 9. **Sibling-class advisories in similar libraries.** (e.g., for a YAML deserialization issue: PyYAML, ruamel, snakeyaml, gopkg.in/yaml.v2 advisories.)
> 10. **Public bug trackers** (issues, mailing lists) for the suspected class.
>
> #### Classify
>
> - `REMAINS-NOVEL` — exhaustive search returned no relevant prior art.
> - `DEMOTE-DUPLICATE` — exact prior CVE / GHSA / advisory exists for this code path. **Tag it with the prior identifier; do NOT remove the finding.**
> - `SIBLING-OF-PRIOR` — prior CVE/GHSA exists in the same class but at a different code path or in a different version range. Tag it; keep the finding.
> - `DEMOTE-KBD` — known-bad-detection: the lieutenant's pattern is a notorious false-positive matcher in this codebase or class (e.g., SAST flagging `eval` in a type-check helper). Tag DISPUTED with rationale.
>
> #### Output
>
> ```json
> {
>   "finding_id": "auth-001",
>   "model": "<your model+version>",
>   "verdict": "REMAINS-NOVEL" | "DEMOTE-DUPLICATE" | "SIBLING-OF-PRIOR" | "DEMOTE-KBD",
>   "prior_art": [
>     {"type": "GHSA" | "CVE" | "vendor-advisory" | "h1-disclosure" | "commit" | "blog" | "paper",
>      "id": "GHSA-xxxx-xxxx-xxxx" | "CVE-2023-NNNN" | "<URL or commit SHA>",
>      "url": "<canonical link>",
>      "summary": "<one sentence>",
>      "match_strength": "EXACT" | "STRONG" | "WEAK"}
>   ],
>   "queries_run": <int>,
>   "rationale": "<2-4 sentences>"
> }
> ```
>
> #### Hard rules
>
> - Run AT LEAST 25 queries. If you ran fewer, say why.
> - Do not just trust the lieutenant's `prior_art_hint` — re-verify it. Lieutenants over-include hints.
> - Distinguish "the same bug" from "a related bug." `DEMOTE-DUPLICATE` requires near-exact match (same code path, same class). `SIBLING-OF-PRIOR` is for related but distinct.
> - A finding can be DEMOTE-DUPLICATE and still be promoted by the orchestrator — the orchestrator keeps duplicates of real bugs. You are tagging, not deleting.
> - Network operations are READ-ONLY. You can fetch advisory pages, GHSA JSON, NVD JSON, public blog posts. You may NOT register, file, comment, or transmit anything.

### Pass 3 — Deep prior-art screen (`deep-prior-art`)

> You are the same single prior-art worker continuing from Pass 2 (no jury here either).
>
> #### Goal
>
> Build research breadcrumbs. Where does this CLASS of vulnerability appear in the literature? What variants exist? What did past patch maintainers learn from related CVEs? This pass enriches the finding with context — it does NOT promote or demote.
>
> #### Inputs
>
> - `finding_record` — full finding JSON.
> - `pass2_output` — the vendor prior-art tagging from Pass 2 (so you can build on it without duplicating effort).
>
> #### Procedure
>
> Run ~80-150 queries across:
>
> 1. **Sibling-class CVEs across other libraries / languages.** If the finding is "deserialization gadget chain in pickle," also search Java (XStream, Jackson), .NET (BinaryFormatter, ObjectStateFormatter), Ruby (Marshal, ERB), JS (node-serialize, Function constructor), Go (gob), PHP (unserialize).
> 2. **Academic papers.** Google Scholar, arXiv, USENIX Security, CCS, NDSS, IEEE S&P, ACM CCS proceedings.
> 3. **Conference talks.** Black Hat, DEF CON, OWASP Global, RSA, Chaos Communication Congress.
> 4. **Security blog posts.** Look for technical posts (not marketing) from Project Zero, GitHub Security Lab, Google Bug Hunters, JFrog Security Research, Sonar Source, Snyk, Semgrep, Trail of Bits, NCC Group, Doyensec, Include Security, Latacora, Cure53.
> 5. **Language / framework deep dives.** Maintainer-written postmortems, retrospectives, changelogs that discuss why a defense was added.
> 6. **CWE catalog page** for the suspected class — read it; capture related/parent/child CWEs.
> 7. **OWASP Top 10 / OWASP LLM Top 10 / OWASP API Top 10** mapping for context if relevant.
> 8. **Reference implementations** of the defense (e.g., RFC text for the relevant protocol, language standards documents).
>
> #### Classify
>
> This pass produces a research linkage block, NOT a verdict. Output structure:
>
> ```json
> {
>   "finding_id": "auth-001",
>   "model": "<your model+version>",
>   "prior_art_deep": [
>     {
>       "type": "academic_paper" | "blog" | "talk" | "rfc" | "spec" | "cwe" | "sibling_cve" | "framework_doc",
>       "title": "<title>",
>       "authors": "<authors or org>",
>       "venue": "<USENIX 2021 | Black Hat USA 2019 | Project Zero blog | ...>",
>       "url": "<canonical link>",
>       "summary": "<2-3 sentences on what's relevant>",
>       "applicability": "DIRECT" | "ANALOGOUS" | "BACKGROUND"
>     }
>   ],
>   "research_synthesis": "<one paragraph: what does the literature say about this class, what defenses are known, what variants are common>",
>   "queries_run": <int>
> }
> ```
>
> #### Hard rules
>
> - Run AT LEAST 80 queries. Aim for 150 for any non-trivial finding.
> - Do NOT cite Wikipedia as primary; use it only as a starting point for navigating to authoritative sources.
> - Distinguish primary sources (CVE pages, advisories, original disclosures, RFC text, spec text) from secondary (blogs, talks). Cite both.
> - If a class is well-studied (e.g., SQL injection, XSS, prototype pollution), prefer the canonical reference (Stuttard's textbook, OWASP page, Halfond et al. survey) plus 5-10 modern variants.
> - Network operations are READ-ONLY. No registrations, no posts, no submissions.

---

## Judge escalation prompts (Passes 4, 5, 8)

The **escalation tier** of the judge. Fires only on the triggers documented in §5.7; not gating on promotion. Pass 4 (dataflow/reachability) and Pass 5 (exploit construction) each run in two phases (tracer/constructor + reviewers); Pass 8 (red-team disprove) runs on a single adversarial reviewer.

The mandatory floor (Passes 1, 2, 3) lives in the **Judge floor prompts (Passes 1–3)** section above. Lieutenant enumeration (Pass 0) lives in the **Lieutenant prompt (Pass 0)** section above.

The escalation tier runs only on findings the severity-triage jury (§3) marked ESCALATE. Each escalation reviewer is a **`drool exec -m <model>` process** (file-free, model-pinned — see **Jury execution (file-free)** above), NOT a `Task` subagent, so the tracer / constructor and its reviewers can be pinned to different model families for genuine cross-family critique. Rotate the pinned model per role so the reviewer is never the same family as the tracer / constructor. Quote the relevant Pass subsection verbatim into each `drool exec` prompt; reviewers form verdicts independently and do NOT communicate.

### Pass 4 — Dataflow & reachability (`dataflow`)

> The orchestrator runs Pass 4 as model-pinned `drool exec` processes (see **Jury execution (file-free)**) in TWO phases for each escalated finding:
>
> - **Phase A (one process, the "tracer"):** does the heavy taint trace and writes `findings/<finding-id>/dataflow.md`.
> - **Phase B (two processes on different model families, "reviewers"):** independently read the trace, critique it, and verdict on reachability.
>
> The orchestrator tells you which role you are playing (`role: tracer` or `role: reviewer`) and pins a different model family for the reviewers than the tracer.
>
> #### Phase A — Tracer role
>
> ##### Goal
>
> Produce a complete forward and backward taint trace for the finding. List every transformation, every sanitizer, every branch, every type narrowing. Do not skip steps.
>
> ##### Procedure
>
> 1. **Source identification.** What is the untrusted source? Possible sources: HTTP request body, URL params, headers, cookies, file upload, environment variable, file content, message-queue payload, RPC argument, IPC message, websocket frame, DB row from a multi-tenant table, OAuth token claims, JWT claims (if signature not verified), filename, archive entry, downstream-service response.
> 2. **Sink identification.** What is the vulnerable sink? Examples: SQL query string, shell command, file path, eval/exec, deserializer input, HTML rendered to a page, JSON deserializer, regex compiler, DNS lookup, outbound HTTP, log line.
> 3. **Forward trace.** Starting from each source, trace how a value flows to the sink:
>    - Every assignment.
>    - Every function call (record both directions: argument-in and return-out).
>    - Every conditional branch (does the condition narrow the type? does it filter the value?).
>    - Every sanitizer (what does it remove, what does it leave?).
>    - Every encoder/decoder (what does it produce, what's the inverse?).
>    - Every framework hook (middleware, decorator, interceptor) in the path.
> 4. **Backward trace.** Starting from the sink, list every caller. For each caller, list its callers. Continue until you hit either: (a) an entry point reachable from untrusted input, or (b) a barrier (auth check, allowlist, internal-only assertion, signed payload check) that blocks untrusted input.
> 5. **Sanitizer audit.** For every sanitizer encountered, ask: is it correct for THIS sink? A sanitizer that escapes for HTML is wrong for SQL. A sanitizer that escapes for shell-single-quotes is wrong for shell-double-quotes. A sanitizer that strips `..` is bypassable with `....//` in many filesystems.
> 6. **Configuration / feature-flag audit.** Is any part of the path gated behind a flag? Is the flag enabled by default? Is the flag enabled in any common deployment?
>
> ##### Output (Phase A)
>
> Write `findings/<finding-id>/dataflow.md` (the orchestrator creates the per-finding folder with `mkdir -p findings/<finding-id>/` before you begin):
>
> ```
> # Dataflow trace — <finding id>: <title>
>
> ## Source candidates
> - <source 1: file:line, type, where it enters the system>
> - ...
>
> ## Sink
> - <sink: file:line, what makes it dangerous, what input shape would trigger>
>
> ## Forward trace
> 1. <source 1> -> <function A>:<line> [transform: <name>]
> 2. <function A> -> <function B>:<line> [no transform]
> 3. ...
> N. -> <sink>:<line>
>
> ## Sanitizers encountered
> - <sanitizer 1>: at <file:line>; removes <X>; bypassable if <Y>.
> - ...
>
> ## Backward trace from sink
> - <sink> caller: <file:line>
> - <caller's caller>: <file:line>
> - ...
> - Entry point: <route definition / handler registration / event subscription>
> - Reachability: <REACHABLE-FROM-UNTRUSTED | REACHABLE-INTERNAL-ONLY | UNREACHABLE>
>
> ## Configuration & flags
> - <flag X>: <default state, where set>
> - ...
>
> ## Open questions for reviewers
> - <bullet list of points where the tracer is uncertain>
> ```
>
> Then return to the orchestrator a summary JSON:
>
> ```json
> {
>   "finding_id": "auth-001",
>   "model": "<your model+version>",
>   "role": "tracer",
>   "tracer_verdict": "REACHABLE-FROM-UNTRUSTED" | "REACHABLE-INTERNAL-ONLY" | "UNREACHABLE",
>   "trace_path": "findings/<finding-id>/dataflow.md",
>   "open_questions": ["..."]
> }
> ```
>
> #### Phase B — Reviewer role
>
> ##### Goal
>
> Independently critique the tracer's trace. Do NOT redo it; read it, follow the citations, and challenge it.
>
> ##### Procedure
>
> 1. Open `findings/<finding-id>/dataflow.md`.
> 2. For each step in the forward trace, open the cited file and verify the step. If a sanitizer is claimed at a step, open it and verify what it actually does.
> 3. For the backward trace, follow the callers and verify the entry point.
> 4. Form your independent verdict on reachability.
>
> ##### Output (Phase B)
>
> ```json
> {
>   "finding_id": "auth-001",
>   "model": "<your model+version>",
>   "role": "reviewer",
>   "verdict": "REACHABLE-FROM-UNTRUSTED" | "REACHABLE-INTERNAL-ONLY" | "UNREACHABLE",
>   "agreements": ["<list of trace steps you confirmed>"],
>   "disagreements": ["<list of trace steps you challenge, with rationale>"],
>   "missed_paths": ["<paths the tracer missed, if any>"],
>   "rationale": "<2-4 sentences>"
> }
> ```
>
> #### Hard rules (both phases)
>
> - Trust nothing claimed by the tracer without verifying the citation. The whole point of the reviewer phase is independent challenge.
> - A "REACHABLE-INTERNAL-ONLY" verdict requires a clean argument that NO untrusted input can reach the sink. Suspicion that an internal API is exposed via a proxy or framework default is enough to push to REACHABLE-FROM-UNTRUSTED.
> - An "UNREACHABLE" verdict requires the strongest evidence: dead code, gated behind a never-true flag, never registered, behind a never-routed handler.
> - If the trace requires runtime behavior to confirm (e.g., depends on a config file's content, depends on a database state): tag with `NEEDS-CONTEXT` and the orchestrator runs §7 recursion.

### Pass 5 — Exploit construction (`exploit`)

> Like Pass 4, this pass runs as model-pinned `drool exec` processes (see **Jury execution (file-free)**) in two phases:
>
> - **Phase A (constructor):** one process constructs the exploit (or attempts to and fails).
> - **Phase B (reviewers):** two processes on different model families independently judge whether the exploit is sound.
>
> The orchestrator tells you your role and pins a different model family for the reviewers than the constructor.
>
> #### Phase A — Constructor role
>
> ##### Goal
>
> Produce a minimal exploit (or sketch) that demonstrates the finding. If no exploit can be constructed even in principle, declare it `THEORETICAL` with rationale.
>
> ##### Procedure
>
> 1. From the Pass 4 dataflow trace, identify the simplest source that reaches the sink.
> 2. Determine the minimum input shape that triggers the vulnerability.
> 3. Specify preconditions:
>    - Network position required (external attacker, authenticated user, lateral attacker, supply-chain attacker, local attacker, physical attacker).
>    - Privileges held by the attacker (none, low-priv user, admin, etc.).
>    - State assumptions (what must be true about the system before the exploit fires).
> 4. Construct the payload:
>    - Exact bytes / strings / URL / sequence of requests.
>    - For web: HTTP request lines including headers, cookies, body.
>    - For RPC: method name + arguments.
>    - For file-based: filename, archive structure, file content.
>    - For config: env vars, file paths.
> 5. Specify the observable:
>    - What does the attacker see on success? (response content, side-effect, timing signal, out-of-band signal, file contents read, command executed.)
> 6. Sketch automation (optional): a one-page `curl` script, Python snippet, or Burp request.
> 7. Identify the realistic attacker profile (script-kiddie, opportunistic mass-scanner, targeted attacker, nation-state-grade attacker, insider).
>
> ##### Output
>
> Write `findings/<finding-id>/exploit.md`:
>
> ```
> # Exploit sketch — <finding id>: <title>
>
> ## Preconditions
> - Network position: <external | auth-user | etc.>
> - Privileges: <none | low | admin>
> - State: <what must be true>
>
> ## Input
> <exact payload, code-fenced>
>
> ## Walkthrough
> <step-by-step: 1) attacker sends X; 2) server does Y; 3) sink fires Z>
>
> ## Observable on success
> <what the attacker sees>
>
> ## Realistic attacker profile
> <which class of attacker>
>
> ## Verdict
> EXPLOITABLE | THEORETICAL | UNEXPLOITABLE
>
> ## Limitations / failure modes
> <bullet list>
> ```
>
> Then return to the orchestrator:
>
> ```json
> {
>   "finding_id": "auth-001",
>   "model": "<your model+version>",
>   "role": "constructor",
>   "constructor_verdict": "EXPLOITABLE" | "THEORETICAL" | "UNEXPLOITABLE",
>   "exploit_path": "findings/<finding-id>/exploit.md",
>   "preconditions_count": <int>
> }
> ```
>
> #### Phase B — Reviewer role
>
> ##### Goal
>
> Independently judge whether the constructor's exploit is sound. Reproduce the logic in your head; do NOT actually run the exploit (PoC execution happens only in §10, gated by user consent).
>
> ##### Procedure
>
> 1. Read `findings/<finding-id>/exploit.md`.
> 2. For each precondition, ask: is this realistically achievable? An exploit that requires the attacker to first guess a 256-bit secret is not exploitable.
> 3. For the payload, ask: would this actually trigger the sink? Walk through it byte-by-byte.
> 4. For the observable, ask: is the observable real, or imagined?
> 5. Independent verdict.
>
> ##### Output
>
> ```json
> {
>   "finding_id": "auth-001",
>   "model": "<your model+version>",
>   "role": "reviewer",
>   "verdict": "EXPLOITABLE" | "THEORETICAL" | "UNEXPLOITABLE",
>   "agreements": ["..."],
>   "disagreements": ["..."],
>   "missing_preconditions": ["..."],
>   "rationale": "<2-4 sentences>"
> }
> ```
>
> #### Hard rules
>
> - Do NOT actually execute the exploit. Generation only.
> - A `THEORETICAL` verdict means the vulnerability is real but no realistic exploit can be constructed. Examples: timing oracle that requires 10^9 measurements; gadget chain that requires control of memory we don't control.
> - An `UNEXPLOITABLE` verdict means the vulnerability is NOT real after closer inspection (a sanitizer in fact blocks it, an internal invariant prevents the bad shape, etc.). This effectively demotes the finding.
> - Distinguish "complex but possible" (still EXPLOITABLE) from "impossible without unrealistic assumptions" (THEORETICAL).

### Pass 8 — Adversarial red-team disprove (`red-team`)

> This is the final pass. You are an adversarial reviewer running as a single model-pinned `drool exec` process (see **Jury execution (file-free)**). Your job is to disprove the finding.
>
> The orchestrator deliberately pins you to a model from a DIFFERENT family than (a) the lieutenant who proposed the finding and (b) the Pass 4 tracer. This is to defeat self-reinforcement.
>
> #### Goal
>
> > "Prove this finding is wrong."
>
> Find any reason the finding is not actually exploitable, not actually reachable, or not actually a vulnerability. Be hostile. Be skeptical. Look for:
>
> - Sanitizers we missed elsewhere in the path.
> - Type narrowings that exclude the bad input shape.
> - Runtime invariants that prevent the bad state.
> - Configuration / deployment context that disables the path.
> - Framework defaults that block the attack.
> - Implicit access controls (proxy, network ACL, mTLS, IP allowlist) that the audit context misses.
> - Mitigations external to the audited code that close the impact.
> - Misreadings of the code (the lieutenant misunderstood the type, the trace, or the API).
>
> #### Inputs
>
> You receive the FULL finding record:
>
> - File:line and code quote.
> - Pass 1-3 verdicts and prior art.
> - Pass 4 dataflow trace.
> - Pass 5 exploit sketch.
> - Provenance JSON to date.
>
> #### Procedure
>
> 1. Read every input. Be slow. Do not concede ground.
> 2. Construct the strongest disproof you can. Try multiple angles:
>    - The exploit precondition is unrealistic.
>    - The dataflow trace skipped a sanitizer at line N.
>    - The handler is registered behind an internal-only listener at network configuration time.
>    - The "untrusted" source is in fact mTLS-authenticated and only exposed to internal services.
>    - The framework auto-applies a defense the lieutenant missed.
>    - The exploit assumes a payload shape the parser rejects upstream.
>    - The "missing" check is in fact present in a base class, decorator, or middleware not cited.
> 3. If your disproof requires runtime evidence, escalate to the orchestrator: tag your verdict `RED-TEAM-INCONCLUSIVE-NEEDS-RUNTIME` and request §4 round-2 empirical tiebreaker.
> 4. If you cannot find a disproof: say so. Do not fabricate. The finding survives.
>
> #### Output
>
> ```json
> {
>   "finding_id": "auth-001",
>   "model": "<your model+version, MUST differ from proposer and tracer>",
>   "verdict": "RED-TEAM-DISPROVED" | "RED-TEAM-INCONCLUSIVE" | "RED-TEAM-INCONCLUSIVE-NEEDS-RUNTIME" | "RED-TEAM-SURVIVED",
>   "disproof_attempted": [
>     {"angle": "sanitizer-elsewhere", "details": "..."},
>     {"angle": "internal-only-handler", "details": "..."},
>     {"angle": "framework-default", "details": "..."}
>   ],
>   "strongest_doubt": "<your single best argument the finding might be wrong, even if it doesn't fully disprove>",
>   "rationale": "<2-4 sentences>"
> }
> ```
>
> #### Outcome semantics
>
> - `RED-TEAM-DISPROVED` — you found a clean, defensible reason the finding is wrong. The finding demotes to `DISPUTED-AFTER-ADVERSARIAL`. It remains in the report (in the disputed section), with your rationale attached.
> - `RED-TEAM-INCONCLUSIVE` — you raised real doubt but didn't fully disprove. The verdict stands but confidence drops. The doubt is logged.
> - `RED-TEAM-INCONCLUSIVE-NEEDS-RUNTIME` — your disproof requires runtime evidence not available statically. The orchestrator runs §4 round-2 empirical tiebreaker.
> - `RED-TEAM-SURVIVED` — you tried hard and could not disprove. The finding earns the highest confidence tier.
>
> #### Hard rules
>
> - Do NOT communicate with the original proposer or tracer. You are working from artifacts only.
> - Do NOT collude with the other jurors. You are a hostile reviewer; your job is to break the finding.
> - A "RED-TEAM-DISPROVED" verdict requires a CONCRETE, citable reason. "I am skeptical" is not enough; "the framework's default middleware rejects this content-type at line X of file Y" is enough.
> - A "RED-TEAM-SURVIVED" verdict requires you to have ATTEMPTED multiple angles. Document each attempt.
> - Bias toward "RED-TEAM-INCONCLUSIVE" when uncertain — don't disprove what you can't fully disprove, but don't survive what you didn't fully attack.
>
> #### Why this pass exists
>
> Earlier passes can collude — even with a heterogeneous jury, all three models read the same code with the same priors and can converge on the same wrong answer. This pass deliberately rotates models and inverts the prompt so that confirmation bias has nowhere to hide. Findings that survive Pass 8 have been challenged by an adversary who tried to break them and failed. That is the highest-confidence tier we produce.

---

## PoC generation

> **NEVER UPLOAD.** PoCs are local artifacts. They are not uploaded and not auto-submitted. Consent for PoC generation and execution was captured in the §1 AskUser at mission start; this stage runs non-interactively with no further prompts.

This section is referenced by §10. It governs how exploit scripts are generated, where they are stored, and how (if the user opted in) they are sandbox-executed.

### Activation

Driven entirely by §1.Q7. No AskUser call is emitted in this stage.

- `Skip PoC generation entirely` → do nothing in this section.
- `Generate scripts only (no execution)` → draft all scripts, never execute.
- `Generate + auto-run in sandbox (all PoCs run silently; skips and failures logged to findings/<id>/poc/execution.log; no further prompts)` → draft all scripts AND auto-run every sandbox-eligible PoC silently.

### Scope

PoCs are generated only for findings classified `EXPLOITABLE` after Pass 5 synthesis. Theoretical and unexploitable findings get NO PoC. Verifiable-unknown findings get NO PoC (insufficient evidence to build one safely).

### Output structure

For each eligible finding, PoC artifacts live inside the per-finding folder:

```
findings/<finding-id>/poc/
├── README.md           # what the script does, preconditions, observable on success
├── exploit.<ext>       # the script itself; .sh, .py, .ts, .go, etc., based on the most natural fit
├── input/              # input fixtures (payloads, archives, JSON files)
├── expected/           # expected outputs / observables for verification
├── SANDBOXED=false     # marker file, present only if the PoC was not auto-runnable (skipped)
├── execution.log       # append-only log of auto-run attempts: started, finished, failed, skipped-not-sandboxable
└── sandbox/            # populated only if auto-run is enabled and runs occur
    └── run-<UTC-timestamp>/
        ├── stdout.log
        ├── stderr.log
        ├── env.json
        ├── observable.txt
        └── notes.md
```

### Script-generation rules

1. **Source the exploit from the Pass 5 record.** Do not invent payloads. Use the inputs documented in `findings/<finding-id>/exploit.md`.
2. **Single file when possible.** Prefer one script with a CLI interface (`--target <url>`, `--input <file>`, `--out <file>`) over multi-file scaffolds.
3. **Default target = `http://localhost:8080`** (or another local-only address). The script REFUSES to run against non-local targets unless explicitly overridden by `--i-am-the-owner` flag plus a confirmation prompt.
4. **Idempotent and observable.** Each run must produce a single `observable.txt` containing the demonstration of success (e.g., the leaked secret, the executed command output, the unauthorized record).
5. **Redact captured secrets.** If the script captures real secrets in its output (passwords, tokens, PII), it MUST redact them in the persisted log (replace with `[REDACTED]`); the script may still print to stdout but the persisted artifact is redacted.
6. **No destructive payloads.** Never write payloads that delete, encrypt, or render data unreadable. Read-only or write-marker payloads only (e.g., create a file `pwned-<finding-id>.txt` as a marker).
7. **Comment the bypass.** The script header MUST include a comment block explaining what the exploit demonstrates and what fix would prevent it (cross-reference the "Suggested fix" section in `findings/<finding-id>/disclosure.md`).
8. **No copy-paste of malware.** Do not include shellcode, droppers, ransomware-style payloads, or anything that could be repurposed beyond demonstrating the finding.

### Per-PoC README template

```
# PoC — <finding-id>: <title>

> LOCAL ONLY. Do not run against systems you do not own. Do not upload.

## What this demonstrates
<one paragraph>

## Preconditions
- <network position>
- <privileges held>
- <state assumptions>

## Run
```

<command line example>
```

## Expected observable on success

<what you should see if the exploit fires>

## Cleanup

<how to undo any local marker the exploit creates>

## Reference

- Finding entry: `../README.md`
- Exploit record: `../exploit.md`
- Disclosure draft (includes suggested fix): `../disclosure.md`
- Top-level narrative: `../../../FINDINGS.md#<finding-id>`

```

### Sandboxed execution (non-interactive)

Runs only if the user picked `Generate + auto-run in sandbox` in §1.Q7. **No AskUser call is emitted here.** The user's §1 answer is the only consent surface for PoC execution; the pipeline does not interrupt them again.

Iterate through every eligible PoC. For each:
1. Verify target locality (see "Target verification" below). If not local → write `findings/<id>/poc/SANDBOXED=false`, append `SKIP not-sandboxable <reason>` to `findings/<id>/poc/execution.log`, move on. **Do NOT prompt.**
2. Run the PoC under the sandbox configuration below. Append `START`, `END exit=<code>` (or `FAIL <reason>`) to `findings/<id>/poc/execution.log`. **Do NOT prompt on failure.**
3. Continue to the next PoC.

The orchestrator MUST NOT re-prompt the user inside this loop for any reason. Failures, skips, and unexpected conditions are captured in logs and surfaced in the final handoff summary (§14).

### Sandbox configuration

The orchestrator runs PoCs under one of these sandbox modes (try in order):

1. **Ephemeral container (preferred):** `docker run --rm --network=none --read-only --tmpfs /tmp -v findings/<id>/poc:/poc:ro -v findings/<id>/poc/sandbox/run-<ts>:/out:rw <minimal-image>` — no network, read-only mount of the PoC, write-only mount of the run log directory.
2. **chroot / nspawn (Linux):** if Docker unavailable; minimal rootfs, no network namespace exposure.
3. **macOS sandbox-exec / sandbox profile:** if running on macOS without Docker; constrain filesystem and network.
4. **No sandbox available:** do NOT execute. For each eligible PoC, write `findings/<id>/poc/SANDBOXED=false` with rationale `no-sandbox-primitive`, append `SKIP no-sandbox-primitive` to `findings/<id>/poc/execution.log`, and move on. Report the condition once in the final handoff summary — do not prompt.

Inside the sandbox:
- Network: `none` by default. If the PoC requires `localhost` (e.g., it must talk to a local server the user explicitly started), enable a localhost-only bridge but block all other networks.
- Filesystem: read-only mount of the PoC. Read-write mount of `findings/<id>/poc/sandbox/run-<UTC-ts>/` for outputs only.
- Time: enforce a wall-clock timeout (default 60s).
- Resource: enforce CPU/memory limits.

### Target verification

Before any execution, the orchestrator MUST verify the target is local. A target is "local" if and only if it resolves to `127.0.0.1`, `::1`, an RFC1918 private IP, a Docker bridge IP, or a named local fixture/testcontainer spun up by the PoC itself.

If the target is not local, the PoC is NOT auto-run. Write `findings/<id>/poc/SANDBOXED=false` with rationale `non-local-target`, append `SKIP non-local-target` to `findings/<id>/poc/execution.log`, and move on. The script remains on disk so the user can run it manually under their own authorization. **Do NOT prompt** — this is handled silently and surfaced once in the final handoff summary.

### Logging and redaction

- `sandbox/run-<UTC-ts>/stdout.log` — captured stdout, with secrets redacted by the script's own redaction logic.
- `sandbox/run-<UTC-ts>/stderr.log` — captured stderr.
- `sandbox/run-<UTC-ts>/env.json` — JSON snapshot of the environment variables exposed to the sandbox (never including the host's secrets — the sandbox starts with a clean env).
- `sandbox/run-<UTC-ts>/observable.txt` — the success observable, redacted.
- `sandbox/run-<UTC-ts>/notes.md` — sandbox config, timeout, resource caps, exit code.

Logs stay LOCAL. They are NEVER uploaded.

### Hard rules (PoC)

- Never run a PoC against a system the user does not own.
- Never execute a PoC unless §1.Q7 = "Generate + auto-run in sandbox"; never re-prompt mid-mission.
- Never include destructive payloads.
- Never embed real credentials in the script (use `--cred` flag with placeholder values).
- Never persist unredacted secrets to `sandbox/run-*/`.
- Never upload sandbox logs.
- Never commit `findings/<id>/poc/` to a remote repository (the orchestrator must NOT `git push` from the mission directory; if the mission dir is inside a git working tree, do not auto-commit any per-finding folder).

---

## Output format

> **NEVER UPLOAD.** Everything below is a LOCAL artifact under `~/security-audits/<slug>-<YYYYMMDD>/` (with an automatic mirror to `~/Downloads/`). Disclosure drafts are drafts; the human submits manually if and when they choose.

This section is the rendering contract for the deep-security-review skill. The orchestration body owns how passes run, who writes what and when; this section owns the shape of what lands on disk.

**Authoritative companions.** The mission-dir tree is documented in §5 (canonical) and §0.5 (compact). Severity / confidence / disposition labels are defined in the **Methodology reference** section above ("Disposition vocabulary"). The per-pass lifecycle is documented in §5.7 + §6. When a label in this section drifts from the **Methodology reference** section, treat the **Methodology reference** as canonical.

### §1 — Producer ↔ consumer map

Every file in the mission dir has exactly one producer and at least one consumer. The layout is in §5; this table is the write-side contract.

| File / dir                                             | Produced by                                                | Consumed by                                                   |
|--------------------------------------------------------|------------------------------------------------------------|---------------------------------------------------------------|
| `run.md`                                               | §5 init (Scope & consent) + orchestrator continuously (Timeline, append-only) + §7 (Verifiable-unknowns) | every pass; reader as audit context; timing summary in `DASHBOARD.md` |
| `_run-archive/areas.json`                              | Pass 0 area-detection step                                 | Pass 0 lieutenant dispatcher; `by-area/INDEX.md`              |
| `_run-archive/lieutenants/<area>/LIEUTENANT.{md,json}` | one lieutenant Task per area                               | orchestrator dedup → `findings.json`                          |
| `_run-archive/dispatch/lieutenants/<area>.md`          | dispatcher (raw prompt + raw worker reply)                 | reproducibility; debug                                        |
| `_run-archive/judge-passN.json`                        | Pass 1 (inline orchestrator), Passes 2–3 (single prior-art worker), escalation Passes 4/5/8 (`drool exec` reviewers) | `JUDGE.md`, per-finding `provenance.json`                     |
| `_run-archive/judge-jury.json`                         | severity-triage jury consolidator (§3): 3 `drool exec` juror verdicts + consolidated severity + gate decision | `JUDGE.md`, `DASHBOARD.md`, per-finding `provenance.json`      |
| `findings/<id>/`                                       | created lazily at first per-finding write (Pass 4)         | per-finding entry point                                       |
| `findings/<id>/README.md`                              | §9 consolidation                                           | reader (primary per-finding landing page)                     |
| `findings/<id>/provenance.json`                        | orchestrator after each pass (append-only)                 | `JUDGE.md`, `DASHBOARD.md`, `FINDINGS.md`                        |
| `findings/<id>/dataflow.md`                            | Pass 4 tracer                                              | Pass 4 reviewers; CVSS derivation; `FINDINGS.md`              |
| `findings/<id>/exploit.md`                             | Pass 5 constructor                                         | Pass 5 reviewers; PoC generator; disclosure draft             |
| `findings/<id>/ctx/round-N.md`                         | §7 context-recursion sub-worker                            | originating pass on resume                                    |
| `findings/<id>/disclosure.md`                          | §12                                                        | user (manual disclosure)                                      |
| `findings/<id>/poc/*`                                  | §10 PoC generator + sandbox runner                         | user (manual replay); evidence capture                        |
| `findings/<id>/evidence/*`                             | §11 capture stage                                          | reader; embedded in disclosure                                |
| `findings.json`                                        | §9 consolidation                                           | every rendered markdown file; reader; downstream tools        |
| `FINDINGS.md`                                          | §9 from the **FINDINGS.md template** + `findings.json`     | reader (primary narrative)                                    |
| `JUDGE.md`                                             | §9 from the **JUDGE.md template** + provenance JSONs       | reader (per-pass verdict tables)                              |
| `DASHBOARD.md`                                         | §9 from the **DASHBOARD.md template** + `findings.json` + `run.md` | reader (single at-a-glance page; includes the per-finding status table) |
| `README.md`                                            | §9 fixed render                                            | reader (entry point)                                          |
| `by-severity/*.md`                                     | §9 partition of `findings.json`                            | reader (severity-sliced view)                                 |
| `by-area/*.md`                                         | §9 partition of `findings.json` by `area`                  | reader (area-sliced view)                                     |

### §2 — File formats

For each file below: purpose, required fields, and where the canonical skeleton lives. Inline examples are kept only where the template or schema is not already the canonical source.

#### 2.1 `README.md` (landing page)

**Required fields:** target, commit, audit date, jury composition (with fallbacks), total findings broken down by severity, links to `DASHBOARD.md` / `FINDINGS.md` / `run.md` / `findings/`, mirror location.
**Populated:** §9 from `findings.json` + `run.md`.
**Skeleton:** generated directly by the consolidator — no external template. Must open with the NEVER-UPLOAD banner and close with the "Disclosure is the user's decision" reminder.

#### 2.2 `DASHBOARD.md`

**Canonical skeleton:** the **DASHBOARD.md template** section in this Reference appendix.
**Required sections (mapped to `findings.json` + `run.md`):** top-line counts; severity histogram; confidence-tier histogram; top-10 by severity then confidence; severity shifts & SIBLING-OF-PRIOR bundling; per-pass split rates; per-area counts; timing.

#### 2.3 `DASHBOARD.md` — per-finding status table

The status table is part of `DASHBOARD.md` (there is no standalone `STATUS.md`). See the **status-table block** inside the **DASHBOARD.md template** section in this Reference appendix.
**Required per-finding columns:** `id`, `title`, `severity`, `dataflow_reachability`, `exploit_status`, `red_team_status`, `jury_split` (Y/N), `dissent_notes` (truncated), `disclosure_target`, link to `findings/<id>/README.md`.
Judge-progression table (severity_original → severity_final, final_verdict, parent_cve_if_sibling) is appended alongside the main per-finding table.

#### 2.4 `FINDINGS.md`

**Canonical skeleton:** the **FINDINGS.md template** section in this Reference appendix.
**Required per-finding sections:** Summary, Trigger, Code evidence (fenced, language-tagged), Dataflow pointer, Exploit pointer, Suggested fix, Prior art, Deep prior-art research, Jury verdicts (per pass), Tiebreakers, Dissent notes, Disclosure draft pointer, Folder + Provenance links. Appendix covers VERIFIABLE-UNKNOWN findings and jury fallback notes.

#### 2.5 `JUDGE.md`

**Canonical skeleton:** the **JUDGE.md template** section in this Reference appendix.
**Required sections:** pass-stats summary table (per-pass unanimity / split / tiebreaker / ctx / demoted counts); per-finding verdict table with one row per pass; severity_original/severity_final/parent_cve_if_sibling row; dissent notes per finding; reading guide.

#### 2.6 `findings.json`

**Canonical schema:** the **Output schema** section in this Reference appendix. Every promoted, disputed, and verifiable-unknown finding lives here. Severity / confidence / disposition enums come from the **Methodology reference** section; fields such as `severity_original`, `severity_final`, `parent_cve_if_sibling`, `final_verdict` are normative per the schema.

**Write-side contract:** §9 consolidator merges per-pass JSONs (`_run-archive/judge-passN.json`) with each finding's `provenance.json` into one record per finding. Optional paths (`dataflow_path`, `exploit_path`, `disclosure_path`, `evidence_paths`, `poc_paths`, `prior_art_deep`) are emitted only when the corresponding artifact exists.

#### 2.7 Per-finding folder (`findings/<finding-id>/`)

Every per-finding artifact lives here. Created lazily at first per-finding write (Pass 4). The folder is self-contained so a user can `tar czf <id>.tgz findings/<id>/` to share one finding.

Layout (see §5 for the full tree):

```

findings/<finding-id>/
├── README.md # §9 consolidation: entry page
├── disclosure.md # §12: local-only draft
├── dataflow.md # Pass 4: source → sink trace
├── exploit.md # Pass 5: exploit construction
├── provenance.json # append-only chain-of-custody
├── ctx/round-N.md # §7 NEEDS-CONTEXT recursion
├── poc/ # §10; only EXPLOITABLE + user opted in
└── evidence/ # §11; only if §1.Q8 ≠ None

````

##### 2.7.1 `README.md` — per-finding entry page

H1: `# <finding-id> — <title>  [<severity badge>]`. Required contents: one-paragraph summary (pulled from the `FINDINGS.md` narrative); `final_confidence`; `area`; `file:line`; resolved disclosure target; quick-links block linking to every sibling artifact in the folder and back-links to `../../FINDINGS.md` and `../../DASHBOARD.md`. Skipped in Raw documentation mode (§1.Q6).

##### 2.7.2 `provenance.json`

Shape documented in §8 (canonical). Required fields: `id`, `proposed_by`, `passes[]`, `tiebreakers[]`, `red_team_survived`, `final_confidence`, `dissent_notes[]`. Append-only across passes; the inline example in §8 is canonical.

##### 2.7.3 `dataflow.md`

Required sections (Pass 4): Source (entry point + untrusted-ness rationale + file:line); Forward trace (table: step, file:line, transform/sanitizer); Backward trace (sink ← caller ← entry point); Sanitizers / mitigations checked; Reachability verdict per juror + synthesized.

Verdict enum: `REACHABLE-FROM-UNTRUSTED`, `REACHABLE-INTERNAL-ONLY`, `UNREACHABLE`.

##### 2.7.4 `exploit.md`

Required sections (Pass 5): Preconditions (network position, privileges, knowledge, state); Inputs (exact bytes / headers / payload / sequence); Expected observable on success; Realistic attacker profile; Verdict per juror + synthesized. Optional: Automation sketch (omit for `THEORETICAL`).

Verdict enum: `EXPLOITABLE`, `THEORETICAL`, `UNEXPLOITABLE`.

##### 2.7.5 `ctx/round-N.md`

One markdown file per §7 recursion round; filename increments with round number. Written by the context-gathering sub-worker.

##### 2.7.6 `disclosure.md`

One per promoted finding. Full skeleton in §12. Required sections: Summary, Affected versions/commits, Reproduction steps (pointer to `./exploit.md`), Impact, Suggested fix, Suggested disclosure target (primary + secondary; ladder in §5.10), CVSS scoring (3.1 base — see §3 below), Provenance pointer. No top-level `disclosure/` directory; no vendor bundling (single-repo-per-mission).

##### 2.7.7 `poc/` and `evidence/`

PoC layout, sandbox invariants, and execution log semantics live in the **PoC generation** section above. Evidence capture tooling (asciinema, ffmpeg, Playwright) and the per-finding `evidence/README.md` contract live in §11.

#### 2.8 `run.md`

The single run-metadata file. Three top-level sections:
- **`## Scope & consent`** — resolved scope (target, commit, areas, severity floor, source-graph mode, skip set), jury composition (per-model status + fallbacks), and the ten §1 consent answers. Written at §5 init.
- **`## Timeline`** — append-only. Timing-per-pass table (pass, UTC start, UTC end, wall-clock, findings, tasks dispatched); Blockers / errors; NEEDS-CONTEXT recursion counts; Tiebreaker counts. Writes happen continuously across §5 init and each pass's `pass-start` / `pass-end` markers; the §9 `### Final summary` subsection (with final counts; mirrored into `DASHBOARD.md`'s Timing row) is appended last.
- **`## Verifiable-unknowns`** — every VERIFIABLE-UNKNOWN finding + rationale, populated by §7.

#### 2.9 `_run-archive/lieutenants/<area>/LIEUTENANT.json`

JSON array of candidate records. Each record's required fields: `area`, `file_line`, `code_quote`, `proposed_severity`, `proposed_confidence`, `suspected_class`, `trigger`, `impact`, `needs_context`. Optional: `lang`, `prior_art_hint`. Written alongside `LIEUTENANT.md` by every Pass 0 lieutenant; consumed by the orchestrator for deterministic dedup (collapse records with identical `(file_line, suspected_class)`) and canonical `<area>-<seq>` ID assignment.

#### 2.10 `_run-archive/dispatch/lieutenants/<area>.md`

Verbatim dispatch packet written BEFORE spawning each Pass 0 lieutenant. Required contents: bound variables (`area`, `target_path`, `commit_sha`, `mission_dir`, `jury_slot_hint`, `priority_tier`, `code_roots`, `exclude_globs`) + the rendered **Lieutenant prompt (Pass 0)** body with variables substituted. Never modified after dispatch.

#### 2.11 `_run-archive/areas.json`

JSON array. Each record: `area`, `code_roots[]`, `lieutenant_focus`, `priority_tier` (1–3; 1 = highest), `jury_slot_hint`, `exclude_globs[]`. Written by Pass 0's area-detection step BEFORE lieutenant dispatch; consumed by the dispatcher and by `by-area/INDEX.md` at §9.

#### 2.12 `by-severity/`

One `INDEX.md` + one file per severity bucket (`CRITICAL.md`, `HIGH.md`, `MEDIUM.md`, `LOW.md`, `INFO.md`) + one combined `ALL.md`. Every file is required — empty buckets render the header plus `No findings at this severity.`.

**Row schema (canonical; used in `ALL.md` + every per-severity file):**

| Column     | Source                     | Rendered as                                                   |
|------------|----------------------------|---------------------------------------------------------------|
| ID         | `id`                       | `` [`<id>`](../findings/<id>/) ``                              |
| Title      | `title`                    | plain text                                                    |
| Severity   | `severity`                 | `CRITICAL` / `HIGH` / `MEDIUM` / `LOW` / `INFO`               |
| Confidence | `final_confidence`         | short label                                                   |
| Dataflow   | `dataflow_reachability`    | short label                                                   |
| Exploit    | `exploit_status`           | short label                                                   |
| Red-team   | `red_team_status`          | short label                                                   |
| File:line  | `file_line`                | `` `path:line` ``                                              |
| README     | derived                    | `` [`README`](../findings/<id>/README.md) ``                   |
| Narrative  | derived                    | `` [`narrative`](../FINDINGS.md#<id>) ``                       |

**Sort order (every file except `INDEX.md`):** severity desc → `final_confidence` desc (`RED-TEAM-SURVIVED` > `ESCALATED` > `REPORT-AS-IS` > `VERIFIABLE-UNKNOWN` > `DROP-TO-INFO`) → id asc.

**`INDEX.md` must include:** severity-count table (columns `Severity | Promoted | Disputed | VU | Total | File`); a bullet list linking to each per-severity file (with the per-file count in parentheses); a link to `by-severity/HARDENING.md`; pointers to `../DASHBOARD.md`, `../FINDINGS.md`, `../by-area/INDEX.md`.

**Required rules (checked at §9 consolidation):**

1. Every row MUST link to `../findings/<id>/`; no row may inline the full narrative in place of the link.
2. Every per-severity file MUST exist (even when empty).
3. Paths use the `findings/<id>/` tree; never the deprecated parallel directories (`provenance/`, `dataflow/`, `exploits/`, `patches/`, `disclosure/`, `poc/`, `evidence/`).
4. Severity labels match the schema enum exactly: `CRITICAL` / `HIGH` / `MEDIUM` / `LOW` / `INFO` (not `MED`).
5. `by-severity/HARDENING.md` aggregates the repo's `hardening/` tree (every `<TAG>-NNN.md` note plus `hardening/SUMMARY.md`; see the **Methodology reference** section above); written alongside per-severity files. Missing-hardening case renders the header plus `No hardening notes yet; hardening is populated after phase5.`.

### §3 — CVSS v3.1 derivation

The skill emits a CVSS v3.1 base score and vector per promoted finding (and per disputed-but-kept finding). Vectors are derived deterministically from earlier-pass evidence.

| Metric                     | Derivation                                                                                                                                                              |
|----------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Attack Vector (AV)         | Pass 4 source: external HTTP/RPC → `N`; adjacent-network / IPC → `A`; local CLI / file → `L`; physical → `P`.                                                            |
| Attack Complexity (AC)     | Pass 5 preconditions: trivial → `L`; race / specific config / MITM / timing → `H`.                                                                                       |
| Privileges Required (PR)   | Pass 4 reachability + Pass 5 preconditions: unauth → `N`; authenticated user → `L`; admin/internal → `H`.                                                                |
| User Interaction (UI)      | Pass 5 inputs: server-side only → `N`; victim must click/paste/open → `R`.                                                                                               |
| Scope (S)                  | Pass 4 sink + impact: same security authority → `U`; crosses authority (sandbox escape, multi-tenant crossover, container escape) → `C`.                                 |
| Confidentiality (C)        | Pass 5 observable: full data / PII / secrets → `H`; bounded → `L`; none → `N`.                                                                                           |
| Integrity (I)              | Pass 5 observable: write / mutate / forge → `H`; bounded → `L`; none → `N`.                                                                                              |
| Availability (A)           | Pass 5 observable: full outage / crash / lockout → `H`; bounded slowdown → `L`; none → `N`.                                                                              |

**Computation.** Emit the vector string (e.g., `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`) plus the base score using the standard CVSS v3.1 formula. The disclosure draft carries a short justification table mapping each metric to the pass evidence.

**Severity ↔ CVSS sanity check.** `findings.json[severity]` should align with the CVSS base (Critical 9.0–10.0, High 7.0–8.9, Medium 4.0–6.9, Low 0.1–3.9). Mismatch > 1 tier triggers a `run.md` entry and re-review.

**Where the score lives.** Vector + base score + per-metric justification → `findings/<id>/disclosure.md` § CVSS scoring. Bare score is also emitted into `findings.json[cvss]`.

### §4 — Size expectations (industry-mono and similar)

Rough magnitudes for a ~20-area, ~1M+ LOC polyrepo at HEAD with severity floor = "Report all":

| Stage / artifact                              | Typical magnitude                                              |
|-----------------------------------------------|----------------------------------------------------------------|
| Lieutenant seed candidates (Pass 0)           | 250–600 (over-inclusive; ~12–30 per area)                     |
| Surviving Pass 1 (CONFIRMED)                  | 150–400                                                        |
| Surviving Pass 4 (REACHABLE-FROM-UNTRUSTED)   | 60–180                                                         |
| Surviving Pass 5 (EXPLOITABLE)                | 25–80                                                          |
| Surviving Pass 8 (RED-TEAM-SURVIVED)          | 10–40                                                          |
| Final promoted findings (any tier)            | 30–100                                                         |
| `findings.json` records after consolidation   | ~80–250                                                        |
| Mission-dir size on disk                      | 80 MB – 2 GB (evidence-heavy; `.cast` cheap, `.mp4` heavy)     |
| `_run-archive/` size on disk                  | 5–60 MB; ~15–30% of mission-dir                                |
| `findings/<id>/` per-finding, text-only       | 20–400 KB (provenance + dataflow + exploit + README + disclosure + ctx) |
| `findings/<id>/evidence/`                     | 0–60 MB (heaviest with asciinema + ffmpeg + headless browser)  |
| `findings/<id>/poc/`                          | 50 KB – 5 MB                                                   |
| **Total wall-clock (depth-first)**            | **6–20 hours**; outliers up to 36 hours on heavy NEEDS-CONTEXT |

Actual numbers always live in `run.md`. Pass-by-pass wall-clock is computed from the pass-start / pass-end markers appended by the orchestrator.

**Trimming `_run-archive/` after handoff.** The archive contains raw orchestration scaffolding and can be compressed + removed safely; everything downstream of consolidation already encodes the user-facing information:

```sh
cd ~/security-audits/<slug>-<date>
tar czf _run-archive.tar.gz _run-archive/ && rm -rf _run-archive/
````

> **Reminder.** Nothing documented here is uploaded. Disclosure drafts under `findings/<id>/disclosure.md` are drafts only; the user submits manually if and when they choose.

---

## Output schema

Canonical machine-readable schema for a single finding produced by the deep security audit (`findings.json` is an array of records matching this schema):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/deep-security-review/output.json",
  "title": "Canonical finding record",
  "description": "Canonical machine-readable schema for a single finding produced by the deep security audit.",
  "type": "object",
  "required": [
    "id",
    "title",
    "severity",
    "area",
    "file_line",
    "summary",
    "trigger",
    "impact",
    "dataflow_reachability",
    "exploit_status",
    "red_team_status",
    "jury_verdicts",
    "prior_art",
    "final_confidence",
    "dissent_notes"
  ],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "pattern": "^[a-z0-9-]+-\\d{3,}$" },
    "title": { "type": "string" },
    "severity": {
      "type": "string",
      "enum": ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]
    },
    "area": { "type": "string" },
    "category": { "type": "string" },
    "file_line": { "type": "string" },
    "code_quote": { "type": "string" },
    "lang": { "type": "string" },
    "summary": { "type": "string" },
    "trigger": { "type": "string" },
    "impact": { "type": "string" },
    "dataflow_reachability": {
      "type": "string",
      "enum": [
        "REACHABLE-FROM-UNTRUSTED",
        "REACHABLE-INTERNAL-ONLY",
        "UNREACHABLE",
        "VERIFIABLE-UNKNOWN",
        "PENDING"
      ]
    },
    "dataflow_path": { "type": "string" },
    "exploit_status": {
      "type": "string",
      "enum": [
        "EXPLOITABLE",
        "THEORETICAL",
        "UNEXPLOITABLE",
        "PENDING",
        "VERIFIABLE-UNKNOWN"
      ]
    },
    "exploit_path": { "type": "string" },
    "red_team_status": {
      "type": "string",
      "enum": [
        "RED-TEAM-SURVIVED",
        "RED-TEAM-INCONCLUSIVE",
        "RED-TEAM-INCONCLUSIVE-NEEDS-RUNTIME",
        "RED-TEAM-DISPROVED",
        "PENDING"
      ]
    },
    "patch_path": { "type": "string" },
    "patch_status": {
      "type": "string",
      "enum": [
        "PATCH-COMPLETE",
        "PATCH-PARTIAL",
        "PATCH-UNCERTAIN",
        "PENDING",
        "NOT-CONSTRUCTED"
      ]
    },
    "jury_verdicts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["pass", "synthesis"],
        "properties": {
          "pass": { "type": "string" },
          "synthesis": { "type": "string" },
          "split": { "type": "boolean" },
          "verdicts": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["model", "verdict"],
              "properties": {
                "model": { "type": "string" },
                "verdict": { "type": "string" },
                "rationale": { "type": "string" }
              }
            }
          }
        }
      }
    },
    "prior_art": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["type", "id"],
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "GHSA",
              "CVE",
              "vendor-advisory",
              "h1-disclosure",
              "commit",
              "blog",
              "paper",
              "rfc",
              "spec",
              "cwe",
              "framework_doc",
              "talk"
            ]
          },
          "id": { "type": "string" },
          "url": { "type": "string", "format": "uri" },
          "summary": { "type": "string" },
          "match_strength": {
            "type": "string",
            "enum": ["EXACT", "STRONG", "WEAK", "BACKGROUND"]
          }
        }
      }
    },
    "prior_art_deep": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": { "type": "string" },
          "title": { "type": "string" },
          "authors": { "type": "string" },
          "venue": { "type": "string" },
          "url": { "type": "string", "format": "uri" },
          "summary": { "type": "string" },
          "applicability": {
            "type": "string",
            "enum": ["DIRECT", "ANALOGOUS", "BACKGROUND"]
          }
        }
      }
    },
    "suggested_patch_ref": { "type": "string" },
    "final_confidence": {
      "type": "string",
      "enum": [
        "RED-TEAM-SURVIVED",
        "ESCALATED",
        "REPORT-AS-IS",
        "VERIFIABLE-UNKNOWN",
        "DROP-TO-INFO"
      ]
    },
    "final_verdict": {
      "type": "string",
      "description": "Disposition verdict after all floor passes complete. See §5.8.",
      "enum": [
        "PROMOTED",
        "DEMOTED-DUPLICATE",
        "DEMOTED-KBD",
        "DISPUTED",
        "WITHDRAWN",
        "SIBLING-OF-PRIOR",
        "CONFIRMED-BY-DESIGN"
      ]
    },
    "pass1_verdict": {
      "type": "string",
      "description": "Synthesized line-anchor verdict at Pass 1. See §5.8.",
      "enum": ["CONFIRMED", "DISPUTED", "NEEDS-CONTEXT", "CONFIRMED-BY-DESIGN"]
    },
    "pass2_verdict": {
      "type": "string",
      "description": "Synthesized vendor-prior-art verdict at Pass 2. See §5.8.",
      "enum": [
        "REMAINS-NOVEL",
        "SIBLING-OF-PRIOR",
        "DEMOTE-DUPLICATE",
        "DEMOTE-KBD"
      ]
    },
    "severity_original": {
      "type": "string",
      "description": "Severity initially proposed by the lieutenant (Pass 0), before any judge downgrades.",
      "enum": ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
    },
    "severity_final": {
      "type": "string",
      "description": "Severity after all severity-shift verdicts resolved. See §5.8.",
      "enum": ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
    },
    "parent_cve_if_sibling": {
      "type": ["string", "null"],
      "description": "Parent advisory ID when final_verdict == SIBLING-OF-PRIOR (e.g., \"CVE-2025-61667\", \"GHSA-xxxx-xxxx-xxxx\"). Null otherwise."
    },
    "dissent_notes": { "type": "array", "items": { "type": "string" } },
    "provenance_path": { "type": "string" },
    "disclosure_path": { "type": "string" },
    "evidence_paths": { "type": "array", "items": { "type": "string" } },
    "poc_paths": { "type": "array", "items": { "type": "string" } }
  }
}
```

---

## DASHBOARD.md template

Render this skeleton at §9 consolidation by substituting Handlebars-style variables (`{{ var }}`, `{{#each}}`, `{{#if}}`) against `findings.json` + `run.md`:

````markdown
# Dashboard — deep security audit at a glance

> **NEVER UPLOAD.** All output local.

- **Target:** `{{ target }}`
- **Commit:** `{{ commit_sha }}`
- **Date:** `{{ audit_date }}`
- **Jury:** `{{ jury }}`

## Top-line counts

- Total findings: **{{ total }}**
- Promoted: **{{ promoted }}**
- Disputed-after-adversarial: **{{ disputed }}**
- Verifiable-unknown: **{{ vu }}**

## Severity histogram

```
CRITICAL  {{ bar.crit }}  ({{ ct.crit }})
HIGH      {{ bar.high }}  ({{ ct.high }})
MEDIUM    {{ bar.med }}   ({{ ct.med }})
LOW       {{ bar.low }}   ({{ ct.low }})
INFO      {{ bar.info }}  ({{ ct.info }})
```

## Confidence-tier histogram

```
RED-TEAM-SURVIVED   {{ bar.rts }}  ({{ ct.rts }})
ESCALATED           {{ bar.esc }}  ({{ ct.esc }})
REPORT-AS-IS        {{ bar.rai }}  ({{ ct.rai }})
VERIFIABLE-UNKNOWN  {{ bar.vu }}  ({{ ct.vu }})
DROP-TO-INFO        {{ bar.dti }}  ({{ ct.dti }})
```

## Top 10 by severity then confidence

| Rank             | ID  | Title | Severity     | Final confidence                       | Folder        |
| ---------------- | --- | ----- | ------------ | -------------------------------------- | ------------- | ---------------- | ------------------------ | ------------------------------------------------------- |
| {{#each top10 as | t   | }}    | {{ t.rank }} | [`{{ t.id }}`](FINDINGS.md#{{ t.id }}) | {{ t.title }} | {{ t.severity }} | {{ t.final_confidence }} | [`findings/{{ t.id }}/`](findings/{{ t.id }}/README.md) |

{{/each}}

## Severity shifts & sibling bundling (from JUDGE.md)

```
HIGH → MED   {{ bar.shift_high_med }}  ({{ ct.shift_high_med }})
HIGH → LOW   {{ bar.shift_high_low }}  ({{ ct.shift_high_low }})
MED  → LOW   {{ bar.shift_med_low }}   ({{ ct.shift_med_low }})
SIBLING-OF-PRIOR (bundled)   {{ bar.sibling }}  ({{ ct.sibling }})
```

| ID                 | severity_original | severity_final | parent_cve_if_sibling                  |
| ------------------ | ----------------- | -------------- | -------------------------------------- | --------------------------- | ------------------------ | ------------------------------- |
| {{#each shifted as | s                 | }}             | [`{{ s.id }}`](FINDINGS.md#{{ s.id }}) | `{{ s.severity_original }}` | `{{ s.severity_final }}` | `{{ s.parent_cve_if_sibling }}` |

{{/each}}

## Jury & escalation split rates

The floor (Pass 1 inline, Passes 2–3 single worker) does not split. The severity-triage jury and the escalation reviewers are the multi-model stages, so splits and tiebreakers are tracked there.

| Stage                | Findings in         | Splits            | Tiebreakers run | Gate / outcome breakdown                                                          |
| -------------------- | ------------------- | ----------------- | --------------- | --------------------------------------------------------------------------------- |
| severity-triage jury | {{ jury.findings }} | {{ jury.splits }} | {{ jury.tb }}   | ESCALATE {{ jury.escalate }} / REPORT-AS-IS {{ jury.rai }} / DROP {{ jury.drop }} |
| 4 dataflow           | {{ p4.findings }}   | {{ p4.splits }}   | {{ p4.tb }}     | reachable {{ p4.reachable }} / unreachable {{ p4.unreachable }}                   |
| 5 exploit            | {{ p5.findings }}   | {{ p5.splits }}   | {{ p5.tb }}     | exploitable {{ p5.exploitable }} / theoretical {{ p5.theoretical }}               |
| 8 red-team           | {{ p8.findings }}   | n/a               | n/a             | survived {{ p8.survived }} / disproved {{ p8.disproved }}                         |

## Quick links

- [FINDINGS.md](FINDINGS.md)
- [JUDGE.md](JUDGE.md)
- [`run.md`](run.md)
````

The **DASHBOARD.md — status-table block** (below) is appended here, after the split-rates section, so the per-finding status table lives on this same page.

---

## FINDINGS.md template

Render this skeleton at §9 consolidation:

````markdown
# Deep security review — findings

> **NEVER UPLOAD.** All output in this directory is local. Disclosure drafts under `findings/<id>/disclosure.md` are drafts only and were NOT submitted to any external party.

- **Target:** `{{ target }}`
- **Commit:** `{{ commit_sha }}`
- **Audit date:** `{{ audit_date }}`
- **Jury composition:** `{{ jury }}` (with fallbacks: `{{ fallbacks }}`)
- **Total findings:** `{{ total_findings }}`
- **Promoted:** `{{ promoted_count }}` (CRITICAL: `{{ crit }}` / HIGH: `{{ high }}` / MEDIUM: `{{ med }}` / LOW: `{{ low }}` / INFO: `{{ info }}`)
- **Disputed-after-adversarial:** `{{ disputed_count }}`
- **Verifiable-unknown:** `{{ vu_count }}`

For per-finding verdict tables across every pass that fired, see [JUDGE.md](JUDGE.md). For the dashboard, see [DASHBOARD.md](DASHBOARD.md). For severity-sorted views, see `by-severity/`.

---

{{#each findings as |f|}}

## `{{ f.id }}` — {{ f.title }}

- **Severity:** {{ f.severity }}
- **Severity (original → final):** {{ f.severity_original }} → {{ f.severity_final }}
- **Final verdict:** {{ f.final_verdict }}
- **Final confidence:** {{ f.final_confidence }}
- **Parent CVE (if SIBLING-OF-PRIOR):** {{ f.parent_cve_if_sibling }}
- **Area:** {{ f.area }}
  {{#if f.owasp_mapping }}- **OWASP / STRIDE mapping:** {{ f.owasp_mapping }}{{/if}}
- **File:line:** `{{ f.file_line }}`
- **Dataflow reachability:** {{ f.dataflow_reachability }}
- **Exploit status:** {{ f.exploit_status }}
- **Red-team status:** {{ f.red_team_status }}
- **Folder:** [`findings/{{ f.id }}/`](findings/{{ f.id }}/README.md)
- **Provenance:** [`findings/{{ f.id }}/provenance.json`](findings/{{ f.id }}/provenance.json)

### Summary

{{ f.summary }}

### Trigger

{{ f.trigger }}

### Code evidence

```{{ f.lang }}
{{ f.code_quote }}
```

### Dataflow trace

See [`findings/{{ f.id }}/dataflow.md`](findings/{{ f.id }}/dataflow.md).

### Exploit

{{#if f.exploit_path }}See [`findings/{{ f.id }}/exploit.md`](findings/{{ f.id }}/exploit.md).{{else}}Not constructed (status: {{ f.exploit_status }}).{{/if}}

### Suggested fix

{{ f.suggested_fix }}

### Prior art

{{#each f.prior_art as |pa|}}- [{{ pa.id }}]({{ pa.url }}) — {{ pa.summary }} (match: {{ pa.match_strength }}){{/each}}

### Deep prior-art research

{{#each f.prior_art_deep as |pad|}}- {{ pad.type }}: [{{ pad.title }}]({{ pad.url }}) ({{ pad.applicability }}) — {{ pad.summary }}{{/each}}

### Jury verdicts

{{#each f.passes as |p|}}**{{ p.pass }}** — synthesis: `{{ p.synthesis }}` (split: {{ p.split }})
{{#each p.verdicts as |v|}}- `{{ v.model }}` → `{{ v.verdict }}`: {{ v.rationale }}{{/each}}
{{/each}}

### Tiebreakers

{{#each f.tiebreakers as |tb|}}- Round {{ tb.round }} ({{ tb.pass }}, {{ tb.method }}): `{{ tb.resolved_verdict }}` — {{ tb.evidence }}{{/each}}

### Dissent notes

{{#each f.dissent_notes as |d|}}- {{ d }}{{/each}}

### Disclosure draft (LOCAL ONLY)

[`findings/{{ f.id }}/disclosure.md`](findings/{{ f.id }}/disclosure.md)

---

{{/each}}

## How to read this report

- The canonical machine-readable record is `findings.json`.
- Each finding has its own folder at `findings/<id>/` containing every per-finding artifact (README, disclosure, dataflow, exploit, provenance, ctx, poc/, evidence/).
- Each finding has a provenance JSON in `findings/<id>/provenance.json` recording every juror's verdict at every pass.
- Findings are sorted by `severity` then by `final_confidence` (RED-TEAM-SURVIVED first, DROP-TO-INFO last).
- Disputed-after-adversarial findings remain in this report (in their own section) — they are not silently dropped.
- Verifiable-unknown findings are listed in [`run.md`](run.md) and tagged in `DASHBOARD.md`.

> **Reminder:** nothing here was uploaded. Disclosure is the human user's decision.
````

---

## JUDGE.md template

Render this skeleton at §9 consolidation:

```markdown
# Judge — per-finding verdict tables across every pass that fired

> **NEVER UPLOAD.** All output local.

- **Target:** `{{ target }}`
- **Commit:** `{{ commit_sha }}`
- **Audit date:** `{{ audit_date }}`
- **Jury:** `{{ jury }}`

This file surfaces the multi-model jury's verdict at every pass for every finding. The canonical record is `findings/<id>/provenance.json`.

---

## Pass-stats summary

| Stage                 | Total findings entering | Mechanism             | Multi-model split | Tiebreakers invoked | NEEDS-CONTEXT recursions | Demoted / dropped  |
| --------------------- | ----------------------- | --------------------- | ----------------- | ------------------- | ------------------------ | ------------------ |
| Pass 0 — lieutenant   | n/a (seed)              | per-area `Task`       | n/a               | n/a                 | n/a                      | {{ p0_demoted }}   |
| Pass 1 — line-anchor  | {{ p1_in }}             | inline (orchestrator) | n/a               | n/a                 | {{ p1_ctx }}             | {{ p1_demoted }}   |
| Pass 2 — vendor prior | {{ p2_in }}             | single worker         | n/a               | n/a                 | {{ p2_ctx }}             | {{ p2_demoted }}   |
| Pass 3 — deep prior   | {{ p3_in }}             | single worker         | n/a               | n/a                 | {{ p3_ctx }}             | n/a (enrichment)   |
| Severity-triage jury  | {{ jury_in }}           | 3× `drool exec`       | {{ jury_split }}  | {{ jury_tb }}       | n/a                      | {{ jury_dropped }} |
| Pass 4 — dataflow     | {{ p4_in }}             | 3× `drool exec`       | {{ p4_split }}    | {{ p4_tb }}         | {{ p4_ctx }}             | {{ p4_demoted }}   |
| Pass 5 — exploit      | {{ p5_in }}             | 3× `drool exec`       | {{ p5_split }}    | {{ p5_tb }}         | {{ p5_ctx }}             | {{ p5_demoted }}   |
| Pass 8 — red-team     | {{ p8_in }}             | 1× `drool exec`       | n/a               | n/a                 | {{ p8_ctx }}             | {{ p8_demoted }}   |

---

## Per-finding verdict tables

{{#each findings as |f|}}

### `{{ f.id }}` — {{ f.title }} (severity: {{ f.severity }}; final: {{ f.final_confidence }})

| severity_original           | severity_final           | parent_cve_if_sibling           |
| --------------------------- | ------------------------ | ------------------------------- |
| `{{ f.severity_original }}` | `{{ f.severity_final }}` | `{{ f.parent_cve_if_sibling }}` |

| Pass           | {{ jury_a }}                     | {{ jury_b }}   | {{ jury_c }}   | Split?           | Synthesis              | Tiebreaker     |
| -------------- | -------------------------------- | -------------- | -------------- | ---------------- | ---------------------- | -------------- |
| 1 line-anchor  | `{{ f.p1.a }}`                   | `{{ f.p1.b }}` | `{{ f.p1.c }}` | {{ f.p1.split }} | `{{ f.p1.syn }}`       | {{ f.p1.tb }}  |
| 2 vendor-prior | `{{ f.p2.a }}`                   | `{{ f.p2.b }}` | `{{ f.p2.c }}` | {{ f.p2.split }} | `{{ f.p2.syn }}`       | {{ f.p2.tb }}  |
| 3 deep-prior   | enrichment                       | enrichment     | enrichment     | n/a              | {{ f.p3.links }} links | n/a            |
| 4 dataflow     | `{{ f.p4.a }}`                   | `{{ f.p4.b }}` | `{{ f.p4.c }}` | {{ f.p4.split }} | `{{ f.p4.syn }}`       | {{ f.p4.tb }}  |
| 5 exploit      | `{{ f.p5.a }}`                   | `{{ f.p5.b }}` | `{{ f.p5.c }}` | {{ f.p5.split }} | `{{ f.p5.syn }}`       | {{ f.p5.tb }}  |
| 8 red-team     | adversary `{{ f.p8.adv_model }}` |                |                | n/a              | `{{ f.p8.syn }}`       | {{ f.p8.emp }} |

**Folder:** [`findings/{{ f.id }}/`](findings/{{ f.id }}/README.md) · **Provenance JSON:** [`findings/{{ f.id }}/provenance.json`](findings/{{ f.id }}/provenance.json)

**Dissent notes:**
{{#each f.dissent_notes as |d|}}- {{ d }}{{/each}}

---

{{/each}}

## Reading guide

- `ESCALATE` / `REPORT-AS-IS` / `DROP-TO-INFO` = the consolidated severity-triage jury gate (§3). ESCALATE findings entered the escalation tier; REPORT-AS-IS were finalized at their floor verdict; DROP-TO-INFO moved to the informational section (never deleted).
- `jury split` = the three jurors did not agree on severity; all three verdicts are recorded in `provenance.json[jury]`.
- `TIEBREAKER` = an **escalation-tier** disagreement (Pass 4/5/8 reviewers split) that was resolved by re-examining the evidence (§4 round 1) or a minimal empirical check (§4 round 2) — never by adding a juror. The jury is fixed at three models; a split jury escalates by default (escalate-on-doubt) rather than spawning a tiebreaker.
- `NEEDS-CONTEXT` = the originating pass needed more context before verdicting; the orchestrator ran a context-recursion sub-worker.
- `DISPUTED-AFTER-ADVERSARIAL` = Pass 8 successfully disproved a previously-escalated finding. The finding remains in the report under the disputed section.
- `RED-TEAM-SURVIVED` = Pass 8 attempted disproof and could not. Highest confidence tier.
```

---

## DASHBOARD.md — status-table block

This block renders **inside `DASHBOARD.md`** (appended after the "Pass-by-pass split rates" section of the **DASHBOARD.md template** above). It is the former standalone STATUS.md content; there is no separate STATUS.md file. Render this skeleton at §9 consolidation:

```markdown
## Counts by final confidence tier

| Tier               | Count                       |
| ------------------ | --------------------------- |
| RED-TEAM-SURVIVED  | {{ ct.red_team_survived }}  |
| ESCALATED          | {{ ct.escalated }}          |
| REPORT-AS-IS       | {{ ct.report_as_is }}       |
| VERIFIABLE-UNKNOWN | {{ ct.verifiable_unknown }} |
| DROP-TO-INFO       | {{ ct.drop_to_info }}       |

## Counts by severity

| Severity | Promoted         | Disputed         | Verifiable-Unknown | Total            |
| -------- | ---------------- | ---------------- | ------------------ | ---------------- |
| CRITICAL | {{ sev.crit.p }} | {{ sev.crit.d }} | {{ sev.crit.vu }}  | {{ sev.crit.t }} |
| HIGH     | {{ sev.high.p }} | {{ sev.high.d }} | {{ sev.high.vu }}  | {{ sev.high.t }} |
| MEDIUM   | {{ sev.med.p }}  | {{ sev.med.d }}  | {{ sev.med.vu }}   | {{ sev.med.t }}  |
| LOW      | {{ sev.low.p }}  | {{ sev.low.d }}  | {{ sev.low.vu }}   | {{ sev.low.t }}  |
| INFO     | {{ sev.info.p }} | {{ sev.info.d }} | {{ sev.info.vu }}  | {{ sev.info.t }} |

## Findings (sorted: severity desc, final_confidence desc)

| ID                  | Title | Severity | Dataflow                               | Exploit       | Red-team         | Jury split                    | Dissent                | Folder                  |
| ------------------- | ----- | -------- | -------------------------------------- | ------------- | ---------------- | ----------------------------- | ---------------------- | ----------------------- | ------------------ | --------------------- | ------------------------------------------------------- |
| {{#each findings as | f     | }}       | [`{{ f.id }}`](FINDINGS.md#{{ f.id }}) | {{ f.title }} | {{ f.severity }} | {{ f.dataflow_reachability }} | {{ f.exploit_status }} | {{ f.red_team_status }} | {{ f.jury_split }} | {{ f.dissent_short }} | [`findings/{{ f.id }}/`](findings/{{ f.id }}/README.md) |

{{/each}}

## Judge progression

Current severity vs. original (lieutenant-proposed) severity, plus final verdict and sibling parent advisory when judge has run. Canonical source: [JUDGE.md](JUDGE.md) and each finding's `provenance.json[severity_shifts]` (see §5.8).

| ID                  | Severity (original → final) | Final verdict | Parent CVE (if SIBLING-OF-PRIOR)       |
| ------------------- | --------------------------- | ------------- | -------------------------------------- | -------------------------------------------------- | --------------------- | ----------------------------- |
| {{#each findings as | f                           | }}            | [`{{ f.id }}`](FINDINGS.md#{{ f.id }}) | {{ f.severity_original }} → {{ f.severity_final }} | {{ f.final_verdict }} | {{ f.parent_cve_if_sibling }} |

{{/each}}

## Verifiable-Unknown findings

These are findings where verdict could not be reached even after context recursion and (where attempted) empirical tiebreaker. They are kept in the report and tagged as `VERIFIABLE-UNKNOWN`.

{{#each vu_findings as |f|}}- [`{{ f.id }}`](FINDINGS.md#{{ f.id }}) — {{ f.title }} (reason: {{ f.vu_reason }}; see [`run.md`](run.md){{ f.id_anchor }}){{/each}}

## Per-finding folders

Every per-finding artifact (provenance, dataflow, exploit, ctx, disclosure, poc, evidence) lives under a single folder per finding. Open `findings/<id>/README.md` as the entry point.

{{#each findings as |f|}}- [`findings/{{ f.id }}/README.md`](findings/{{ f.id }}/README.md) — provenance: [`findings/{{ f.id }}/provenance.json`](findings/{{ f.id }}/provenance.json){{/each}}

## Pointers

- Narrative writeup: [FINDINGS.md](FINDINGS.md)
- Per-pass verdict tables: [JUDGE.md](JUDGE.md)
- Run metadata (scope/consent, timeline, verifiable-unknowns): [`run.md`](run.md)
- By severity: `by-severity/CRITICAL.md`, `HIGH.md`, `MEDIUM.md`, `LOW.md`, `INFO.md`, `ALL.md`, `INDEX.md`
- By area: `by-area/<area>.md`, `by-area/INDEX.md`
- Per-finding folders (local only): `findings/<id>/` (contains disclosure.md, dataflow.md, exploit.md, poc/, evidence/)

## Reminder

Nothing in this audit was uploaded. Disclosure is the human user's decision. The drafts under `findings/<id>/disclosure.md` are starting points; the user submits manually if and when they choose.
```
