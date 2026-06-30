import { RiskLevel } from '@industry/drool-sdk-ext/protocol/tools';

/**
 * Parse a riskLevel value (which may be a string, unknown type, or RiskLevel enum)
 * and return a valid RiskLevel enum value.
 *
 * Defaults to HIGH for any invalid or missing values to ensure safety.
 *
 * @param riskLevelParam - The risk level parameter to parse
 * @returns A valid RiskLevel enum value
 *
 * @example
 * parseRiskLevel('low') // Returns RiskLevel.LOW
 * parseRiskLevel('HIGH') // Returns RiskLevel.HIGH (case-insensitive)
 * parseRiskLevel('invalid') // Returns RiskLevel.HIGH (default for invalid)
 * parseRiskLevel(undefined) // Returns RiskLevel.HIGH (default for missing)
 */
export function parseRiskLevel(riskLevelParam: unknown): RiskLevel {
  if (typeof riskLevelParam === 'string') {
    const lowercaseValue = riskLevelParam.trim().toLowerCase();

    if (
      lowercaseValue === RiskLevel.LOW ||
      lowercaseValue === RiskLevel.MEDIUM ||
      lowercaseValue === RiskLevel.HIGH
    ) {
      return lowercaseValue as RiskLevel;
    }
  }

  // Default to HIGH for safety when:
  // - riskLevelParam is not a string
  // - riskLevelParam is an invalid string value
  // - riskLevelParam is undefined/null
  return RiskLevel.HIGH;
}
