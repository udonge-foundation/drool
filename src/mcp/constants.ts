export const MCP_CALL_TOOL_TIMEOUT_MS = 3 * 60 * 1000; // SDK default is 1 min
export const MCP_SERVER_KILL_GRACE_MS = 3000;
export const MCP_SERVER_CONNECT_TIMEOUT_MS = 10 * 1000;
// Interactive OAuth requires the user to approve in a browser, so the wait for
// the authorization callback is bounded generously rather than left unbounded.
export const MCP_OAUTH_AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000;
