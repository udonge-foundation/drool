/**
 * Industry for the {@link LlmClients} bundle that the send-message engine
 * caches across turns. Lives in its own module because `constants.ts`
 * is restricted to `const` declarations by the
 * `industry/constants-file-organization` lint rule.
 */

import type { LlmClients } from './types';

/**
 * Returns a fresh {@link LlmClients} bundle with every field null.
 * Hosts call this once when allocating the ref they'll hand to
 * `createSendMessageClient`.
 */
export function createLlmClients(): LlmClients {
  return {
    anthropic: null,
    openai: null,
    bedrock: null,
    bedrockConverse: null,
    bedrockOpenAI: null,
  };
}
