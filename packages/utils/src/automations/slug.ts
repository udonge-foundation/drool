export function buildAutomationSlug(
  name: string,
  automationId?: string
): string {
  const slugified = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (slugified) {
    return slugified;
  }
  if (automationId) {
    const idSuffix = automationId.replace(/[^a-z0-9]/gi, '').slice(0, 8);
    if (idSuffix) {
      return `industry-automation-${idSuffix.toLowerCase()}`;
    }
  }
  return 'industry-automation';
}
