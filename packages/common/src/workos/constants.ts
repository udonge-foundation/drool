// WorkOS Client IDs for Industry platform. These are public identifiers (not
// secrets) and are hardcoded so that non-backend entrypoints (CLI, desktop,
// signal, relay, scripts) can seed a valid config without depending on a
// WorkOS-specific env var. Staging/preprod use the production WorkOS client,
// matching dev behavior (INDUSTRY_ENV=production).
export const DEV_WORKOS_CLIENT_ID = 'client_01HNM7927XNSKCJ4982Z5J3FFZ';
export const PROD_WORKOS_CLIENT_ID = 'client_01HNM792M5G5G1A2THWPXKFMXB';
