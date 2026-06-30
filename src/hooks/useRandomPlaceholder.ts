/**
 * Hook to provide random placeholder text for the chat input
 */

import { useMemo } from 'react';

import { getI18n } from '@/i18n';

export function useRandomPlaceholder(isEnabled: boolean = true): string {
  const placeholder = useMemo(() => {
    if (!isEnabled) return '';
    const i18n = getI18n();
    const t = i18n.t;
    const prompts: string[] = [];
    // Dynamically collect all available placeholder prompts for the current locale.
    // Universal prompts (prompt0-prompt12) exist in all locales. Region-specific
    // prompts (prompt13+) may only exist in CJK locale files.
    let index = 0;
    while (i18n.exists(`common:placeholders.prompt${index}`)) {
      prompts.push(t(`common:placeholders.prompt${index}`));
      index++;
    }
    if (prompts.length === 0) return '';
    const randomIndex = Math.floor(Math.random() * prompts.length);
    return prompts[randomIndex];
  }, []); // Empty dependency array means it only calculates once per component mount

  return placeholder;
}
