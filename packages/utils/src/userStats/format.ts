const PROVIDER_ONLY_MODELS = new Set(['openai', 'anthropic', 'google']);
const MS_PER_DAY = 1000 * 60 * 60 * 24;

export function formatCompactNumber(n: number, locale?: string): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString(locale);
}

export function formatCompactTime(ms: number): string {
  const hours = ms / (1000 * 60 * 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = Math.round(hours % 24);
    return `${days}d ${remainingHours}h`;
  }
  if (hours >= 1) {
    return `${Math.round(hours)}h`;
  }
  const minutes = ms / (1000 * 60);
  return `${Math.round(minutes)}m`;
}

export function daysSince(date: Date | null): number {
  if (!date) return 0;
  return Math.floor((Date.now() - date.getTime()) / MS_PER_DAY);
}

export function getTopUserFacingModel(
  modelUsage: Map<string, number>
): string | null {
  const ranked = Array.from(modelUsage.entries())
    .filter(([model]) => !PROVIDER_ONLY_MODELS.has(model))
    .sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? null;
}
