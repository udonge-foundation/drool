import _ from 'lodash';

import { INDUSTRY_ACCENT_COLOR, INDUSTRY_LOGO_SVG } from '@industry/utils/brand';

import { getI18n } from '@/i18n';

const OAUTH_CALLBACK_AUTO_CLOSE_SECONDS = 5;
const COUNTDOWN_PLACEHOLDER = '__INDUSTRY_COUNTDOWN_SECONDS__';
const INDUSTRY_LOGO_CURRENT_COLOR_SVG = INDUSTRY_LOGO_SVG.replace(
  'fill="#000000"',
  'fill="currentColor"'
);

function getCountdownMessageHtml(): string {
  const text = _.escape(
    getI18n().t('common:mcpAuth.autoCloseCountdown', {
      seconds: COUNTDOWN_PLACEHOLDER,
    })
  );

  return text.replace(
    COUNTDOWN_PLACEHOLDER,
    `<span id="countdown">${OAUTH_CALLBACK_AUTO_CLOSE_SECONDS}</span>`
  );
}

function renderPage(params: {
  title: string;
  bodyHtml: string;
  statusLabel: string;
  iconHtml: string;
  scriptHtml?: string;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${_.escape(params.title)}</title>
    <style>
      :root {
        color-scheme: dark;
        --accent: ${INDUSTRY_ACCENT_COLOR};
        --background: #070707;
        --card: rgba(20, 20, 20, 0.92);
        --card-border: rgba(255, 255, 255, 0.1);
        --muted: #a1a1aa;
        --text: #fafafa;
      }

      * {
        box-sizing: border-box;
      }

      body {
        align-items: center;
        background:
          radial-gradient(circle at top left, rgba(249, 115, 22, 0.22), transparent 34rem),
          linear-gradient(135deg, #050505 0%, var(--background) 52%, #15100c 100%);
        color: var(--text);
        display: flex;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        justify-content: center;
        margin: 0;
        min-height: 100vh;
        padding: 2rem;
      }

      .shell {
        max-width: 34rem;
        width: 100%;
      }

      .brand {
        align-items: center;
        color: var(--text);
        display: flex;
        gap: 0.7rem;
        justify-content: center;
        margin-bottom: 1.25rem;
      }

      .industry-logo {
        height: 1.75rem;
        width: 1.75rem;
      }

      .wordmark {
        font-size: 0.9rem;
        font-weight: 650;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .card {
        background: var(--card);
        border: 1px solid var(--card-border);
        border-radius: 1.5rem;
        box-shadow:
          0 1.5rem 5rem rgba(0, 0, 0, 0.44),
          inset 0 1px 0 rgba(255, 255, 255, 0.06);
        padding: 2rem;
        text-align: center;
      }

      .icon {
        align-items: center;
        background: rgba(249, 115, 22, 0.12);
        border: 1px solid rgba(249, 115, 22, 0.26);
        border-radius: 999px;
        color: var(--accent);
        display: inline-flex;
        height: 3.5rem;
        justify-content: center;
        margin-bottom: 1.25rem;
        width: 3.5rem;
      }

      .status {
        color: var(--accent);
        font-size: 0.72rem;
        font-weight: 700;
        letter-spacing: 0.12em;
        margin-bottom: 0.6rem;
        text-transform: uppercase;
      }

      h1 {
        font-size: clamp(2rem, 5vw, 2.75rem);
        line-height: 1;
        margin: 0 0 0.9rem;
      }

      p {
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.6;
        margin: 0;
      }

      #countdown {
        color: var(--text);
        font-weight: 750;
      }

      [hidden] {
        display: none;
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <div class="brand" aria-label="Industry">
        ${INDUSTRY_LOGO_CURRENT_COLOR_SVG}
        <span class="wordmark">Industry</span>
      </div>
      <section class="card" aria-labelledby="page-title">
        <div class="icon" aria-hidden="true">${params.iconHtml}</div>
        <div class="status">${_.escape(params.statusLabel)}</div>
        <h1 id="page-title">${_.escape(params.title)}</h1>
        ${params.bodyHtml}
      </section>
    </main>
    ${params.scriptHtml ?? ''}
  </body>
</html>`;
}

export function renderOAuthSuccessPage(): string {
  return renderPage({
    title: getI18n().t('common:mcpAuth.authorizationSuccessful'),
    statusLabel: getI18n().t('common:mcpAuth.connectedStatus'),
    iconHtml:
      '<svg aria-hidden="true" fill="none" height="30" viewBox="0 0 24 24" width="30"><path d="m5 12 4 4L19 6" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.4"/></svg>',
    bodyHtml: `
        <p id="autoclose">${getCountdownMessageHtml()}</p>
        <p id="safe-to-close" hidden>${_.escape(
          getI18n().t('common:mcpAuth.closeWindowHint')
        )}</p>`,
    scriptHtml: `<script>
      (function () {
        var remaining = ${OAUTH_CALLBACK_AUTO_CLOSE_SECONDS};
        var countdown = document.getElementById('countdown');
        var autoclose = document.getElementById('autoclose');
        var safeToClose = document.getElementById('safe-to-close');

        function tick() {
          remaining -= 1;
          if (remaining <= 0) {
            window.close();
            if (autoclose) autoclose.hidden = true;
            if (safeToClose) safeToClose.hidden = false;
            return;
          }

          if (countdown) countdown.textContent = String(remaining);
          window.setTimeout(tick, 1000);
        }

        window.setTimeout(tick, 1000);
      })();
    </script>`,
  });
}

export function renderOAuthErrorPage(message: string): string {
  return renderPage({
    title: getI18n().t('common:mcpAuth.authorizationFailed'),
    statusLabel: getI18n().t('common:mcpAuth.failedStatus'),
    iconHtml:
      '<svg aria-hidden="true" fill="none" height="30" viewBox="0 0 24 24" width="30"><path d="M12 8v5m0 3h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2"/></svg>',
    bodyHtml: `<p>${_.escape(message)}</p>`,
  });
}
