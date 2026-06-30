import type { SendApiProviderMessageResult } from './types';

// API key placeholder for proxy authentication
// When using Industry's proxy, authentication is handled via headers, not API key

export const PROXY_API_KEY_PLACEHOLDER = 'placeholder';

/**
 * Empty result for streaming requests aborted during retry
 */

export const ABORTED_RESULT: SendApiProviderMessageResult = {
  toolUses: [],
  finalStreamingContent: '',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    thinkingTokens: 0,
  },
  toolInputBuffers: {},
  wasAborted: true,
};

/**
 * Message id prefixes for the synthesized turn produced by `sendCompletion`.
 * Shared with downstream consumers (e2e mocks, tests) so they can distinguish
 * one-shot completions from regular streaming turns.
 */
export const ONESHOT_USER_MESSAGE_ID_PREFIX = 'oneshot-user-';
export const ONESHOT_ASSISTANT_MESSAGE_ID_PREFIX = 'oneshot-assistant-';

export const PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH = 64;
export const ANTHROPIC_TOOL_NAME_MAX_LENGTH = 200;
