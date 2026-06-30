/**
 * i18n initialization for the CLI TUI.
 *
 * Uses i18next with react-i18next for Ink components.
 * Translation JSON files are imported directly (bundler-compatible, works with Bun SEA).
 * Initialization is synchronous to avoid flash of untranslated content.
 */

import i18next, { type i18n as I18nInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/i18n/constants';
import { SupportedLocale } from '@/i18n/enums';
import commandsEn from '@/i18n/locales/en/commands.json';
import commonEn from '@/i18n/locales/en/common.json';
import errorsEn from '@/i18n/locales/en/errors.json';
import commandsIt from '@/i18n/locales/it/commands.json';
import commonIt from '@/i18n/locales/it/common.json';
import errorsIt from '@/i18n/locales/it/errors.json';
import commandsJa from '@/i18n/locales/ja/commands.json';
import commonJa from '@/i18n/locales/ja/common.json';
import errorsJa from '@/i18n/locales/ja/errors.json';
import commandsKo from '@/i18n/locales/ko/commands.json';
import commonKo from '@/i18n/locales/ko/common.json';
import errorsKo from '@/i18n/locales/ko/errors.json';
import commandsZhCN from '@/i18n/locales/zh-CN/commands.json';
import commonZhCN from '@/i18n/locales/zh-CN/common.json';
import errorsZhCN from '@/i18n/locales/zh-CN/errors.json';

/** All translation resources, keyed by locale then namespace */
const resources = {
  en: {
    common: commonEn,
    errors: errorsEn,
    commands: commandsEn,
  },
  it: {
    common: commonIt,
    errors: errorsIt,
    commands: commandsIt,
  },
  ja: {
    common: commonJa,
    errors: errorsJa,
    commands: commandsJa,
  },
  'zh-CN': {
    common: commonZhCN,
    errors: errorsZhCN,
    commands: commandsZhCN,
  },
  ko: {
    common: commonKo,
    errors: errorsKo,
    commands: commandsKo,
  },
} as const;

let i18nInstance: I18nInstance | null = null;

/**
 * Initialize i18next synchronously with the given locale.
 *
 * Uses `initImmediate: false` so that i18next initializes synchronously,
 * preventing a flash of untranslated content on first render.
 *
 * @param locale - The locale to use (from detectLocale() or user preference)
 * @returns The initialized i18next instance
 */
export function initI18n(
  locale: SupportedLocale = DEFAULT_LOCALE
): I18nInstance {
  // If already initialized, update language and return
  if (i18nInstance?.isInitialized) {
    if (i18nInstance.language !== locale) {
      void i18nInstance.changeLanguage(locale);
    }
    return i18nInstance;
  }

  void i18next.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: SupportedLocale.English,
    supportedLngs: [...SUPPORTED_LOCALES],
    defaultNS: 'common',
    ns: ['common', 'errors', 'commands'],

    interpolation: {
      // React already escapes rendered strings
      escapeValue: false,
    },

    // Synchronous initialization — critical for avoiding FOUC
    initImmediate: false,

    // Return key name as fallback only if English value is also missing.
    // With our setup English is always loaded, so this means missing keys
    // in other locales will show the English string.
    returnNull: false,
    returnEmptyString: false,
  });

  i18nInstance = i18next;
  return i18next;
}

/**
 * Get the current i18next instance.
 * Throws if initI18n() has not been called yet.
 */
export function getI18n(): I18nInstance {
  if (!i18nInstance?.isInitialized) {
    throw new Error(
      'i18n not initialized. Call initI18n() before accessing the instance.'
    );
  }
  return i18nInstance;
}
