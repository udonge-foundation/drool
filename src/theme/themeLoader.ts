/**
 * Loads user-provided themes from ~/.industry/themes/ (or ~/.industry-dev/themes/).
 */
import * as fs from 'fs';
import * as path from 'path';

import { getIndustryHome } from '@industry/utils/cli';

import type { DroolTheme } from '@/theme/types';

const THEMES_DIR = 'themes';

/** Minimal runtime validation for a user-supplied theme JSON */
function isValidThemeJson(obj: unknown): obj is DroolTheme {
  if (typeof obj !== 'object' || obj === null) return false;
  const t = obj as Record<string, unknown>;
  if (typeof t.name !== 'string') return false;
  if (t.appearance !== 'dark' && t.appearance !== 'light') return false;
  if (typeof t.colors !== 'object' || t.colors === null) return false;
  const c = t.colors as Record<string, unknown>;
  if (typeof c.primary !== 'string') return false;
  if (typeof c.text !== 'object' || c.text === null) return false;
  if (typeof c.diff !== 'object' || c.diff === null) return false;
  return true;
}

/**
 * Scan the user themes directory and return all valid themes.
 * Invalid files are silently skipped.
 */
export function loadUserThemes(): DroolTheme[] {
  const themesDir = path.join(getIndustryHome(), THEMES_DIR);
  const themes: DroolTheme[] = [];

  try {
    if (!fs.existsSync(themesDir)) return themes;
    const files = fs.readdirSync(themesDir).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(themesDir, file), 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (isValidThemeJson(parsed)) {
          themes.push(parsed);
        }
      } catch {
        // skip invalid files
      }
    }
  } catch {
    // directory not readable — return empty
  }

  return themes;
}
