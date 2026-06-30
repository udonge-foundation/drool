import { createHash, X509Certificate } from 'crypto';

/**
 * Compute the SHA-1 thumbprint of a PEM certificate, formatted to match the
 * Windows certificate store "Thumbprint" column (uppercase hex, no colons).
 * Returns null if the input cannot be parsed as a certificate.
 */
export function getCertificateThumbprint(pem: string): string | null {
  try {
    return new X509Certificate(pem).fingerprint.replace(/:/g, '').toUpperCase();
  } catch {
    // Fallback: hash the DER bytes directly (X509Certificate unavailable or
    // strict parsing rejected an otherwise-usable cert).
    try {
      const base64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
      if (!base64) {
        return null;
      }
      const der = Buffer.from(base64, 'base64');
      if (der.length === 0) {
        return null;
      }
      return createHash('sha1').update(der).digest('hex').toUpperCase();
    } catch {
      return null;
    }
  }
}
