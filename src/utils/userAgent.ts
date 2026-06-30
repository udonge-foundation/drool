/**
 * User Agent utility for industry-cli
 * Provides a consistent user-agent string for all outgoing LLM requests
 */

// Import version from package.json
// We use a relative path with ../.. to go up from src/utils to the package root
import packageJson from '../../package.json';

/**
 * Returns the user-agent string for industry-cli
 * Format: industry-cli/<version>
 * Example: industry-cli/0.19.1
 */
export function getUserAgent(): string {
  return `industry-cli/${packageJson.version}`;
}
