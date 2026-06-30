import { AutomationRunStatus } from '@industry/common/api/v0/automations';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Generate VISUAL.html content.
 *
 * Every hex literal in this template MUST belong to the 11-color
 * `INDUSTRY_BRAND_PALETTE` in `@industry/common/automations`.
 * Light-mode contrast that would normally call for an intermediate gray
 * is achieved with rgba() of an existing palette hex instead of a new
 * literal. The scaffold body carries `data-industry-visual-scaffold="true"`
 * so `decideVisualPolicy` short-circuits to the `create` branch and the
 * agent rewrites it on the first real run.
 */
export function generateVisualContent(
  automationName: string,
  startedAt: string,
  status: AutomationRunStatus,
  runCount: number,
  isFirstRun: boolean
): string {
  const isSuccess = status === AutomationRunStatus.Success;
  const statusBadgeClass = isSuccess ? 'badge-success' : 'badge-error';
  const statusText = isSuccess ? 'Success' : 'Failed';
  const escapedName = escapeHtml(automationName);

  const alertClass = isSuccess ? 'alert-success' : 'alert-error';
  const bannerLabel = isFirstRun
    ? isSuccess
      ? 'First Run Complete'
      : 'First Run Failed'
    : isSuccess
      ? 'Run Complete'
      : 'Run Failed';
  const bannerCopy = isFirstRun
    ? isSuccess
      ? `Your automation "${automationName}" has been initialized and is ready for scheduled execution.`
      : `Your automation "${automationName}" failed on its first run. Review logs and retry.`
    : isSuccess
      ? `Automation "${automationName}" executed successfully. Run #${runCount}.`
      : `Automation "${automationName}" failed during run #${runCount}. Review logs and retry.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedName}</title>
  <script>
    (function () {
      function applyTheme(t) {
        if (t === 'light' || t === 'dark') {
          document.documentElement.setAttribute('data-theme', t);
        }
      }
      try {
        var m = (location.hash || '').match(/theme=(light|dark)/);
        if (m) applyTheme(m[1]);
      } catch (e) {}
      window.addEventListener('message', function (event) {
        var data = event && event.data;
        if (data && data.type === 'industry:set-theme') applyTheme(data.theme);
      });
    })();
  </script>
  <style>
    :root {
      color-scheme: dark;
      --page-bg: #000000;
      --surface-1: #161413;
      --surface-2: #161413;
      --border-1: #342F2D;
      --border-2: #342F2D;
      --text-default: #FFFFFF;
      --text-subheading: #9B8E87;
      --text-muted: #948781;
      --text-label: #9B8E87;
      --jade-1: rgba(111, 171, 120, 0.15);
      --jade-border: rgba(111, 171, 120, 0.25);
      --jade-text: #6FAB78;
      --ruby-1: rgba(217, 54, 62, 0.15);
      --ruby-border: rgba(217, 54, 62, 0.35);
      --ruby-text: #D9363E;
      --topaz-1: rgba(240, 163, 48, 0.15);
      --topaz-text: #F0A330;
      --mica-accent: #EE6018;
      --font-sans: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      --font-mono: 'Geist Mono', 'Berkeley Mono', 'SF Mono', Monaco, Inconsolata, 'Roboto Mono', Consolas, monospace;
      --radius-sm: 4px;
      --radius-md: 4px;
    }
    @media (prefers-color-scheme: light) {
      :root:not([data-theme="dark"]) {
        color-scheme: light;
        --page-bg: #F2F0F0;
        --surface-1: #FFFFFF;
        --surface-2: #FFFFFF;
        --border-1: #342F2D;
        --border-2: #342F2D;
        --text-default: #161413;
        --text-subheading: #948781;
        --text-muted: #948781;
        --text-label: #948781;
        --jade-1: rgba(111, 171, 120, 0.18);
        --jade-border: rgba(111, 171, 120, 0.35);
        --ruby-1: rgba(217, 54, 62, 0.15);
        --ruby-border: rgba(217, 54, 62, 0.4);
        --topaz-1: rgba(240, 163, 48, 0.2);
      }
    }
    :root[data-theme="light"] {
      color-scheme: light;
      --page-bg: #F2F0F0;
      --surface-1: #FFFFFF;
      --surface-2: #FFFFFF;
      --border-1: #342F2D;
      --border-2: #342F2D;
      --text-default: #161413;
      --text-subheading: #948781;
      --text-muted: #948781;
      --text-label: #948781;
      --jade-1: rgba(111, 171, 120, 0.18);
      --jade-border: rgba(111, 171, 120, 0.35);
      --ruby-1: rgba(217, 54, 62, 0.15);
      --ruby-border: rgba(217, 54, 62, 0.4);
      --topaz-1: rgba(240, 163, 48, 0.2);
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --page-bg: #000000;
      --surface-1: #161413;
      --surface-2: #161413;
      --border-1: #342F2D;
      --border-2: #342F2D;
      --text-default: #FFFFFF;
      --text-subheading: #9B8E87;
      --text-muted: #948781;
      --text-label: #9B8E87;
      --jade-1: rgba(111, 171, 120, 0.15);
      --jade-border: rgba(111, 171, 120, 0.25);
      --ruby-1: rgba(217, 54, 62, 0.15);
      --ruby-border: rgba(217, 54, 62, 0.35);
      --topaz-1: rgba(240, 163, 48, 0.15);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--page-bg);
      color: var(--text-default);
      font-family: var(--font-sans);
      font-size: 20px;
      font-weight: 300;
      line-height: 1.5;
      letter-spacing: -0.01em;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
      padding: 24px;
    }
    .container { max-width: 960px; margin: 0 auto; }
    h1 { font-size: 56px; font-weight: 300; letter-spacing: -0.01em; margin-bottom: 8px; }
    .subtitle {
      font-size: 14px; font-family: var(--font-mono); color: var(--text-subheading);
      text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 20px;
    }
    .section-label {
      font-size: 14px; font-family: var(--font-mono); color: var(--text-subheading);
      text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px;
    }
    .badge {
      display: inline-flex; padding: 2px 8px; border-radius: 2px;
      font-size: 11px; font-weight: 500; letter-spacing: 0.2px;
    }
    .badge-success { background: var(--jade-1); color: var(--jade-text); }
    .badge-error { background: var(--ruby-1); color: var(--ruby-text); }
    .badge-neutral { background: var(--border-1); color: var(--text-label); }
    .alert {
      display: flex; align-items: flex-start; gap: 10px; padding: 12px;
      border-radius: var(--radius-sm); margin-bottom: 16px; border: 1px solid;
    }
    .alert-success { background: var(--jade-1); border-color: var(--jade-border); }
    .alert-error { background: var(--ruby-1); border-color: var(--ruby-border); }
    .alert-dot { width: 6px; height: 6px; border-radius: 50%; margin-top: 5px; flex-shrink: 0; }
    .alert-success .alert-dot { background: var(--jade-text); }
    .alert-error .alert-dot { background: var(--ruby-text); }
    .alert-content { flex: 1; }
    .alert-title { font-size: 12px; font-weight: 500; margin-bottom: 2px; }
    .alert-text { font-size: 12px; color: var(--text-muted); line-height: 1.4; }
    .metric {
      background: var(--surface-2); border: 1px solid var(--border-1);
      border-radius: var(--radius-sm); padding: 16px;
    }
    .metric-label {
      font-size: 14px; font-family: var(--font-mono); color: var(--text-subheading);
      text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px;
    }
    .metric-value {
      font-size: 48px; font-weight: 300; color: var(--mica-accent);
      line-height: 1; font-feature-settings: 'ss09';
    }
    .metric-sub { font-size: 14px; color: var(--text-muted); margin-top: 4px; }
    .metrics-row {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px; margin-bottom: 16px;
    }
    .separator { border: none; border-top: 1px solid var(--border-1); margin: 20px 0; }
    .footnote { font-size: 14px; color: var(--text-muted); margin-top: 12px; }
  </style>
</head>
<body data-industry-visual-scaffold="true">
  <div class="container">
    <h1>${escapedName}</h1>
    <div class="subtitle">${escapeHtml(bannerLabel)} &middot; Run #${runCount}</div>

    <div class="alert ${alertClass}">
      <div class="alert-dot"></div>
      <div class="alert-content">
        <div class="alert-title">${escapeHtml(bannerLabel)}</div>
        <div class="alert-text">${escapeHtml(bannerCopy)}</div>
      </div>
    </div>

    <div class="section-label">Run Status</div>
    <div class="metrics-row">
      <div class="metric">
        <div class="metric-label">Last Run</div>
        <div class="metric-value" style="font-size:20px;color:var(--text-default);">${escapeHtml(new Date(startedAt).toLocaleString())}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Total Runs</div>
        <div class="metric-value">${runCount}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Status</div>
        <div class="metric-value" style="font-size:20px;color:var(--text-default);">
          <span class="badge ${statusBadgeClass}">${escapeHtml(statusText)}</span>
        </div>
      </div>
    </div>

    <hr class="separator">
    <div class="footnote">This visual output will be updated with each automation run.</div>
  </div>
</body>
</html>`;
}
