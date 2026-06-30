/**
 * i18n constants.
 */

import { SupportedLocale } from '@/i18n/enums';

/** Locales the CLI supports (must match directory names under locales/) */
export const SUPPORTED_LOCALES: readonly SupportedLocale[] = [
  SupportedLocale.English,
  SupportedLocale.Italian,
  SupportedLocale.Japanese,
  SupportedLocale.ChineseSimplified,
  SupportedLocale.Korean,
];

/** Default / fallback locale */
export const DEFAULT_LOCALE: SupportedLocale = SupportedLocale.English;
