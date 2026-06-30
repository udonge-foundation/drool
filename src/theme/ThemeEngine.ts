/**
 * ThemeEngine — singleton that manages the active theme and applies
 * OSC escape sequences to override the terminal's ANSI palette.
 */
import { BuiltInThemeName } from '@industry/common/settings/enums';

import type { ColorPalette } from '@/components/chat/types';
import type { McColorPalette } from '@/components/mission-control/types';
import { loadUserThemes } from '@/theme/themeLoader';
import { builtInThemes, industryDark } from '@/theme/themes';
import type {
  AnsiPalette,
  DroolTheme,
  ResolvedTheme,
  ThemeMarkdownColors,
} from '@/theme/types';
import { SHUTDOWN_HOOK_PRIORITY } from '@/utils/constants';
import { getShutdownCoordinator } from '@/utils/shutdownCoordinator';

/** Ordered ANSI-16 color names matching OSC 4 indices 0–15 */
const ANSI_INDEX_ORDER: (keyof AnsiPalette)[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
];

/** Default MC palette — matches the industry-dark theme */
const DEFAULT_MC: McColorPalette = industryDark.colors.mc as McColorPalette;

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T>
): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const val = override[key];
    if (
      val !== undefined &&
      typeof val === 'object' &&
      val !== null &&
      !Array.isArray(val) &&
      typeof result[key] === 'object' &&
      result[key] !== null
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as Record<string, unknown>
      ) as T[keyof T];
    } else if (val !== undefined) {
      result[key] = val as T[keyof T];
    }
  }
  return result;
}

class ThemeEngineImpl {
  private activeTheme: ResolvedTheme;

  private allThemes: Map<string, DroolTheme> = new Map();

  private terminalOverridden = false;

  private overrideTerminalColors = false;

  private shutdownHookRegistered = false;

  /**
   * Detected terminal appearance. Set once at startup by main.tsx after
   * the OSC 11 query resolves; consumed by `loadTheme(BuiltInThemeName.Auto)`.
   * Defaults to 'dark' so anything that calls loadTheme(Auto) before
   * detection completes still gets a sane palette.
   */
  private detectedAppearance: 'light' | 'dark' = 'dark';

  /**
   * True when the current activeTheme was resolved from BuiltInThemeName.Auto.
   * Lets the theme selector show "auto (currently industry-light)".
   */
  private resolvedFromAuto = false;

  constructor() {
    this.activeTheme = this.resolveTheme(industryDark);
    this.rebuildThemeMap();
  }

  /** Rebuild the combined map of built-in + user themes */
  private rebuildThemeMap(): void {
    this.allThemes.clear();
    for (const [name, theme] of Object.entries(builtInThemes)) {
      this.allThemes.set(name, theme);
    }
    for (const userTheme of loadUserThemes()) {
      this.allThemes.set(userTheme.name, userTheme);
    }
  }

  /** Resolve a theme by following its `extends` chain */
  private resolveTheme(theme: DroolTheme): ResolvedTheme {
    if (!theme.extends) {
      return { ...theme };
    }

    const visited = new Set<string>();
    let current = theme;
    const chain: DroolTheme[] = [current];

    while (current.extends && !visited.has(current.extends)) {
      visited.add(current.extends);
      const parent =
        this.allThemes.get(current.extends) ?? builtInThemes[current.extends];
      if (!parent) break;
      chain.push(parent);
      current = parent;
    }

    // Merge from base (last) to leaf (first)
    let merged: DroolTheme = { ...chain[chain.length - 1] };
    for (let i = chain.length - 2; i >= 0; i--) {
      merged = deepMerge(
        merged as unknown as Record<string, unknown>,
        chain[i] as unknown as Partial<Record<string, unknown>>
      ) as unknown as DroolTheme;
    }

    const { extends: _ext, ...rest } = merged;
    return rest;
  }

  /**
   * Set the terminal appearance detected at startup. Used by
   * `loadTheme(BuiltInThemeName.Auto)` to pick between industry-light and
   * industry-dark. Should be called before render(), after OSC 11 detection
   * finishes.
   */
  setDetectedAppearance(appearance: 'light' | 'dark'): void {
    this.detectedAppearance = appearance;
    if (this.resolvedFromAuto) {
      // Re-resolve so the in-memory active theme reflects the latest
      // detection if anyone has already loaded the Auto sentinel.
      this.loadTheme(BuiltInThemeName.Auto);
    }
  }

  /** Resolve BuiltInThemeName.Auto to a concrete theme name. */
  resolveAutoTheme(): BuiltInThemeName {
    return this.detectedAppearance === 'light'
      ? BuiltInThemeName.IndustryLight
      : BuiltInThemeName.IndustryDark;
  }

  /** True when the active theme was loaded via the Auto sentinel. */
  isResolvedFromAuto(): boolean {
    return this.resolvedFromAuto;
  }

  /** Load and activate a theme by name */
  loadTheme(name: string): boolean {
    this.rebuildThemeMap();

    if (name === BuiltInThemeName.Auto) {
      const resolvedName = this.resolveAutoTheme();
      const theme = this.allThemes.get(resolvedName);
      if (!theme) return false;
      this.activeTheme = this.resolveTheme(theme);
      this.resolvedFromAuto = true;
      return true;
    }

    const theme = this.allThemes.get(name);
    if (!theme) return false;

    this.activeTheme = this.resolveTheme(theme);
    if (this.allThemes.get(name) && !builtInThemes[name]) {
      this.activeTheme.isUserTheme = true;
    }
    this.resolvedFromAuto = false;
    return true;
  }

  /** Get the currently active theme name */
  getActiveThemeName(): string {
    return this.activeTheme.name;
  }

  /** Get whether the currently active theme is light or dark */
  getActiveThemeAppearance(): ResolvedTheme['appearance'] {
    return this.activeTheme.appearance;
  }

  /** Get all available theme names */
  getAvailableThemes(): Array<{
    name: string;
    appearance: string;
    isUserTheme: boolean;
  }> {
    this.rebuildThemeMap();
    return Array.from(this.allThemes.entries()).map(([name, theme]) => ({
      name,
      appearance: theme.appearance,
      isUserTheme: !builtInThemes[name],
    }));
  }

  /** Map resolved theme colors to the ColorPalette interface */
  getColors(): ColorPalette {
    const c = this.activeTheme.colors;
    return {
      primary: c.primary,
      border: c.border,
      success: c.success,
      error: c.error,
      warning: c.warning,
      spec: c.spec,
      agi: c.agi,
      btw: c.btw,
      queuedAccentPurple: this.activeTheme.terminal?.ansi?.magenta ?? c.spec,
      asciiArt: c.asciiArt,
      headerLogo: c.headerLogo,
      toolName: c.toolName,
      toolParam: c.toolParam,
      hookBadgeBg: c.hookBadgeBg,
      hookBadgeFg: c.hookBadgeFg,
      toolBadgeBg: c.toolBadgeBg,
      toolBadgeFg: c.toolBadgeFg,
      statusActive: c.statusActive,
      highlight: c.highlight,
      highlightDanger: c.highlightDanger,
      disconnected: c.disconnected,
      gitAdditions: c.gitAdditions ?? 'magenta',
      gitDeletions: c.gitDeletions ?? 'cyan',
      text: {
        primary: c.text.primary,
        secondary: c.text.secondary,
        muted: c.text.muted,
        userText: c.text.userText ?? c.text.user ?? 'black',
        userBg: c.text.userBg ?? '',
        userSymbol: c.text.userSymbol ?? c.border,
        helpKey: c.text.helpKey ?? c.text.muted,
        helpLabel: c.text.helpLabel ?? c.text.muted,
        menuTitle: c.text.menuTitle ?? c.text.primary,
        menuSectionHeader: c.text.menuSectionHeader ?? c.text.primary,
        modelMultiplier: c.text.modelMultiplier ?? c.text.muted,
        queuedSymbol: c.text.queuedSymbol ?? c.primary,
        queuedText: c.text.queuedText ?? c.text.muted,
        info: c.text.info ?? c.spec,
      },
      diff: {
        added: {
          text: c.diff.added,
          bg: c.diff.addedBg ?? '',
          wordBg: c.diff.addedWordBg ?? '',
        },
        removed: {
          text: c.diff.removed,
          bg: c.diff.removedBg ?? '',
          wordBg: c.diff.removedWordBg ?? '',
        },
        border: c.diff.border,
        lineNumber: c.diff.lineNumber,
        header: c.diff.header,
        unchanged: {
          text: c.diff.unchanged,
          dimText: c.diff.dimUnchanged,
        },
      },
      markdown: { ...c.markdown },
      mermaid: {
        text: c.mermaid?.text ?? c.text.primary,
        border: c.mermaid?.border ?? c.border,
        line: c.mermaid?.line ?? c.text.muted,
        arrow: c.mermaid?.arrow ?? c.toolName,
        corner: c.mermaid?.corner,
        junction: c.mermaid?.junction,
      },
      subagent: {
        badgeColors: [
          { bg: c.toolBadgeBg, fg: c.toolBadgeFg },
          { bg: c.spec, fg: c.toolBadgeFg },
          { bg: c.hookBadgeBg, fg: c.hookBadgeFg },
          { bg: c.success, fg: c.text.primary },
          { bg: c.warning, fg: c.toolBadgeFg },
          { bg: c.error, fg: c.text.primary },
          { bg: c.primary, fg: c.toolBadgeFg },
          { bg: c.highlight, fg: c.toolBadgeFg },
        ],
        placeholderBg: c.diff.border,
        placeholderFg: c.text.muted,
        resultBadgeBg: c.spec,
        resultBadgeFg: c.toolBadgeFg,
        panelBg: c.primary,
      },
    };
  }

  /** Map resolved theme colors to the McColorPalette interface */
  getMcColors(): McColorPalette {
    const mc = this.activeTheme.colors.mc;
    if (!mc) return DEFAULT_MC;
    return { ...DEFAULT_MC, ...mc } as McColorPalette;
  }

  /** Map resolved theme colors to the markdown color palette */
  getMarkdownColors(): ThemeMarkdownColors {
    return { ...this.activeTheme.colors.markdown };
  }

  /** Map resolved theme colors to the syntax highlighter color mapping */
  getSyntaxColors(): Record<string, string> {
    return this.activeTheme.colors.syntax ?? industryDark.colors.syntax ?? {};
  }

  /** Set whether themes are allowed to override terminal colors via OSC sequences */
  setOverrideTerminalColors(enabled: boolean): void {
    this.overrideTerminalColors = enabled;
  }

  /** Get whether themes are allowed to override terminal colors via OSC sequences */
  getOverrideTerminalColors(): boolean {
    return this.overrideTerminalColors;
  }

  /**
   * Apply the active theme's terminal overrides via OSC escape sequences.
   * Only sends OSC sequences when overrideTerminalColors is enabled.
   * Theme colors are always available via getColors() for in-app rendering
   * regardless of this setting.
   */
  applyTheme(): void {
    const term = this.activeTheme.terminal;
    if (!term || !this.overrideTerminalColors) return;

    const write = (seq: string) => process.stdout.write(seq);

    // OSC 10 — set foreground
    if (term.foreground) {
      write(`\x1b]10;${term.foreground}\x07`);
    }
    // OSC 11 — set background
    if (term.background) {
      write(`\x1b]11;${term.background}\x07`);
    }
    // OSC 12 — set cursor color
    if (term.cursor) {
      write(`\x1b]12;${term.cursor}\x07`);
    }
    // OSC 4 — set individual ANSI colors (indices 0–15)
    if (term.ansi) {
      for (let i = 0; i < ANSI_INDEX_ORDER.length; i++) {
        const color = term.ansi[ANSI_INDEX_ORDER[i]];
        if (color) {
          write(`\x1b]4;${i};${color}\x07`);
        }
      }
    }

    this.terminalOverridden = true;
    this.registerShutdownHookIfNeeded();
  }

  /** Reset the terminal to the user's original colors */
  resetTerminalColors(): void {
    if (!this.terminalOverridden) return;
    this.restoreTheme();
  }

  private registerShutdownHookIfNeeded(): void {
    if (this.shutdownHookRegistered) return;
    this.shutdownHookRegistered = true;
    getShutdownCoordinator().registerHook(
      'theme-restore',
      async () => {
        this.restoreTheme();
      },
      { priority: SHUTDOWN_HOOK_PRIORITY.ThemeRestore }
    );
  }

  /**
   * Reset the terminal palette to its original values.
   * Called on exit to avoid polluting the user's shell.
   */
  restoreTheme(): void {
    if (!this.terminalOverridden) return;

    const write = (seq: string) => {
      try {
        process.stdout.write(seq);
      } catch {
        // stdout may already be closed during exit
      }
    };

    // OSC 110 — reset foreground
    write('\x1b]110\x07');
    // OSC 111 — reset background
    write('\x1b]111\x07');
    // OSC 112 — reset cursor color
    write('\x1b]112\x07');
    // OSC 104 — reset all ANSI colors
    write('\x1b]104\x07');

    this.terminalOverridden = false;
  }
}

let instance: ThemeEngineImpl | null = null;

export function getThemeEngine(): ThemeEngineImpl {
  if (!instance) {
    instance = new ThemeEngineImpl();
  }
  return instance;
}
