import { getI18n } from '@/i18n';

export function getMultiplierDisplay(
  multiplier: number,
  promoLabel?: string
): string {
  const t = getI18n().t;
  if (promoLabel) {
    return t('common:multiplier.displayWithLabel', {
      value: multiplier,
      label: promoLabel,
    });
  }
  return t('common:multiplier.display', { value: multiplier, suffix: '' });
}
