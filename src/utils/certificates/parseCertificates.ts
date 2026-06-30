import { normalizeCertificate } from '@/utils/certificates/normalizeCertificate';

/**
 * Parse PEM-formatted certificates from a string
 */
export function parseCertificates(content: string): string[] {
  // First normalize the content
  const normalized = normalizeCertificate(content);

  // More flexible regex that handles various formatting issues
  const matches = normalized.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
  );

  if (!matches) {
    return [];
  }

  // Clean up each certificate
  return matches.map((cert) => {
    // Ensure proper formatting
    const lines = cert.split('\n').filter((line) => line.trim());
    const header = lines[0];
    const footer = lines[lines.length - 1];
    const body = lines.slice(1, -1).join('\n');

    // Rebuild with consistent formatting
    return `${header}\n${body}\n${footer}`;
  });
}
