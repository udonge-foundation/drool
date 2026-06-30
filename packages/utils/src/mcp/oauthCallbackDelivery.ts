import type {
  McpOAuthCallbackDelivery,
  McpOAuthCallbackDeliveryParts,
} from './types';

const MCP_OAUTH_DESKTOP_DELIVERY: McpOAuthCallbackDelivery = 'desktop';
const MCP_OAUTH_DELIVERY_STATE_PREFIX = `${MCP_OAUTH_DESKTOP_DELIVERY}.`;

export function splitCallbackDelivery(
  uri: string
): McpOAuthCallbackDeliveryParts {
  const url = new URL(uri);
  const delivery =
    url.searchParams.get('delivery') === MCP_OAUTH_DESKTOP_DELIVERY
      ? MCP_OAUTH_DESKTOP_DELIVERY
      : undefined;
  url.search = '';
  url.hash = '';
  return {
    redirectUri: url.toString(),
    ...(delivery !== undefined ? { delivery } : {}),
  };
}

export function encodeDeliveryState(
  delivery: McpOAuthCallbackDelivery | undefined,
  nonce: string
): string {
  return delivery === undefined
    ? nonce
    : `${MCP_OAUTH_DESKTOP_DELIVERY}.${nonce}`;
}

export function parseDeliveryState(state: string): {
  delivery?: McpOAuthCallbackDelivery;
  nonce: string;
} {
  if (state.startsWith(MCP_OAUTH_DELIVERY_STATE_PREFIX)) {
    const nonce = state.slice(MCP_OAUTH_DELIVERY_STATE_PREFIX.length);
    if (nonce.length === 0) {
      return { nonce: state };
    }
    return {
      delivery: MCP_OAUTH_DESKTOP_DELIVERY,
      nonce,
    };
  }
  return { nonce: state };
}
