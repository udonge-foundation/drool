/**
 * Normalize certificate content to handle cross-platform issues
 */
export function normalizeCertificate(content: string): string {
  let normalized = content;
  normalized = normalized.replace(/^\uFEFF/, '');
  normalized = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  normalized = normalized.trim();
  normalized = normalized.replace(
    /-----\s*BEGIN\s+CERTIFICATE\s*-----/g,
    '-----BEGIN CERTIFICATE-----'
  );
  normalized = normalized.replace(
    /-----\s*END\s+CERTIFICATE\s*-----/g,
    '-----END CERTIFICATE-----'
  );

  return normalized;
}
