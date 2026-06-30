/**
 * Default timeout values for DroolClient
 */

// Standard timeout for quick request/response operations (30 seconds)
export const DEFAULT_REQUEST_TIMEOUT = 30000;

// Extended timeout for session initialization (60 seconds)
// Session initialization involves spawning CLI process, loading modules, and setting up services
// which can take longer on cold starts, especially in CI environments
export const SESSION_INIT_TIMEOUT = 60000;

// Extended timeout for session compaction (4 minutes)
// Compaction involves LLM summarization of the entire conversation which
// can take over 60s for heavy sessions (150+ messages with large models)
export const COMPACTION_TIMEOUT = 240000;

// Extended timeout for MCP OAuth authentication (5 minutes)
// OAuth requires user interaction (browser redirect, login, consent) which can
// take significantly longer than typical request/response operations
export const MCP_AUTH_TIMEOUT = 300000;

/**
 * Windows kernel error string emitted to a child process's stderr when
 * libuv's `uv_spawn` calls `AssignProcessToJobObject` on an
 * already-terminated child handle. Used by the Windows spawn retry wrapper
 * (FAC-19070) to identify the retryable failure class.
 */
export const WINDOWS_JOB_OBJECT_ERROR_MARKER = 'AssignProcessToJobObject';
