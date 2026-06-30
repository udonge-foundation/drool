import {
  SYSTEM_REMINDER_END,
  SYSTEM_REMINDER_START,
} from '@industry/drool-sdk-ext/protocol/drool';

import {
  buildAgentEffectivenessReportMetrics,
  buildDailyAgentEffectivenessTokenEfficiencyTrend,
  renderAgentEffectivenessHtmlReport,
} from '../agent-effectiveness-report';

import type { AgentEffectivenessReportEntitlementResponse } from '@industry/common/api/agent-effectiveness';

const SHARED_RENDERER_FUNCTIONS = [
  buildAgentEffectivenessReportMetrics.name,
  buildDailyAgentEffectivenessTokenEfficiencyTrend.name,
  renderAgentEffectivenessHtmlReport.name,
].join('`, `');

function escapeSystemReminderTags(value: string): string {
  return value
    .split(SYSTEM_REMINDER_START)
    .join('&lt;system-reminder&gt;')
    .split(SYSTEM_REMINDER_END)
    .join('&lt;/system-reminder&gt;');
}

export function buildAgentEffectivenessReportPrompt({
  entitlement,
  apiBaseUrl,
  timeframe,
}: {
  entitlement: AgentEffectivenessReportEntitlementResponse;
  apiBaseUrl: string;
  timeframe?: string;
}): string {
  const timeframeInstruction = timeframe
    ? `Use this timeframe request: ${timeframe}`
    : 'Before collecting data, ask the user to choose a timeframe: last 30 days, last 90 days, lifetime, or a custom start/end date.';
  const organizationLabel = escapeSystemReminderTags(
    entitlement.organizationName || entitlement.organizationId
  );
  const organizationId = escapeSystemReminderTags(entitlement.organizationId);
  const usageEndpoint = `${apiBaseUrl}/api/organization/agent-effectiveness/usage`;

  return `${SYSTEM_REMINDER_START}
Generate an Agent Effectiveness Report for the currently authenticated Industry organization: ${organizationLabel}.

${timeframeInstruction}

Access model:
- This feature is available only when the organization-level agent_effectiveness_report flag is enabled and the current user is an org owner or manager.
- Always use the invoking user's current Industry organization. Never ask the user to choose or provide an org ID/name, and never offer a different organization as an option.
- The backend entitlement check resolved the current Industry organization to ${organizationLabel} (${organizationId}). Treat this as the only organization for this run. Never use an organization from prior conversation context, sample data, screenshots, examples, or previous report runs.
- Use Industry's backend endpoint only for Industry usage metrics. Do not query BigQuery directly, do not ask the customer for BigQuery credentials, and do not generate or accept user-supplied SQL.
- Industry usage tool: \`get_agent_effectiveness_usage\` (calls ${usageEndpoint} with authenticated org scoping).
- Report renderer tool: \`render_agent_effectiveness_report\` (runs Drool's bundled shared renderer locally and returns the exact HTML file path).
- Do not upload Linear, Jira, GitHub, pull request, work-item, or checked-repository metadata to Industry. Collect and process delivery tracker and SCM data locally in this session, then render the report locally.

Required workflow:
1. Resolve the requested timeframe before querying.
2. Call \`get_agent_effectiveness_usage\` with only dateRange/startDate/endDate. Do not use FetchUrl, Execute, curl, gh, or hand-written HTTP for Industry usage. Do not include orgId, workItems, pullRequests, checkedRepositories, Industry usage rows, BigQuery SQL, BigQuery credentials, or any customer-provided query material. The tool/backend derives orgId from the authenticated user and returns only Industry usage JSON for the resolved date range. The response includes two complementary shapes that must be kept separate end-to-end: \`codingUsage\` is the per-user coding-related credit breakdown (used for every chart, scatter plot, ratio, and the per-user table), and \`totalUsage\` is the unfiltered org-wide token/session total (used only for the headline "Industry credits" card in the top-left of the Summary Metrics grid). Do not sum \`codingUsage\` to fabricate a headline total when the response includes \`totalUsage\`, and do not push \`totalUsage\` into per-user ratios or the breakdown table.
3. Preflight delivery tracker access before collecting GitHub data. First inspect available MCP tools, including deferred tools shown in system context: if any \`linear___*\` issue/user tools are available, Linear MCP is already configured and must be used directly; do not ask the user to connect Linear and do not require \`LINEAR_API_KEY\`. If any \`jira___*\` issue/user tools are available, Jira MCP is already configured and must be used directly. Only if no Linear/Jira MCP tools are available should you check \`LINEAR_API_KEY\`/Linear API or Jira API site/email/token access. If neither MCP nor API access is available, ask the user once to provide one of: Linear MCP, Linear API key, Jira MCP, or Jira API credentials/link. If the user cannot provide Linear or Jira access, hard-stop and explain that Agent Effectiveness requires work-item metadata; do not generate a usage-only or PR-only report.
4. Preflight GitHub access with gh before collecting PR data. GitHub is a hard requirement for Agent Effectiveness, on the same footing as Linear/Jira in step 3: without it, PR-derived metrics and the Coding credits / PR, Coding credits / net LOC, and LOC / PR scatter plots cannot be computed and the report is not valid. Run \`gh auth status\` first. If gh is not installed, ask the user once to install GitHub CLI (\`brew install gh\` on macOS, \`sudo apt install gh\` on Debian/Ubuntu, or https://cli.github.com for other platforms) and re-preflight. If gh is installed but not authenticated, ask the user once to run \`gh auth login\` (device or browser flow) and wait for explicit confirmation before continuing. If the authenticated gh user cannot see the matched customer GitHub org in \`gh api user/orgs\` (missing SSO authorization, wrong account, missing org membership), ask the user once to re-run \`gh auth login --scopes "repo,read:org"\` with SSO authorization for that org, or to switch to the account that has org access, and wait for confirmation. If after that request the user still cannot provide authenticated gh access to the matched customer GitHub org, hard-stop and explain that Agent Effectiveness requires authenticated GitHub CLI access with visibility into the customer's GitHub org to collect PR metadata; do not generate a usage-only or tickets-only report, and do not silently ship an empty-PR report. Once gh is authenticated, resolve the GitHub org from the invoking user's Industry organization membership: use Industry's repository endpoint first if available (GET ${apiBaseUrl}/api/integrations/scm/repositories?enabled=true), derive the GitHub owner/org from those repository URLs, and verify it is present in \`gh api user/orgs\`. Never infer from the local repo, branch, or worktree, and never scan unrelated GitHub orgs from the user's account.
5. Build a canonical user roster locally before PR attribution: GET ${apiBaseUrl}/api/organization/members?limit=10000 for Industry emails/names when available, include Industry usage emails returned by the usage endpoint, include Linear/Jira assignee emails (fetch Linear users via \`linear___list_users\` and Jira users via the equivalent Jira MCP tool rather than relying on assignee names alone), and include verified Industry integration mappings such as GitHub username/email from user profiles if available. Normalize emails to lowercase and treat GitHub noreply addresses as identities, not final user emails. Produce an explicit \`aliasEmail -> canonicalEmail\` lookup that collapses every variant (Industry member email, Industry usage email, Linear user email, Jira user email, verified GitHub email) owned by the same person onto a single canonical email. Before passing data to \`render_agent_effectiveness_report\`, rewrite all three input arrays with that lookup: set every \`codingUsage[i].userEmail\`, every \`workItems[i].assigneeEmail\`, and every \`pullRequests[i].authorEmail\` (plus \`authorEmails[]\`) to the canonical email. This normalization is what lets per-user rows collapse across sources so that Coding credits / PR, Coding credits / net LOC, and LOC / PR scatter plots populate; without it, the same engineer with different emails in Linear, Industry usage, and GitHub will appear as three separate rows and every scatter plot will have zero overlap. Record aliases that could not be mapped to any canonical roster user in the identity-reconciliation note instead of guessing.
6. Scan the entire matched customer GitHub org with \`gh repo list <org> --limit 1000\`. Save the full checked repository list locally as \`checkedRepositories\`. Collect merged PRs across every repository in that org for the timeframe, including repo, PR id/url, authorLogin, authorName, authorEmail when verified, authorEmails from every PR commit author/co-author/committer, mergedAt, additions, deletions, test-file changes, linked Linear/Jira issue keys, Industry Drool coauthor/session signals, and AI-assisted detection.
7. Enrich every merged PR before attribution. For each PR, call GitHub PR detail and commits APIs (for example \`gh api repos/{owner}/{repo}/pulls/{number}\` and \`gh api repos/{owner}/{repo}/pulls/{number}/commits --paginate\`) or equivalent GraphQL. Parse all commit author/committer logins and emails, merge commit author/committer, PR body issue references, branch names when available, and \`Co-authored-by:\` trailers. Do not treat bot PR authors like \`industry-drool[bot]\`, \`industry-drool-internal[bot]\`, or Drool service users as final human owners; use their co-author, commit, linked-ticket, or branch evidence to find the human owner.
8. Resolve each PR to exactly one specific Industry user email locally before computing metrics. Never leave authorEmail as a GitHub noreply address, never credit bot/service accounts, and never guess when a match is ambiguous; leave the PR unattributed and record the attribution gap in the summary.
9. Collect Linear or Jira work items in the timeframe, including completed and in-progress items. Prefer MCP calls when MCP tools are available: use \`linear___list_issues\`/\`linear___list_users\` for Linear, or the equivalent Jira MCP issue/user tools for Jira. Include id, title, status, assignee email, assignee name, story points/estimate when available, completedAt/startedAt, and linked PR ids. Do not treat PR-linked issue keys as a substitute for work-item records; fetch the actual Linear/Jira items.
10. Join Industry usage rows, work items, and PRs locally by canonical user email produced in step 5. Use exact email or verified integration mappings first; only use a name/login heuristic when it resolves to exactly one roster user, and never use first-name-only matching when multiple roster users could plausibly match. Compute per-user ratios only from data attributed to the same canonical user. Keep usage-only users, delivery-only users, unattributed PRs, and unassigned work items separate instead of forcing them into a user's ratio. When the person who ran Drool sessions is not the same human as the ticket assignee (for example, a platform engineer running sessions that complete another engineer's Linear tickets), prefer PR→linked-ticket evidence to decide who should own the ticket for attribution, or leave credits-per-ticket empty for that pair; never reassign tokens to a ticket owner who has no PR or commit evidence of doing the work.
11. Run identity and metric reconciliation before rendering: verify total tokens equals the sum of per-user usage tokens plus explicitly unaccounted usage tokens; completed/in-progress ticket totals equal the sum of per-user attributed tickets plus unassigned/unmatched tickets; PR totals equal the sum of per-user attributed PRs plus unattributed PRs; and linked-ticket/AI-assisted PR counts reconcile with the PR list. If PR attribution coverage is non-zero but every visible per-user PR count is zero, or if ticket totals appear only through heuristic name matches, stop and fix the join before rendering.
12. Build the report with the deterministic shared renderer through \`render_agent_effectiveness_report\` instead of hand-calculating tables or hand-writing the final template. Do not import \`@industry/drool-core/agent-effectiveness-report\` from a temporary script; that package may not be importable from the user's working directory when Drool is installed as a CLI. The renderer tool runs \`${SHARED_RENDERER_FUNCTIONS}\` from Drool's bundled code. Create a \`ResolvedAgentEffectivenessReportRequest\`-shaped object from the resolved date range, entitlement org id/name, locally collected \`workItems\`, \`pullRequests\`, \`checkedRepositories\`, and options; pass that plus the \`codingUsage\` rows and the \`totalUsage\` object from \`get_agent_effectiveness_usage\` to \`render_agent_effectiveness_report\`. The renderer uses \`totalUsage\` only for the headline "Industry credits" card and uses \`codingUsage\` for every chart, scatter plot, ratio, and the per-user breakdown table; forward both verbatim from the usage response without summing, filtering, or rewriting them. Do not reimplement metric joins, PR attribution aggregation, table rendering, chart rendering, sorting, pagination, or the CSS in an ad-hoc temporary script.
13. Compute org-level token-efficiency time-series data with exactly one bucket per calendar day from resolved startDate through resolved endDate inclusive; do not use weekly/monthly buckets, do not use a single whole-range bucket, and do not cap the series at 24 points. Call \`get_agent_effectiveness_usage\` once for each day using that day as startDate and endDate, store those results in a \`dailyUsageRows\` array whose length exactly equals the inclusive calendar-day count, and pass \`dailyUsageRows\` to \`render_agent_effectiveness_report\` with the locally collected PRs/work items. The tool computes the line-chart ratio "Tokens / net LOC per person": \`(dayBillableTokens / activePeople) / max(1, abs(dayNetLoc) / activePeople)\`, where activePeople is the count of unique canonical org users active in Industry usage, attributed PRs, or work items on that day. Keep the raw activePeople, billableTokens, net LOC, per-person tokens, per-person net LOC, and ratio for hover/focus so readers can see whether token efficiency is improving over time. If tracker access exists but returns zero work items for the timeframe, state that explicitly in the report summary; otherwise, an empty workItems array means the run is invalid and must fail before rendering.
14. Render the HTML report locally with \`render_agent_effectiveness_report\`, save it to /tmp/agent-effectiveness-report with a descriptive \`.html\` filename, and summarize the report file before the metric caveats. Do not reuse or open any existing HTML report unless you first inspect it and verify it contains the daily trend chart DOM: \`Token spend / net LOC over time\`, \`line-chart\`, an SVG \`polyline\` or \`path\`, and exactly one \`.trend-point\` per calendar day in the resolved range. If a cached report is missing the daily trend chart or has fewer trend points than days, treat it as stale/invalid and regenerate it with \`render_agent_effectiveness_report\` before reporting success. The final response must include both the human-readable filename and absolute local path returned by the tool, using a file URL link whose visible text is the filename: \`HTML report: [agent-effectiveness-report-YYYY-MM-DD-to-YYYY-MM-DD.html](file:///absolute/path/agent-effectiveness-report-YYYY-MM-DD-to-YYYY-MM-DD.html)\`. Do not summarize the report as only "Open HTML report" or any other generic link label, because that can link back to the session instead of the local file.
15. After the HTML file is saved and verified, open that exact HTML file in the user's default browser using an OS command, even if you reused an already-generated report for the same timeframe. On macOS use \`open "<absolute-report-path>.html"\`; on Linux use \`xdg-open "<absolute-report-path>.html"\`; on Windows use \`start "" "<absolute-report-path>.html"\`. Run the command, do not merely print it. If opening fails or the environment is headless, do not retry repeatedly; report the exact HTML path and file URL link above and explain that the user can open it manually.

HTML consistency:
- The report is generated locally from usage JSON plus locally collected PR/work-item data; do not ask Industry's backend to render or store the final HTML.
- Match the Industry internal app / industry website component theme: use the core-ui dark design tokens (surface-1/2/3, border-1, text-default/label/subheading, text-highlight), square cards with collapsed borders, uppercase subtitle labels, compact metric cards, muted explanatory copy, and straight 1px divider/border lines instead of rounded gradient cards.
- Preserve the concrete styling from the existing Agent Effectiveness HTML renderer. The standalone HTML must include a real stylesheet, not only semantic markup: define the dark token variables; patterned dark body background; centered \`.shell\`; \`.header-card\` and \`.card\` surfaces; four-column \`.metric-grid\`; \`.summary-grid\`; \`.distribution-grid\`; \`.distribution-card\`; \`.distribution-plot\`; \`.chart-y-axis\`; \`.chart-area\`; dashed \`.chart-grid-line\`; orange square \`.chart-point\`; hover/focus \`.chart-tooltip\`; sortable table styling; pagination controls; \`.gap-note\`; scroll-constrained \`.repo-list\`; and responsive media queries. Do not output an unstyled skeleton.
- Do not render a standalone Industry "F" icon or a separate orange "Agent Effectiveness" eyebrow above the report title.
- Use Industry core-ui typography: Geist sans with 400-weight headings/body/metric values, -0.13px letter spacing, small muted explanatory text, and Geist Mono for repository pills.
- Reuse the existing Industry font assets instead of copying or embedding font payloads in generated source. In this repo, the font files live under \`packages/core-ui/src/fonts/\` and their declarations live in \`packages/core-ui/src/styles/fonts.css\`. If rendering through a bundled frontend/template, import or reference those core-ui font declarations. If writing a standalone local HTML file, use \`font-family: Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif\` and \`'Geist Mono', 'SF Mono', Monaco, monospace\` fallbacks rather than inlining base64 font payloads.
- Do not import or execute backend report-rendering modules such as \`apps/backend/src/features/agent-effectiveness-report/report.ts\` or \`embedded-fonts.ts\` from a temporary script. Those backend files rely on app-specific path aliases and may embed large font payloads; a customer-side report run must generate self-contained local HTML from the collected JSON/data instead.

Report feature completeness checklist:
- Header: render a full-width \`.header-card\` with title "Agent Effectiveness Report", muted subtitle, organization label, date badge, and generated timestamp in a compact metadata row.
- Summary Metrics: render a \`.metric-grid\` with tooltip-enabled \`.metric\` cards and "?" icons. The first row must be exactly two \`.metric--wide\` cards: total Industry credits/tokens and the primary efficiency metric. The headline "Industry credits" card uses the unfiltered org-wide \`totalUsage.billableTokens\` from the usage response so it reflects total Industry credit spend; every other metric, ratio, chart, scatter plot, and per-user row uses the coding-related \`codingUsage\` rows. Include primary throughput, tickets in progress, AI-assisted code proxy, AI test-change proxy, Industry credits/tokens per day, tickets completed per day, and PRs per day.
- Coverage: render compact \`.summary-grid\` cards for cross-source identity quality and coverage, then render the trend chart and distribution charts in the same section. Keep explanatory subtitles under each chart title.
- Breakdown by user: render a horizontally scrollable sortable table with these columns when data is available: User, Industry credits/tokens, Story points, credits/tokens per story point, Tickets completed, Tickets in progress, credits/tokens per ticket, PRs, Lines changed (+/-), credits/tokens per PR, credits/tokens per net LOC, AI-assisted PRs, and Industry sessions. Every numeric cell must have \`data-sort-value\`. Add a client-side \`<script>\` for sorting and pagination with 10, 25, 50, 100, and All page-size options.
- Attribution gap / margin of error: render a \`.gap-note\` below the table summarizing unaccounted tokens, sessions, PRs, work items without assignee email, delivery-matched token/session coverage, PRs without ticket links, and PRs without Industry attribution. When a scatter plot is legitimately sparse because the Industry usage runners are not the same humans as the ticket assignees, explicitly call it out here (for example, "N ticket owners did not run Drool sessions in this window; their coding credits / ticket is 0 and is excluded from the Coding credits / tickets chart"). Do not fabricate synthetic points, collapse unrelated users, or reassign tokens between humans to make a chart look denser.
- Repositories checked: render every scanned repository as a Geist Mono \`.repo-pill\` inside a scroll-constrained \`.repo-list\` and show the scanned repository count.
- Caveats and footer: render a compact Caveats section and "Generated by Industry Agent Effectiveness" footer.

Chart rendering checklist:
- Distribution charts must be real scatter plots, not text placeholders. For each valid point, compute \`left\` from the x value normalized to max x and \`top\` from the y value normalized to max y, clamp to the chart area, and render an absolutely positioned orange square \`.chart-point\` with keyboard focus and hover tooltip.
- Distribution charts must include y-axis tick labels, dashed horizontal grid lines at 0/25/50/75/100%, a bottom x-axis label, and accessible \`aria-label\` text.
- Credits/tokens per ticket, credits/tokens per PR, credits/tokens per net LOC, and LOC per PR must each have their own chart. Only render a chart-specific empty state when that chart has no valid datapoints; do not suppress all charts because one denominator is missing.
- The "Token spend / net LOC over time" chart must be a real line chart with an SVG \`polyline\` or \`path\`, y-axis grid, date labels, orange square markers, hover/focus tooltips, and an explicit "Lower is better" subtitle. It must contain one computed datapoint per calendar day in the resolved report window.
- Tooltip text must include enough context to audit the ratio: user or bucket, numerator, denominator, Lines changed (+/-) where applicable, active people for the trend chart, and the final ratio.

Before finalizing the report file, inspect the generated HTML and verify it contains: \`<style>\`, \`<script>\`, \`metric-grid\`, \`summary-grid\`, \`distribution-grid\`, \`distribution-plot\`, \`chart-point\`, \`chart-tooltip\`, \`table-pagination\`, \`repo-list\`, \`gap-note\`, \`Token spend / net LOC over time\`, \`line-chart\`, \`trend-point\`, an SVG \`polyline\` or \`path\`, and the Breakdown by user table. Count \`.trend-point\` occurrences and verify the count exactly matches the inclusive calendar-day count from startDate through endDate. If any are missing or the trend-point count is wrong, fix the HTML before reporting success.
- The Summary Metrics grid must be four columns at desktop widths. The first row must contain only the two wide cards: "Industry credits" (unfiltered org-wide total) and the primary "Coding-related Industry credits / story point|ticket|PR" efficiency card.
- Summary Metrics must include "Coding-related Industry credits per day", "Tickets completed per day", and "PRs per day".
- The coverage section must not label usage rows with any email as "Mapped Industry users". Instead show cross-source identity quality: "Delivery-matched Industry users" (Industry usage users also matched to at least one work item or attributed PR), "Usage-only users", "Delivery-only users", and "Unattributed PRs". Include a compact identity-reconciliation note explaining how many users were exact email matches, verified integration matches, safe unique name/login matches, and unmatched.
- The Breakdown by user table must support client-side sorting by every visible column and include Industry-style pagination controls with 10, 25, 50, 100, and All page-size options.
- The Breakdown by user table must include a "Lines changed (+/-)" column that displays "+additions / -deletions" and sorts by total changed lines.
- The coverage section must include four rendered distribution charts: Coding credits / tickets, Coding credits / PR, Coding credits / net LOC, and LOC / PR. Generate actual chart DOM for each chart with \`.distribution-plot\`, \`.chart-y-axis\`, \`.chart-area\`, dashed grid lines, and one absolutely positioned \`.chart-point\` per valid datapoint using computed \`left: <percent>%\` and \`top: <percent>%\`. Every datapoint must reveal the user's email, relevant y-axis value, x-axis denominator, Lines changed (+/-), and ratio on hover/focus. Only show the "No attributed users with enough delivery metadata" empty state for a chart when that specific chart has zero valid datapoints.
- Add a rendered line chart titled "Token spend / net LOC over time" near the coverage charts. Plot the daily "Tokens / net LOC per person" ratio over time for the whole org with exactly one point for every calendar day in the resolved report window; lower values indicate better token efficiency. The chart must use a real SVG/polyline or path with Industry orange square point markers, dashed horizontal gridlines, compact date labels, and a tooltip/focus label for each point with day date, active people, billable tokens, net LOC, per-person tokens, per-person net LOC, and the ratio. Do not leave the line chart as a placeholder \`<span class="chart-point">\` without computed coordinates.
- Include compact coverage, attribution gap, repositories checked, and caveats sections. The "Repositories checked" section must list every repository scanned from \`checkedRepositories\` and constrain the pill list to roughly one quarter of the full expanded height with vertical scrolling.

If you need a local fallback or preview, use this structure:

\`\`\`html
<main class="shell">
  <div class="header-card">
    <div class="title-row">
      <div>
        <h1 class="report-title">Agent Effectiveness Report</h1>
        <p class="report-subtitle">Quantifies Industry usage against delivery metadata.</p>
        <div class="repo-info">Organization · <span class="date-badge">2026-05-01 to 2026-05-31</span></div>
      </div>
    </div>
  </div>
  <section class="card">
    <div class="section-header"><span class="section-title">Summary Metrics</span></div>
    <div class="metric-grid">
      <div class="metric metric--wide" tabindex="0" title="Total Industry credits used during the report window.">
        <div class="label-row"><div class="label">Industry credits</div><span class="tooltip-icon" aria-hidden="true">?</span></div>
        <div class="value">1,234,567</div>
      </div>
      <div class="metric metric--wide" tabindex="0" title="Coding-related Industry credits divided by completed tickets.">
        <div class="label-row"><div class="label">Coding-related Industry credits / ticket</div><span class="tooltip-icon" aria-hidden="true">?</span></div>
        <div class="value">83,627,918.64</div>
      </div>
    </div>
  </section>
  <section class="card">
    <div class="section-header"><span class="section-title">Coverage</span></div>
    <div class="summary-grid">...</div>
    <div class="trend-card"><div class="distribution-title">Token spend / net LOC over time</div><div class="distribution-subtitle">Lower is better. Ratio is computed daily from per-person billable tokens divided by per-person net LOC.</div><div class="line-chart" aria-label="Token spend to net LOC over time"><svg class="line-chart-svg" viewBox="0 0 100 100"><polyline class="line-chart-line" points="2,80 18,72 34,65 50,50 66,48 82,42 98,36" /></svg><span class="chart-point" style="left: 2%; top: 80%;"><span class="chart-tooltip">2026-05-01 · 12 active people · 240k tokens · 1,200 net LOC · 20 tokens / net LOC / person</span></span></div></div>
    <div class="distribution-grid">
      <div class="distribution-card"><div class="distribution-title">Coding credits / tickets</div><div class="distribution-subtitle">X-axis: completed tickets. Vertical position: coding-related Industry credits.</div><div class="distribution-plot"><span class="chart-point"><span class="chart-tooltip">user@example.com · 123 coding-related Industry credits · 3 completed tickets · 41 credits / ticket</span></span></div><div class="distribution-axis"><span>0</span><span>3 completed tickets</span></div></div>
      <div class="distribution-card"><div class="distribution-title">Coding credits / PR</div><div class="distribution-subtitle">X-axis: attributed PRs. Vertical position: coding-related Industry credits.</div><div class="distribution-plot"><span class="chart-point"><span class="chart-tooltip">user@example.com · 456 coding-related Industry credits · 4 attributed PRs · 114 credits / PR</span></span></div><div class="distribution-axis"><span>0</span><span>4 attributed PRs</span></div></div>
    </div>
  </section>
  <section class="card">
    <div class="section-header"><span class="section-title">Breakdown by user</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>User</th><th>Coding-related Industry credits</th><th>Story points</th><th>Tickets completed</th><th>PRs</th><th>Lines changed (+/-)</th></tr></thead>
        <tbody><tr><td>user@example.com</td><td>123,456</td><td>8</td><td>3</td><td>4</td><td>+120 / -45</td></tr></tbody>
      </table>
    </div>
    <div class="gap-note"><strong>Attribution gap / margin of error:</strong> 0 coding-related Industry credits · 0 sessions · 0 PRs were not fully connected across Industry usage, PR, and ticket metadata.</div>
  </section>
  <section class="card">
    <div class="section-header"><span class="section-title">Repositories checked</span></div>
    <div class="repo-list" style="max-height: 96px; overflow-y: auto;"><span class="repo-pill">Industry-AI/industry-mono</span></div>
  </section>
</main>
\`\`\`
${SYSTEM_REMINDER_END}`;
}
