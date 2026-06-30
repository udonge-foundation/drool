/**
 * Locale detection for the CLI TUI.
 *
 * Reads POSIX locale environment variables in standard precedence order:
 *   LC_ALL > LC_MESSAGES > LANG
 *
 * Maps detected locale to a supported locale code, falling back to English.
 */

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/i18n/constants';
import { SupportedLocale } from '@/i18n/enums';

/**
 * Map of language+country to our supported locale codes.
 * Covers common POSIX locale strings users might have.
 */
const LOCALE_MAP: Record<string, SupportedLocale> = {
  en: SupportedLocale.English,
  it: SupportedLocale.Italian,
  'it-it': SupportedLocale.Italian,
  ja: SupportedLocale.Japanese,
  ko: SupportedLocale.Korean,
  'zh-cn': SupportedLocale.ChineseSimplified,
  'zh-tw': SupportedLocale.ChineseSimplified, // fallback Traditional Chinese to Simplified for now
  'zh-hans': SupportedLocale.ChineseSimplified,
  zh: SupportedLocale.ChineseSimplified,
};

/**
 * Parse a POSIX locale string (e.g. "ja_JP.UTF-8") and return the
 * supported locale code, or null if the string is empty / not a locale.
 *
 * Parsing rules:
 *   - Strip encoding suffix (.UTF-8, .eucJP, etc.)
 *   - "C" and "POSIX" are treated as non-locales (return null)
 *   - Attempt language_COUNTRY mapping first, then language-only
 */
export function parseLocaleString(localeStr: string): SupportedLocale | null {
  if (!localeStr || localeStr === 'C' || localeStr === 'POSIX') {
    return null;
  }

  // Strip encoding suffix (everything from the first '.')
  const withoutEncoding = localeStr.split('.')[0]!;

  // Normalise: ja_JP → ja-jp, zh_CN → zh-cn
  const normalised = withoutEncoding.replace(/_/g, '-').toLowerCase();

  // Try full match first (e.g. "zh-cn")
  if (normalised in LOCALE_MAP) {
    return LOCALE_MAP[normalised]!;
  }

  // Try language-only (e.g. "ja" from "ja-jp")
  const lang = normalised.split('-')[0]!;
  if (lang in LOCALE_MAP) {
    return LOCALE_MAP[lang]!;
  }

  // Check if the detected language matches any supported locale directly
  const supportedValues = SUPPORTED_LOCALES.map((l) =>
    l.toLowerCase()
  ) as string[];
  if (supportedValues.includes(lang)) {
    return SUPPORTED_LOCALES[supportedValues.indexOf(lang)]!;
  }

  return null;
}

/**
 * Detect the user's preferred locale from environment variables.
 *
 * POSIX precedence: LC_ALL > LC_MESSAGES > LANG
 * Falls back to English for unsupported or missing locales.
 */
export function detectLocale(): SupportedLocale {
  // POSIX precedence: LC_ALL > LC_MESSAGES > LANG
  const envVars = [
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
  ];

  for (const envVal of envVars) {
    if (envVal) {
      const locale = parseLocaleString(envVal);
      if (locale) {
        return locale;
      }
    }
  }

  return DEFAULT_LOCALE;
}

/**
 * Detect locale with config override taking highest precedence.
 *
 * Precedence: config override > LC_ALL > LC_MESSAGES > LANG > English default
 *
 * @param configLocale - The persisted language preference from CLI config, or undefined
 * @returns The resolved locale to use
 */
export function detectLocaleWithConfig(
  configLocale: SupportedLocale | undefined
): SupportedLocale {
  if (configLocale && SUPPORTED_LOCALES.includes(configLocale)) {
    return configLocale;
  }
  return detectLocale();
}
