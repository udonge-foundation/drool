export function getUrlOrigin(value: string | URL): string {
  try {
    return new URL(value).origin;
  } catch {
    return 'invalid-url';
  }
}
