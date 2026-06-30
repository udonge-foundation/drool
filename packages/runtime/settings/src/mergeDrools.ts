import type { CustomDroolSettings } from '@industry/common/settings';

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/--+/g, '-');
}

export function mergeDrools(
  higher: CustomDroolSettings | undefined,
  lower: CustomDroolSettings | undefined
): CustomDroolSettings | undefined {
  if (!higher && !lower) return undefined;
  if (!higher) return lower;
  if (!lower) return higher;

  const higherDrools = higher.customDrools ?? [];
  const lowerDrools = lower.customDrools ?? [];

  const mergedDrools = [...higherDrools];
  const existingNames = new Set(
    higherDrools.map((d) => sanitizeName(d.metadata.name))
  );

  for (const drool of lowerDrools) {
    const name = sanitizeName(drool.metadata.name);
    if (!existingNames.has(name)) {
      mergedDrools.push(drool);
      existingNames.add(name);
    }
  }

  return {
    customDrools: mergedDrools,
  };
}
