import type { IndustryRouterRule } from '@industry/common/settings';

export function normalizeIndustryRouterRules(
  rules: readonly IndustryRouterRule[] | undefined
): IndustryRouterRule[] | undefined {
  const normalized =
    rules
      ?.map((rule) => {
        const guidance = rule.guidance.trim();
        if (guidance.length === 0) return undefined;
        const when = rule.when?.trim();
        return {
          ...(when && { when }),
          guidance,
        };
      })
      .filter((rule): rule is IndustryRouterRule => rule !== undefined) ?? [];

  return normalized.length > 0 ? normalized : undefined;
}
