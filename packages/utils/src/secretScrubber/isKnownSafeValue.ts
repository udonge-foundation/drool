const KNOWN_SAFE_PATTERNS: RegExp[] = [
  /^\d[\d_]*$/, // Numeric literals: 250_000_000, 1_000
  /^v?\d+\.\d+[\d.a-zA-Z+-]*$/, // Semver / version strings: v1.2.3-beta.4, 2.0.0-rc.1
  /^ssh-(ed25519|rsa|dss|ecdsa)/i, // SSH key type identifiers
  /^[a-z]+-\d+[a-z-]*[a-z]$/i, // Product/image tags: node-18-alpine, gpt-4o-mini (must end with letter)
  /^(true|false|null|undefined|none)$/i, // Language literals
  /^process\.env\./i, // Environment variable references
  /^[a-z]{3,}([_-][a-z]{2,})+[_-]\d{1,5}$/i, // Slug identifiers: session-init-123, callback-key-42
];

export function isKnownSafeValue(str: string): boolean {
  return KNOWN_SAFE_PATTERNS.some((re) => re.test(str));
}
