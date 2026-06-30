import type { CustomCommandSettings } from '@industry/common/settings';

export function mergeCommands(
  higher: CustomCommandSettings | undefined,
  lower: CustomCommandSettings | undefined
): CustomCommandSettings | undefined {
  if (!higher && !lower) return undefined;
  if (!higher) return lower;
  if (!lower) return higher;

  const result = [...higher];
  const existingNames = new Set(higher.map((c) => c.name));

  for (const command of lower) {
    if (!existingNames.has(command.name)) {
      result.push(command);
      existingNames.add(command.name);
    }
  }

  return result;
}
