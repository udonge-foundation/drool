/**
 * Sanitize drool name for file system
 */
export function sanitizeDroolName(name: string): string {
  // Remove file extension if present
  const baseName = name.replace(/\.md$/, '');

  // Replace invalid characters with hyphens
  return baseName
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');
}
