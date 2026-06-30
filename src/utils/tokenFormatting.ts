/**
 * Utilities for formatting token counts in a human-readable way
 */
import { formatCompactNumber as formatCompactNumberBase } from '@industry/utils/format';

import { getI18n } from '@/i18n';

/**
 * Formats a number in compact notation (K, M, B) for better readability.
 * Delegates to the shared formatter but threads through the active i18n
 * locale so sub-1,000 values are still rendered locale-aware.
 */
export function formatCompactNumber(value: number): string {
  return formatCompactNumberBase(value, { locale: getI18n().language });
}
