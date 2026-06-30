/**
 * Validate that a PEM certificate is properly formatted and parseable
 */
export function isValidCertificate(pemCert: string): boolean {
  try {
    // Basic structure check
    if (
      !pemCert.includes('-----BEGIN CERTIFICATE-----') ||
      !pemCert.includes('-----END CERTIFICATE-----')
    ) {
      return false;
    }

    // Extract base64 content between headers
    const match = pemCert.match(
      /-----BEGIN CERTIFICATE-----\s*([\s\S]+?)\s*-----END CERTIFICATE-----/
    );
    if (!match || !match[1]) {
      return false;
    }

    const base64Content = match[1].replace(/\s/g, '');

    // Validate base64
    if (!/^[A-Za-z0-9+/]+=*$/.test(base64Content)) {
      return false;
    }

    // Decode and check it's a valid DER structure
    const derBuffer = Buffer.from(base64Content, 'base64');

    // X.509 certificates start with 0x30 (SEQUENCE tag)
    if (derBuffer.length < 4 || derBuffer[0] !== 0x30) {
      return false;
    }

    // Basic length validation - certificates are typically > 200 bytes
    if (derBuffer.length < 200) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
