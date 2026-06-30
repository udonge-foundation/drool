import type { BrandPalette } from './types';

/**
 * Canonical Industry brand palette — single source of truth for the
 * VISUAL.html prompt directive (`INDUSTRY_VISUAL_BRAND_GUIDE` below) and
 * the automated detector (which consumes the derived
 * `INDUSTRY_BRAND_PALETTE_HEXES` set). Kept internal so callers must go
 * through the derived exports and stay aligned on a single
 * representation.
 */
const INDUSTRY_BRAND_PALETTE: BrandPalette = {
  source: 'https://industry-brand-guide.vercel.app/',
  rule: 'NEVER use custom colors outside this palette.',
  primary: [
    {
      name: 'Industry Orange',
      hex: '#EE6018',
      rgb: [238, 96, 24],
      role: 'Accents, CTAs, highlights',
    },
    {
      name: 'Black',
      hex: '#000000',
      rgb: [0, 0, 0],
      role: 'Primary background',
    },
    {
      name: 'Surface',
      hex: '#161413',
      rgb: [22, 20, 19],
      role: 'Cards, elevated surfaces',
    },
    {
      name: 'Border',
      hex: '#342F2D',
      rgb: [52, 47, 45],
      role: 'Dividers, strokes',
    },
    {
      name: 'Gray',
      hex: '#9B8E87',
      rgb: [155, 142, 135],
      role: 'Description text',
    },
    {
      name: 'Footer Gray',
      hex: '#948781',
      rgb: [148, 135, 129],
      role: 'Metadata, footer text',
    },
    {
      name: 'White',
      hex: '#FFFFFF',
      rgb: [255, 255, 255],
      role: 'Headlines, primary text',
    },
    {
      name: 'Light BG',
      hex: '#F2F0F0',
      rgb: [242, 240, 240],
      role: 'Light mode background',
    },
  ],
  safety: [
    {
      name: 'Success',
      hex: '#6FAB78',
      rgb: [111, 171, 120],
      role: 'Success state',
    },
    {
      name: 'Warning',
      hex: '#F0A330',
      rgb: [240, 163, 48],
      role: 'Warning state',
    },
    {
      name: 'Error',
      hex: '#D9363E',
      rgb: [217, 54, 62],
      role: 'Error state',
    },
  ],
};

const ALL_PALETTE_ENTRIES = [
  ...INDUSTRY_BRAND_PALETTE.primary,
  ...INDUSTRY_BRAND_PALETTE.safety,
];

/** Uppercase 6-digit hex set for fast lookup. */
export const INDUSTRY_BRAND_PALETTE_HEXES: ReadonlySet<string> = new Set(
  ALL_PALETTE_ENTRIES.map((entry) => entry.hex.toUpperCase())
);

/**
 * The semantic (safety) palette hexes — Success / Warning / Error. Data
 * dashboards legitimately need per-theme shade variants of these status
 * colors, so the detector tolerates hexes in the same hue family rather than
 * forcing an exact match (see `detectVisualBrandIssues`).
 */
export const INDUSTRY_SEMANTIC_PALETTE_HEXES: ReadonlySet<string> = new Set(
  INDUSTRY_BRAND_PALETTE.safety.map((entry) => entry.hex.toUpperCase())
);

/** Directory name for automations within .industry */
export const AUTOMATIONS_DIR_NAME = 'automations';

/** Required files and directories within an automation folder */
export const AUTOMATION_HEARTBEAT_FILE = 'HEARTBEAT.md';
export const AUTOMATION_VISUAL_FILE = 'VISUAL.html';
export const AUTOMATION_MEMORY_DIR = 'memory';
export const AUTOMATION_REPORTS_DIR = 'reports';

/** Persistent state file inside AUTOMATION_MEMORY_DIR */
export const AUTOMATION_STATE_FILE = 'state.json';

const PALETTE_LIST_INLINE = ALL_PALETTE_ENTRIES.map((e) => e.hex).join(', ');

const PRIMARY_PALETTE_LINES = INDUSTRY_BRAND_PALETTE.primary.map(
  (e) => `- ${e.name}: ${e.hex} (rgb ${e.rgb.join(', ')}) — ${e.role}`
);

const SAFETY_PALETTE_LINES = INDUSTRY_BRAND_PALETTE.safety.map(
  (e) => `- ${e.name}: ${e.hex} (rgb ${e.rgb.join(', ')}) — ${e.role}`
);

/**
 * Canonical Industry brand guide for automation VISUAL.html outputs.
 *
 * Source of truth: https://industry-brand-guide.vercel.app/
 *
 * The agent that creates or updates VISUAL.html for an automation
 * receives this block verbatim in its system reminder. Stated as
 * MUST/MUST NOT because soft suggestions produced generic dark-blue
 * Tailwind/shadcn dashboards.
 *
 * The palette section is generated from `INDUSTRY_BRAND_PALETTE` so the
 * detector (`detectVisualBrandIssues`) and this prompt can never
 * disagree about what is on-spec.
 */
export const INDUSTRY_VISUAL_BRAND_GUIDE: readonly string[] = [
  '## Industry brand guide (REQUIRED)',
  '',
  `CANONICAL BRAND GUIDE URL: ${INDUSTRY_BRAND_PALETTE.source}`,
  '',
  'This URL is the source of truth for logos, color tokens, typography, voice, and visual treatments. If you have a web fetch / browse tool available (e.g. WebFetch, fetch_url, browser, curl), you SHOULD fetch this URL before designing the VISUAL.html. Otherwise treat the rules below as authoritative.',
  '',
  '### Visual principles',
  "- Engineered precision: every element earns its place. No decoration for decoration's sake.",
  '- Dark-first: black is the default canvas. Orange is the only accent.',
  '- Typographic hierarchy: information is organized through type scale, weight, and case. Text carries the system.',
  '- Technical credibility: confident, purposeful, never cute.',
  '',
  '### Color palette (STRICT — no other colors)',
  '',
  `${INDUSTRY_BRAND_PALETTE.rule} Every hex literal in your CSS MUST be one of these ${ALL_PALETTE_ENTRIES.length} values: ${PALETTE_LIST_INLINE}. Any other hex (including the orange gradient stops, mid-grays, navy/indigo/teal/purple, Tailwind defaults, or "darkened" variants) is rejected by automated validation.`,
  '',
  'Primary colors:',
  ...PRIMARY_PALETTE_LINES,
  '',
  'Safety colors:',
  ...SAFETY_PALETTE_LINES,
  '',
  '### Dark mode (canonical)',
  '- Page background: Black (#000000)',
  '- Cards / elevated surfaces: Surface (#161413)',
  '- Dividers / borders / strokes: Border (#342F2D)',
  '- Description text / muted body: Gray (#9B8E87)',
  '- Footer / metadata text: Footer Gray (#948781)',
  '- Primary text / headlines: White (#FFFFFF)',
  '- Accent (CTAs, highlights, stat values, chart fills, active states): Industry Orange (#EE6018)',
  '',
  '### Light mode (REQUIRED — single file dual-mode)',
  '- Page background: Light BG (#F2F0F0)',
  '- Cards / elevated surfaces: White (#FFFFFF)',
  '- Dividers / borders / strokes: Border (#342F2D) used at reduced opacity (e.g. `color-mix(in srgb, #342F2D 25%, transparent)`) or as a direct stroke',
  '- Description text / muted body: Footer Gray (#948781)',
  '- Primary text / headlines: Surface (#161413) or Black (#000000)',
  '- Accent: Industry Orange (#EE6018) — IDENTICAL in both modes; do NOT swap the accent',
  '',
  'Do NOT introduce light-mode-only hexes. Only the 11 palette hexes above are permitted, in either mode. If a UI affordance needs intermediate contrast on light surfaces, use opacity/`color-mix` of an existing palette hex; do not invent a new hex.',
  '',
  '### Required dual-mode wiring',
  'Every VISUAL.html you produce MUST:',
  '1. Define dark-mode tokens on `:root` (dark is default).',
  '2. Override those tokens for light mode via BOTH `@media (prefers-color-scheme: light)` and `:root[data-theme="light"]`. Also include `:root[data-theme="dark"]` with the dark declarations so an explicit dark override wins over `prefers-color-scheme`.',
  '3. Set `color-scheme: dark` on `:root` and `color-scheme: light` on the light blocks.',
  '4. Include this exact inline `<script>` in `<head>`, before `<style>`, so it runs synchronously before first paint. It reads `#theme=light|dark` from the URL hash on load and listens for cross-frame messages from the host app:',
  '',
  '```html',
  '<script>',
  '  (function () {',
  '    function applyTheme(t) {',
  '      if (t === "light" || t === "dark") {',
  '        document.documentElement.setAttribute("data-theme", t);',
  '      }',
  '    }',
  '    try {',
  '      var m = (location.hash || "").match(/theme=(light|dark)/);',
  '      if (m) applyTheme(m[1]);',
  '    } catch (e) {}',
  '    window.addEventListener("message", function (event) {',
  '      var data = event && event.data;',
  '      if (data && data.type === "industry:set-theme") applyTheme(data.theme);',
  '    });',
  '  })();',
  '</script>',
  '```',
  '',
  'Do NOT render your own visible theme toggle/button/switch. The host app controls theme via `#theme=…` (for `src=` iframes) or `postMessage({ type: "industry:set-theme", theme })` (for `srcdoc=` iframes).',
  '',
  '### Typography (strict, no exceptions)',
  "- Sans face: 'Geist', system-ui. Weight 300 (Light) for headlines AND body. NEVER bold (no 600/700/800).",
  "- Mono face: 'Geist Mono' or 'Berkeley Mono', monospace. Weight 400 (Regular). Used for labels, metadata, subtitles, captions, numerics, code, timestamps, axis labels.",
  '- Type scale: H1 >= 56px, H2 28px, Body 20px, Caption / label 14px. Stat metric values: Geist 48px, Industry Orange, with a small Geist Mono Gray label underneath.',
  '- Letter spacing: -1% (-0.01em) on all text.',
  "- Numerics: apply CSS `font-feature-settings: 'ss09'` for tabular alignment on metrics, axes, and any numeric column.",
  '- No italic. No underlines except actual links. No raw `<strong>` tags — use weight via class.',
  '- Mono labels are typically uppercase with a small letter-spacing bump (e.g. 0.05em).',
  '',
  '### Layout, borders, radius',
  '- Border weight: 1px default, 2px only for primary flows or emphasized chart frames.',
  '- Border radius: prefer 0px or 4px (subtle). 6px is the upper bound for general containers. NEVER use 12px+, NEVER use rounded-full on rectangular elements — pills only for tags/badges/compliance chips.',
  '- Chart frame / chart bar corner radius: 2px max.',
  '- Diagram nodes: 8px corner radius, 1px border, Surface fill. Active node = Industry Orange border. Optional flow = dashed border.',
  '- Layout density: dense where density serves communication. Whitespace is a tool, not a default.',
  '',
  '### Approved UI patterns (palette-only)',
  '- Stat metric: Industry Orange value (Geist 48px) above a Geist Mono uppercase Gray label, on a Surface card with a Border stroke.',
  '- Compliance / status badge: pill shape, 1px Border stroke, no fill, Geist Mono 12px uppercase.',
  '- Feature card: Surface bg, 1px Border stroke, Geist 20px title, 13px body.',
  '- Charts: vertical bar with SOLID Industry Orange fill (no gradient — gradients use off-palette stops and are banned), 1px Border stroke, 2px corner radius max. Bar title rendered INSIDE the bar in Black or White (whichever contrasts); never mix inside/outside labels in one chart. Grid lines: 1px Border at 0.3-0.5 opacity. Axis lines: 1px Gray.',
  '- Secondary bar (comparison data): stroke only, 1.5px Gray border, no fill.',
  '- Tables: dark surface, 1px Border row borders, Geist Mono uppercase column headers, Geist body cells, tabular numerics.',
  '- Diagrams: 1px lines (2px for primary flow), 90-degree connectors only, small filled-triangle arrows, dashed for optional flows, always label connections. Node labels Geist Mono 14px caps, edge labels 12px Gray, section labels 20px Industry Orange.',
  '',
  '### Iconography',
  '- Use Phosphor Icons (https://phosphoricons.com/) line style only, consistent stroke weight, rendered at 36x36 (or scaled proportionally). Do NOT use Material/Heroicons/Lucide/FontAwesome/emoji.',
  '- Text carries the system — do not lean on icons for meaning. An icon is an accent, never a substitute for a label.',
  '',
  '### Banned visual treatments',
  '- 3D renders, neon / synthwave, gradient meshes, blob shapes.',
  '- Gradients of any kind (the bar-chart gradient stops are NOT on the palette and are banned).',
  '- Emoji anywhere in the visual.',
  '- Stock photography, decorative imagery of people.',
  '- Glassmorphism, heavy drop shadows, glowing borders.',
  '- Generic Tailwind / shadcn / Material gradient cards.',
  '- Any hex literal outside the 11 palette colors above (including off-palette light-mode borders, mid-grays like #4D4D4D/#666666/#888888, or "softened" safety variants).',
  '- Bold Geist (Geist is Light 300 only).',
  '',
  '### Voice and copy (when the visual contains prose)',
  '- Approved words: Drool (not "agent" / "bot" / "assistant"), Autonomous (not "automated"), Delegate (not "ask" / "prompt"), Ship (not "deploy" / "release"), Engineering, Platform, Merge.',
  '- Banned words / phrases: "AI-powered", "leverages", "seamless", "effortless", "next-generation", "cutting-edge", "revolutionize", "disrupt", "synergy", "best-in-class", "intelligent automation", "copilot", "assistant", "helper", "magical".',
  '- Tone: precise, confident, technical, declarative. Short sentences. Active voice. No hedging ("we believe", "we think", "may"). Lead with outcomes, not features. Back claims with concrete numbers.',
  '',
  '### Logo usage (only if you embed a logo)',
  '- Use the inline SVG of the rotor mark or industry lockup; do NOT hotlink remote URLs (the visual must be self-contained).',
  '- White rotor / lockup on dark surfaces; Surface (#161413) or Black rotor / lockup on light surfaces. NEVER recolor the logo Industry Orange. NEVER rotate, stretch, or place on busy backgrounds. Min size 24px.',
  '',
  '### Self-correction rule',
  'If you are updating an existing VISUAL.html and it violates any of the rules above (off-palette hex, wrong typography, missing theme switching, decorative imagery, banned voice), you MUST rebuild the visual from scratch using these tokens rather than patching its data in place. An off-brand visual must not be preserved.',
];

/**
 * Example VISUAL.html injected into the create-automation system prompt
 * as a complete reference dashboard the agent can adapt for any new
 * automation. Imported by both `useCreateAutomation.ts` (v1) and
 * `_prompts.ts` (v2) so the two automation-create flows stay in
 * lock-step.
 *
 * Every hex literal in this template belongs to the 11-color
 * `INDUSTRY_BRAND_PALETTE` above. Light-mode tokens that would normally
 * call for an intermediate gray are produced via low-opacity overlays
 * of an existing palette hex. The `data-industry-visual-scaffold="true"`
 * marker on `<body>` is what tells `decideVisualPolicy` to overwrite
 * this file on the first real agent run.
 */
export const EXAMPLE_VISUAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Automation Visual</title>
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
      --surface-3: #161413;
      --surface-4: #342F2D;
      --text-default: #FFFFFF;
      --text-subheading: #9B8E87;
      --text-muted: #948781;
      --text-label: #9B8E87;
      --border-1: #342F2D;
      --border-2: #342F2D;
      --jade-1: rgba(111, 171, 120, 0.15);
      --jade-border: rgba(111, 171, 120, 0.25);
      --jade-text: #6FAB78;
      --ruby-1: rgba(217, 54, 62, 0.15);
      --ruby-border: rgba(217, 54, 62, 0.25);
      --ruby-text: #D9363E;
      --topaz-1: rgba(240, 163, 48, 0.15);
      --topaz-border: rgba(240, 163, 48, 0.25);
      --topaz-text: #F0A330;
      --mica-accent: #EE6018;
      --font-sans: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      --font-mono: 'Geist Mono', 'Berkeley Mono', 'SF Mono', Monaco, Inconsolata, 'Roboto Mono', Consolas, monospace;
      --radius-sm: 4px;
      --radius-md: 4px;
    }
    /* Light mode uses only the 11 brand-palette hexes. Intermediate
       contrast on light surfaces is produced via low-opacity overlays
       of Surface (#161413) and Border (#342F2D) rather than off-palette
       grays. Safety colors (jade/ruby/topaz) are IDENTICAL in both
       modes per the brand guide. */
    @media (prefers-color-scheme: light) {
      :root:not([data-theme="dark"]) {
        color-scheme: light;
        --page-bg: #F2F0F0;
        --surface-1: #FFFFFF;
        --surface-2: #FFFFFF;
        --surface-3: rgba(22, 20, 19, 0.04);
        --surface-4: rgba(22, 20, 19, 0.08);
        --text-default: #161413;
        --text-subheading: #161413;
        --text-muted: #948781;
        --text-label: #948781;
        --border-1: rgba(52, 47, 45, 0.25);
        --border-2: rgba(52, 47, 45, 0.45);
      }
    }
    :root[data-theme="light"] {
      color-scheme: light;
      --page-bg: #F2F0F0;
      --surface-1: #FFFFFF;
      --surface-2: #FFFFFF;
      --surface-3: rgba(22, 20, 19, 0.04);
      --surface-4: rgba(22, 20, 19, 0.08);
      --text-default: #161413;
      --text-subheading: #161413;
      --text-muted: #948781;
      --text-label: #948781;
      --border-1: rgba(52, 47, 45, 0.25);
      --border-2: rgba(52, 47, 45, 0.45);
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --page-bg: #000000;
      --surface-1: #161413;
      --surface-2: #161413;
      --surface-3: #161413;
      --surface-4: #342F2D;
      --text-default: #FFFFFF;
      --text-subheading: #9B8E87;
      --text-muted: #948781;
      --text-label: #9B8E87;
      --border-1: #342F2D;
      --border-2: #342F2D;
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

    /* --- Typography (Geist Light 300; Geist Mono Regular 400 for labels/numerics; never bold) --- */
    h1 { font-size: 56px; font-weight: 300; letter-spacing: -0.01em; margin-bottom: 8px; }
    h2 { font-size: 28px; font-weight: 300; letter-spacing: -0.01em; margin-bottom: 4px; }
    .subtitle { font-size: 14px; font-family: var(--font-mono); color: var(--text-subheading); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 20px; }
    .section-label {
      font-size: 14px; font-family: var(--font-mono); color: var(--text-subheading); text-transform: uppercase;
      letter-spacing: 0.05em; margin-bottom: 12px;
    }
    .text-block { font-size: 20px; font-weight: 300; color: var(--text-label); line-height: 1.5; margin-bottom: 12px; }
    .text-block-sm { font-size: 14px; color: var(--text-muted); line-height: 1.5; }
    .mono { font-family: var(--font-mono); font-size: 14px; font-feature-settings: 'ss09'; }

    /* --- Separator --- */
    .separator { border: none; border-top: 1px solid var(--border-1); margin: 20px 0; }

    /* --- Badge --- */
    .badge {
      display: inline-flex; padding: 2px 8px; border-radius: 2px;
      font-size: 11px; font-weight: 500; letter-spacing: 0.2px;
    }
    .badge-success { background: var(--jade-1); color: var(--jade-text); }
    .badge-warning { background: var(--topaz-1); color: var(--topaz-text); }
    .badge-error { background: var(--ruby-1); color: var(--ruby-text); }
    .badge-neutral { background: var(--surface-4); color: var(--text-label); }
    .badge-group { display: flex; gap: 6px; flex-wrap: wrap; }

    /* --- Alert --- */
    .alert {
      display: flex; align-items: flex-start; gap: 10px; padding: 12px;
      border-radius: var(--radius-sm); margin-bottom: 8px; border: 1px solid;
    }
    .alert-success { background: var(--jade-1); border-color: var(--jade-border); }
    .alert-warning { background: var(--topaz-1); border-color: var(--topaz-border); }
    .alert-error { background: var(--ruby-1); border-color: var(--ruby-border); }
    .alert-dot { width: 6px; height: 6px; border-radius: 50%; margin-top: 5px; flex-shrink: 0; }
    .alert-success .alert-dot { background: var(--jade-text); }
    .alert-warning .alert-dot { background: var(--topaz-text); }
    .alert-error .alert-dot { background: var(--ruby-text); }
    .alert-content { flex: 1; }
    .alert-title { font-size: 12px; font-weight: 500; margin-bottom: 2px; }
    .alert-text { font-size: 12px; color: var(--text-muted); line-height: 1.4; }

    /* --- Card --- */
    .card {
      background: var(--surface-2); border: 1px solid var(--border-1);
      border-radius: var(--radius-md); padding: 16px; margin-bottom: 12px;
    }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .card-title { font-size: 13px; font-weight: 500; }
    .card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }

    /* --- Metric card (orange Geist 48px value, Geist Mono uppercase gray label) --- */
    .metric { background: var(--surface-2); border: 1px solid var(--border-1); border-radius: var(--radius-sm); padding: 16px; }
    .metric-label { font-size: 14px; font-family: var(--font-mono); color: var(--text-subheading); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
    .metric-value { font-size: 48px; font-weight: 300; color: var(--mica-accent); line-height: 1; font-feature-settings: 'ss09'; }
    .metric-sub { font-size: 14px; color: var(--text-muted); margin-top: 4px; }
    .metrics-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 16px; }

    /* --- Table (Geist Mono uppercase column headers; tabular numerics) --- */
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; font-feature-settings: 'ss09'; }
    th { text-align: left; padding: 8px 12px; font-size: 14px; font-family: var(--font-mono); color: var(--text-subheading); text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--border-2); font-weight: 400; }
    td { padding: 8px 12px; border-bottom: 1px solid var(--border-1); color: var(--text-label); font-weight: 300; }
    tr:last-child td { border-bottom: none; }
    td .mono { color: var(--text-muted); }

    /* --- Tabs --- */
    .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border-1); margin-bottom: 16px; }
    .tab { padding: 8px 16px; font-size: 12px; color: var(--text-muted); cursor: pointer; border-bottom: 2px solid transparent; }
    .tab.active { color: var(--text-default); border-bottom-color: var(--mica-accent); }

    /* --- Progress bar --- */
    .progress-track { height: 4px; background: var(--surface-4); border-radius: 2px; overflow: hidden; }
    .progress-fill { height: 100%; border-radius: 2px; }
    .progress-fill-success { background: var(--jade-text); }
    .progress-fill-warning { background: var(--topaz-text); }
    .progress-fill-error { background: var(--ruby-text); }

    /* --- Kbd --- */
    kbd {
      display: inline-flex; padding: 2px 6px; font-size: 11px; font-family: var(--font-mono);
      background: var(--surface-4); border: 1px solid var(--border-2); border-radius: 3px; color: var(--text-label);
    }

    /* --- Empty state --- */
    .empty-state { text-align: center; padding: 32px; color: var(--text-subheading); font-size: 12px; }

    /* --- Text area / code block --- */
    .code-block {
      background: var(--surface-3); border: 1px solid var(--border-1); border-radius: var(--radius-sm);
      padding: 12px 16px; font-family: var(--font-mono); font-size: 12px; line-height: 1.6;
      color: var(--text-label); white-space: pre-wrap; overflow-x: auto; margin-bottom: 12px;
    }

    /* --- Item list --- */
    .item-list { list-style: none; }
    .item { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--border-1); }
    .item:last-child { border-bottom: none; }
    .item-icon { width: 28px; height: 28px; border-radius: var(--radius-sm); background: var(--surface-4); display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; }
    .item-content { flex: 1; min-width: 0; }
    .item-title { font-size: 12px; font-weight: 500; }
    .item-sub { font-size: 11px; color: var(--text-muted); }

    /* --- Skeleton --- */
    .skeleton { background: var(--surface-4); border-radius: var(--radius-sm); animation: pulse 1.5s ease-in-out infinite; }
    .skeleton-text { height: 12px; margin-bottom: 8px; }
    .skeleton-heading { height: 18px; width: 40%; margin-bottom: 12px; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  </style>
</head>
<!--
  The scaffold marker on the body tells later scheduled runs that this file is
  still the initial "awaiting first run" template and they should rebuild it
  from scratch. Remove that body attribute after the first real run populates
  the dashboard with actual data.
-->
<body data-industry-visual-scaffold="true">
  <div class="container">
    <!-- Header with title and subtitle. REPLACE the h1 with the new automation's name; never leave "Automation Report" or carry over a sibling automation's heading. -->
    <h1><!-- automation name goes here --></h1>
    <div class="subtitle">Last updated: -- &middot; Run #1</div>

    <!-- Metric cards row -->
    <div class="section-label">Overview</div>
    <div class="metrics-row">
      <div class="metric">
        <div class="metric-label">Items Processed</div>
        <div class="metric-value">--</div>
        <div class="metric-sub">waiting for first run</div>
      </div>
      <div class="metric">
        <div class="metric-label">Status</div>
        <div class="metric-value"><span class="badge badge-neutral">Pending</span></div>
        <div class="metric-sub">no data yet</div>
      </div>
      <div class="metric">
        <div class="metric-label">Completion</div>
        <div class="metric-value">0%</div>
        <div class="progress-track" style="margin-top:8px"><div class="progress-fill progress-fill-success" style="width:0%"></div></div>
      </div>
    </div>

    <hr class="separator">

    <!-- Badges -->
    <div class="section-label">Badges</div>
    <div class="badge-group" style="margin-bottom:16px">
      <span class="badge badge-success">Passing</span>
      <span class="badge badge-warning">Needs Review</span>
      <span class="badge badge-error">Failed</span>
      <span class="badge badge-neutral">Skipped</span>
    </div>

    <hr class="separator">

    <!-- Alerts -->
    <div class="section-label">Alerts</div>
    <div class="alert alert-success">
      <div class="alert-dot"></div>
      <div class="alert-content">
        <div class="alert-title">All checks passing</div>
        <div class="alert-text">No issues detected in the latest run.</div>
      </div>
    </div>
    <div class="alert alert-warning">
      <div class="alert-dot"></div>
      <div class="alert-content">
        <div class="alert-title">Threshold approaching</div>
        <div class="alert-text">Metric X is at 82%, approaching the 85% warning threshold.</div>
      </div>
    </div>
    <div class="alert alert-error">
      <div class="alert-dot"></div>
      <div class="alert-content">
        <div class="alert-title">Critical failure</div>
        <div class="alert-text">Process Y failed with exit code 1. See details below.</div>
      </div>
    </div>

    <hr class="separator">

    <!-- Tabs -->
    <div class="tabs">
      <div class="tab active">Summary</div>
      <div class="tab">Details</div>
      <div class="tab">History</div>
    </div>

    <!-- Text block (large text blob) -->
    <div class="section-label">Summary</div>
    <div class="text-block">
      This section is for longer-form text content. Each run should replace this with a
      human-readable summary of what happened, what changed, and what needs attention.
      Keep it scannable: lead with the most important findings, then add supporting detail.
    </div>
    <div class="text-block-sm">
      Additional context or secondary findings go here. This uses the smaller muted style
      for supplementary information that doesn't need to be read first.
    </div>

    <hr class="separator">

    <!-- Code block / log output -->
    <div class="section-label">Output</div>
    <div class="code-block">$ automation run --verbose
[info] Starting scan...
[info] Checked 142 items in 3.2s
[warn] 3 items flagged for review
[info] Report written to ./reports/2025-01-15-09-30.md
[info] Done.</div>

    <hr class="separator">

    <!-- Table -->
    <div class="section-label">Details</div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Status</th><th>Value</th><th>Updated</th></tr>
          </thead>
          <tbody>
            <tr><td>Item Alpha</td><td><span class="badge badge-success">OK</span></td><td class="mono">98.2%</td><td class="mono">2m ago</td></tr>
            <tr><td>Item Beta</td><td><span class="badge badge-warning">Warning</span></td><td class="mono">82.1%</td><td class="mono">5m ago</td></tr>
            <tr><td>Item Gamma</td><td><span class="badge badge-error">Failed</span></td><td class="mono">0%</td><td class="mono">12m ago</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <hr class="separator">

    <!-- Item list -->
    <div class="section-label">Recent Activity</div>
    <div class="card">
      <ul class="item-list">
        <li class="item">
          <div class="item-icon">1</div>
          <div class="item-content">
            <div class="item-title">First event description</div>
            <div class="item-sub">2 minutes ago &middot; <span class="badge badge-success" style="font-size:10px">success</span></div>
          </div>
        </li>
        <li class="item">
          <div class="item-icon">2</div>
          <div class="item-content">
            <div class="item-title">Second event description</div>
            <div class="item-sub">15 minutes ago &middot; <span class="badge badge-warning" style="font-size:10px">review</span></div>
          </div>
        </li>
        <li class="item">
          <div class="item-icon">3</div>
          <div class="item-content">
            <div class="item-title">Third event description</div>
            <div class="item-sub">1 hour ago &middot; <span class="badge badge-neutral" style="font-size:10px">info</span></div>
          </div>
        </li>
      </ul>
    </div>

    <hr class="separator">

    <!-- Cards grid -->
    <div class="section-label">Cards</div>
    <div class="card-grid">
      <div class="card">
        <div class="card-header">
          <span class="card-title">Category A</span>
          <span class="badge badge-success">3 items</span>
        </div>
        <div class="text-block-sm">Summary of category A findings with relevant context for the user.</div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">Category B</span>
          <span class="badge badge-warning">1 item</span>
        </div>
        <div class="text-block-sm">Summary of category B findings. Flagged for review due to threshold.</div>
      </div>
    </div>

    <hr class="separator">

    <!-- Empty state -->
    <div class="section-label">Pending Section</div>
    <div class="card">
      <div class="empty-state">No data yet. This section will populate after the first run.</div>
    </div>

    <hr class="separator">

    <!-- Keyboard shortcuts / Kbd -->
    <div class="section-label">Shortcuts</div>
    <div class="text-block-sm" style="margin-bottom:8px">
      Press <kbd>R</kbd> to refresh &middot; <kbd>Ctrl</kbd>+<kbd>S</kbd> to save &middot; <kbd>Esc</kbd> to close
    </div>

    <!-- Skeleton loading state -->
    <div class="section-label" style="margin-top:16px">Loading State</div>
    <div class="card">
      <div class="skeleton skeleton-heading"></div>
      <div class="skeleton skeleton-text" style="width:100%"></div>
      <div class="skeleton skeleton-text" style="width:85%"></div>
      <div class="skeleton skeleton-text" style="width:60%"></div>
    </div>
  </div>
</body>
</html>`;
