import { BuiltInThemeName } from '@industry/common/settings/enums';

import type { DroolTheme } from '@/theme/types';

/**
 * Industry Light — a crisp, standalone light terminal theme.
 *
 * Designed for bright backgrounds with strong contrast ratios.
 * Every color has been chosen to be legible on a light (#f5f5f5) canvas.
 */
// eslint-disable-next-line industry/constants-file-organization
export const industryLight: DroolTheme = {
  name: BuiltInThemeName.IndustryLight,
  appearance: 'light',

  colors: {
    // ── Chat palette ────────────────────────────────────────────────
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    primary: '#0077b6', // Gura blue, visible on light bg
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    border: '#b0b0b0', // soft gray border, visible but not harsh
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    success: '#2e7d32', // deep green – strong contrast on light
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    error: '#c62828', // deep red
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    warning: '#0096c7', // ocean blue, distinct from primary
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    spec: '#0057a8', // deep blue – strong readability
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    agi: '#2e7d32', // deep green
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    btw: '#3d7a92', // deep teal for /btw side-conversations
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    asciiArt: '#0077b6', // Gura blue
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    headerLogo: '#000000', // black – DROOL ASCII logo
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    toolName: '#005f87', // deep ocean blue
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    toolParam: '#5a5a5a', // dark gray
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    hookBadgeBg: '#7b1fa2', // deep purple
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    hookBadgeFg: '#ffffff', // white
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    toolBadgeBg: '#90e0ef', // pale Gura blue
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    toolBadgeFg: '#000000', // black
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    statusActive: '#00c853', // bright green for active status dots
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    highlight: '#0096c7', // bright ocean blue
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    highlightDanger: '#c62828', // deep red
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    disconnected: '#ef5350', // bright red
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    gitAdditions: '#659e62', // pastel green for +lines
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    gitDeletions: '#9e6262', // pastel red for -lines
    text: {
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      primary: '#1a1a1a', // near-black – maximum readability
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      secondary: '#4a4a4a', // dark gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      muted: '#6b6b6b', // mid gray – still readable on light
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      userText: '#000000', // black – user message text
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      userBg: '#e8e8e8', // light gray – user message background
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      userSymbol: '#0077b6', // Gura blue user message left bar
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      helpKey: '#000000', // black – help bar keyboard shortcuts
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      helpLabel: '#8a8a8a', // help bar descriptions
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      menuTitle: '#000000', // black – menu titles
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      menuSectionHeader: '#000000', // black – menu section headers
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      modelMultiplier: '#8a8a8a', // model token multiplier
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      queuedSymbol: '#4a90a4', // muted Gura blue queued message left bar
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      queuedText: '#6b6b6b', // mid gray – queued message text
    },
    diff: {
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      added: '#2e7d32', // deep green – readable on light bg
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      addedBg: '#90c898', // light green bg
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      addedWordBg: '#60a868', // brighter green for word highlights
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      removed: '#c62828', // deep red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      removedBg: '#e8b0b4', // light red bg
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      removedWordBg: '#c87878', // brighter red for word highlights
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      border: '#b0b0b0', // medium gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      lineNumber: '#8a8a8a', // subdued gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      header: '#0057a8', // deep blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      unchanged: '#8a8a8a', // subdued gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      dimUnchanged: '#b0b0b0', // lighter gray
    },

    // ── Markdown rendering ──────────────────────────────────────────
    markdown: {
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      bold: '#1a1a1a', // near-black
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      italic: '#4a4a4a', // dark gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      code: '#5a5a5a', // medium-dark gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      link: '#0057a8', // deep blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      heading: '#1a1a1a', // near-black
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      blockquote: '#6b6b6b', // mid gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      strikethrough: '#8a8a8a', // subdued gray
    },

    // ── Mermaid diagram rendering ──────────────────────────────────────
    mermaid: {
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      text: '#1a1a1a', // near-black labels
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      border: '#b0b0b0', // soft gray box borders
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      line: '#7a7a7a', // mid gray edge paths
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      arrow: '#005f87', // deep ocean blue arrowheads
    },

    // ── Mission Control palette ─────────────────────────────────────
    mc: {
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      emphasis: '#1a1a1a', // Titles, active items, counts
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      primary: '#2a2a2a', // Main readable text
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      secondary: '#5a5a5a', // Supporting info, labels
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      tertiary: '#7a7a7a', // Bullets, timestamps
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      ghost: '#c8c8c8', // Barely visible structural hints
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      dataValue: '#3a3a3a', // Key data points – dark enough to pop
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      paused: '#7a7a7a', // Paused progress bar
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      border: '#b0b0b0', // Medium gray border
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      active: '#0077b6', // Gura blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      done: '#2e7d32', // Deep green
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      fail: '#c62828', // Deep red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      info: '#7a7a7a', // Info text
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      ref: '#00695c', // Dark teal – readable on light
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      worker: '#5a5a5a', // Worker IDs
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      progress: '#2e7d32', // Green progress bar
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      barFillFrom: '#0077b6', // Gradient start, Gura blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      barFillTo: '#00b4d8', // Gradient end, bright aqua
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      barEmpty: '#d8d8d8', // Light gray empty bar
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      hlBg: '#d8f3ff', // Pale aqua highlight bg
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      hlFg: '#003049', // Deep blue text on light highlight
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      t2: '#1a1a1a', // Assistant message text
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      t4: '#4a4a4a', // Section headers
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      t6: '#5a5a5a', // Tool names, tool params
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      t9: '#6b6b6b', // Bullet item text
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      t12: '#8a8a8a', // "+N more" text, timestamps
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      ts: '#8a8a8a', // Progress log timestamps
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      qb: '#c8c8c8', // Blockquote ▌
    },

    // ── Syntax highlighting ─────────────────────────────────────────
    syntax: {
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-keyword': '#7b1fa2', // purple – keywords pop on light
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-built_in': '#00695c', // dark teal
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-type': '#c62828', // deep red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-literal': '#c62828', // deep red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-number': '#c62828', // deep red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-string': '#2e7d32', // deep green
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-doctag': '#2e7d32', // deep green
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-quote': '#2e7d32', // deep green
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-comment': '#8a8a8a', // gray – subdued but visible
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-function': '#0057a8', // deep blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-class': '#0057a8', // deep blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-title': '#0057a8', // deep blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-variable': '#6a1b9a', // dark purple
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-attr': '#6a1b9a', // dark purple
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-property': '#00695c', // dark teal
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-tag': '#c62828', // deep red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-name': '#c62828', // deep red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-selector-tag': '#c62828', // deep red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-selector-class': '#005f87', // deep ocean blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-selector-id': '#005f87', // deep ocean blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-value': '#2e7d32', // deep green
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-params': '#1a1a1a', // near-black
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-meta': '#8a8a8a', // gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-regexp': '#c62828', // deep red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-operator': '#1a1a1a', // near-black
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-punctuation': '#4a4a4a', // dark gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-symbol': '#00695c', // dark teal
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-bullet': '#00695c', // dark teal
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-link': '#0057a8', // deep blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-emphasis': '#1a1a1a', // near-black
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-strong': '#1a1a1a', // near-black
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-section': '#0057a8', // deep blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-addition': '#2e7d32', // deep green
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-deletion': '#c62828', // deep red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-subst': '#1a1a1a', // near-black
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-template-tag': '#7b1fa2', // purple
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-template-variable': '#6a1b9a', // dark purple
    },
  },

  // ── Terminal ANSI palette (OSC overrides for light bg) ───────────
  terminal: {
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    background: '#f5f5f5', // warm light gray bg
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    foreground: '#1a1a1a', // near-black text
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    cursor: '#0077b6', // Gura blue
    ansi: {
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      black: '#1a1a1a', // near-black
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      red: '#c62828', // deep red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      green: '#2e7d32', // deep green
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      yellow: '#0096c7', // ocean blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      blue: '#0057a8', // deep blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      magenta: '#7b1fa2', // deep purple
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      cyan: '#00695c', // dark teal
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      white: '#f5f5f5', // light bg
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      brightBlack: '#8a8a8a', // mid gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      brightRed: '#ef5350', // bright red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      brightGreen: '#43a047', // bright green
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      brightYellow: '#90e0ef', // pale Gura blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      brightBlue: '#1e88e5', // bright blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      brightMagenta: '#ab47bc', // bright purple
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      brightCyan: '#00897b', // bright teal
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      brightWhite: '#ffffff', // white
    },
  },
};
