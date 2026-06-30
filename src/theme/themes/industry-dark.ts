import { BuiltInThemeName } from '@industry/common/settings/enums';

import type { DroolTheme } from '@/theme/types';

/**
 * Industry Dark — the default Drool theme.
 *
 * All hex values are the exact ANSI-256-safe colors the CLI used
 * before the theme system was introduced, preserving the original
 * warm-gray aesthetic from the Mission Control reskin.
 */
// eslint-disable-next-line industry/constants-file-organization
export const industryDark: DroolTheme = {
  name: BuiltInThemeName.IndustryDark,
  appearance: 'dark',

  colors: {
    // ── Chat palette (original COLORS_DARK) ──────────────────────────
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    primary: '#5fafd7', // Gura blue
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    border: '#878787', // 102 – medium gray
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    success: '#afaf5f', // 41  – green
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    error: '#d75f5f', // 167 – muted red
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    warning: '#87d7ff', // soft aqua
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    spec: '#afafff', // 147 – lavender
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    agi: '#afaf5f', // olive yellow-green for mission/orchestrator UI
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    btw: '#8fb9c9', // muted cyan for /btw side-conversations
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    asciiArt: '#5fafd7', // Gura blue
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    headerLogo: '#eeeeee', // 255 – near-white (DROOL ASCII logo)
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    toolName: '#87d7ff', // soft aqua
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    toolParam: '#b2b2b2', // 249 – MC tool param gray
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    hookBadgeBg: '#af87ff', // 141 – purple
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    hookBadgeFg: '#000000', // 0   – black
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    toolBadgeBg: '#7ddcff', // Gura badge blue
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    toolBadgeFg: '#000000', // 0   – black
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    statusActive: '#00ff00', // bright green for active status dots
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    highlight: '#00afff', // bright Gura highlight
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    highlightDanger: '#d75f5f', // 167 – muted red
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    disconnected: '#ff8787', // 210 – soft red
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    gitAdditions: '#7db87a', // pastel green for +lines
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    gitDeletions: '#b87a7a', // pastel red for -lines
    text: {
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      primary: '#eeeeee', // 255 – near-white
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      secondary: '#a8a8a8', // 248 – light gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      muted: '#767676', // 243 – mid gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      userText: '#D8D4D2', // warm near-white
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      userBg: '#262626', // 235 – slightly lighter than terminal bg for user messages
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      userSymbol: '#5fafd7', // Gura blue vertical bar
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      helpKey: '#908a86', // help bar keyboard shortcuts
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      helpLabel: '#645e5a', // help bar descriptions
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      menuTitle: '#eeeeee', // near-white – menu titles
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      menuSectionHeader: '#eeeeee', // near-white – menu section headers
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      modelMultiplier: '#5f8787', // model token multiplier
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      queuedSymbol: '#2f87af', // dim Gura blue left bar
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      queuedText: '#8a8a8a', // gray – queued message text
    },
    diff: {
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      added: '#5fff5f', // 83  – bright green
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      addedBg: '#0a2e10', // dark green bg
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      addedWordBg: '#1a5a22', // brighter green for word highlights
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      removed: '#ff5f5f', // 203 – red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      removedBg: '#2e0a0a', // dark red bg
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      removedWordBg: '#5a1a1a', // brighter red for word highlights
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      border: '#585858', // 240 – dark gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      lineNumber: '#767676', // 243 – mid gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      header: '#5fafd7', // 74  – steel blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      unchanged: '#767676', // 243 – mid gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      dimUnchanged: '#5f5f5f', // 59  – dim gray
    },

    // ── Markdown rendering ──────────────────────────────────────────
    markdown: {
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      bold: '#bcbcbc', // 250 – light gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      italic: '#bcbcbc', // 250 – light gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      code: '#8a8a8a', // 245 – medium gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      link: '#af87af', // 139 – muted purple
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      heading: '#dadada', // 253 – near-white
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      blockquote: '#8a8a8a', // 245 – medium gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      strikethrough: '#8a8a8a', // 245 – medium gray
    },

    // ── Mermaid diagram rendering ──────────────────────────────────────
    mermaid: {
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      text: '#dadada', // 253 – near-white labels
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      border: '#878787', // 102 – medium gray box borders
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      line: '#626262', // 241 – dim gray edge paths
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      arrow: '#87d7ff', // soft aqua arrowheads
    },

    // ── Mission Control palette (original MC_COLORS_DARK) ────────────
    mc: {
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      emphasis: '#eeeeee', // 255 – Titles, active items, counts
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      primary: '#dadada', // 253 – Main readable text
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      secondary: '#8a8a8a', // 245 – Supporting info, labels
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      tertiary: '#626262', // 241 – Bullets, timestamps
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      ghost: '#3a3a3a', // 237 – Barely visible structural hints
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      dataValue: '#9e9e9e', // 247 – Key data points
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      paused: '#dadada', // 253 – Paused progress bar
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      border: '#4e4e4e', // 239 – Dark gray border
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      active: '#00afff', // bright Gura blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      done: '#afaf5f', // 143 – Olive yellow-green
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      fail: '#af5f5f', // 131 – Wine
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      info: '#626262', // 241 – Info text
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      ref: '#5f8787', // 66  – Feature references
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      worker: '#878787', // 244 – Worker IDs
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      progress: '#00d75f', // 42  – Green progress bar
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      barFillFrom: '#00afff', // bright Gura blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      barFillTo: '#00afff', // bright Gura blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      barEmpty: '#585858', // 240 – Empty bar ░
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      hlBg: '#0b3a53', // deep ocean highlight background
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      hlFg: '#d8f3ff', // pale aqua highlight foreground
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      t2: '#e4e4e4', // 254 – Assistant message text
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      t4: '#bcbcbc', // 250 – Section headers
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      t6: '#b2b2b2', // 249 – Tool names, tool params
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      t9: '#808080', // 244 – Bullet item text
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      t12: '#626262', // 241 – "+N more" text, timestamps
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      ts: '#626262', // 241 – Progress log timestamps
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      qb: '#585858', // 240 – Blockquote ▌
    },

    // ── Syntax highlighting ─────────────────────────────────────────
    syntax: {
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-keyword': '#afafff', // lavender (magenta slot)
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-built_in': '#5f8787', // teal (cyan slot)
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-type': '#87d7ff', // soft aqua
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-literal': '#87d7ff', // soft aqua
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-number': '#87d7ff', // soft aqua
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-string': '#00d75f', // green
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-doctag': '#00d75f', // green
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-quote': '#00d75f', // green
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-comment': '#767676', // mid gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-function': '#5fafd7', // steel blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-class': '#5fafd7', // steel blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-title': '#5fafd7', // steel blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-variable': '#d75f5f', // muted red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-attr': '#d75f5f', // muted red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-property': '#5f8787', // teal
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-tag': '#d75f5f', // muted red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-name': '#d75f5f', // muted red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-selector-tag': '#d75f5f', // muted red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-selector-class': '#87d7ff', // soft aqua
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-selector-id': '#87d7ff', // soft aqua
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-value': '#00d75f', // green
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-params': '#eeeeee', // near-white
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-meta': '#767676', // mid gray
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-regexp': '#d75f5f', // muted red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-operator': '#eeeeee', // near-white
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-punctuation': '#eeeeee', // near-white
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-symbol': '#5f8787', // teal
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-bullet': '#5f8787', // teal
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-link': '#5fafd7', // steel blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-emphasis': '#eeeeee', // near-white
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-strong': '#eeeeee', // near-white
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-section': '#5fafd7', // steel blue
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-addition': '#00d75f', // green
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-deletion': '#d75f5f', // muted red
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-subst': '#eeeeee', // near-white
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-template-tag': '#afafff', // lavender
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      'hljs-template-variable': '#d75f5f', // muted red
    },
  },

  // ── Terminal ANSI palette (OSC overrides) ────────────────────────
  // Defines what the ANSI names in syntax colors resolve to.
  terminal: {
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    background: '#1c1c1c', // 234 – near-black
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    foreground: '#eeeeee', // 255 – near-white
    // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
    cursor: '#5fafd7', // Gura blue
    ansi: {
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      black: '#1c1c1c', // 234
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      red: '#d75f5f', // 167
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      green: '#00d75f', // 41
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      yellow: '#87d7ff',
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      blue: '#5fafd7', // 74
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      magenta: '#afafff', // 147
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      cyan: '#5f8787', // 66
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      white: '#dadada', // 253
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      brightBlack: '#767676', // 243
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      brightRed: '#ff5f5f', // 203
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      brightGreen: '#5fff5f', // 83
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      brightYellow: '#d8f3ff',
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      brightBlue: '#87afd7', // 110
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      brightMagenta: '#d7afff', // 183
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      brightCyan: '#87d7d7', // 116
      // eslint-disable-next-line no-restricted-syntax -- PLT-76: migrated from file-level disable
      brightWhite: '#eeeeee', // 255
    },
  },
};
