/**
 * Legacy envelope field for old JSON-RPC peers - `industryApiVersion` must be set to this value.
 *
 * @deprecated Do not change this value; use `industryProtocolVersion` for runtime compatibility.
 */
export const LEGACY_INDUSTRY_API_VERSION = '1.0.0' as const;

export const JSONRPC_VERSION = '2.0' as const;
