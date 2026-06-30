/**
 * Content Security Policy constants.
 *
 * Shared URL constants and base CSP configuration for web and desktop apps.
 *
 * NOTE: This file must NOT import from other modules. It is loaded at Vite config
 * time (Node ESM) where cross-file TS imports fail to resolve.
 *
 * NOTE: This file must stay in sync with `apps/desktop/vite-csp-helpers.js`
 */

/**
 * Localhost development URLs for CSP.
 */
const LOCALHOST_URLS = [
  'http://localhost:3000',
  'http://localhost:3002',
  'http://localhost:3301',
  'http://localhost:5173', // Desktop app dev server port
];

/**
 * Sentry error tracking URLs.
 */
const SENTRY_URLS = [
  'https://*.ingest.us.sentry.io',
  'https://*.ingest.sentry.io',
];

/**
 * WorkOS authentication URLs.
 */
const WORKOS_URLS = ['https://api.workos.com'];

/**
 * Google Analytics URLs.
 */
const GOOGLE_ANALYTICS_URLS = [
  'https://www.googletagmanager.com',
  'https://www.google-analytics.com',
  'https://*.google-analytics.com',
  'https://analytics.google.com',
];

/**
 * LinkedIn Insight Tag URLs.
 */
const LINKEDIN_URLS = ['https://snap.licdn.com', 'https://px.ads.linkedin.com'];

/**
 * Google Ads conversion tracking and remarketing URLs.
 */
const GOOGLE_ADS_URLS = [
  'https://googleads.g.doubleclick.net',
  'https://www.googleadservices.com',
  'https://pagead2.googlesyndication.com',
  'https://www.google.com',
];

/**
 * Firebase URLs.
 */
const FIREBASE_URLS = [
  'https://identitytoolkit.googleapis.com',
  'https://securetoken.googleapis.com',
  'https://firestore.googleapis.com',
  'https://cdn.firebase.com',
  'https://*.firebaseio.com',
  'https://*.firebaseapp.com',
];

/**
 * Google service URLs.
 */
const GOOGLE_URLS = [
  'https://accounts.google.com',
  'https://apis.google.com',
  'https://www.google.com',
  'https://www.gstatic.com',
  'https://*.googleusercontent.com',
];

/**
 * WorkOS CDN URLs.
 */
const WORKOS_CDN_URLS = ['https://workoscdn.com'];

/**
 * E2B sandbox environment URLs.
 */
const E2B_URLS = [
  'https://api.e2b.dev/sandboxes',
  'https://api.e2b.dev/sandboxes/*',
  'wss://*.e2b.app',
];

/**
 * S3 bucket URLs for wiki image assets served via the dedicated drool-wiki bucket.
 * Images are uploaded under {orgId}/{wikiRunId}/images/ and served via presigned
 * URLs. The dedicated bucket means no path-prefix scoping is needed.
 *
 * Exported so that apps rendering or serving wiki content (web, desktop, backend)
 * include these in their CSP — they should NOT be in BASE_CSP_SOURCES.
 */
export const S3_WIKI_ASSET_URLS = [
  'https://drool-wiki-dev.s3.us-west-1.amazonaws.com/',
  'https://drool-wiki-prod.s3.us-west-1.amazonaws.com/',
];

/**
 * Industry API URLs for all environments.
 */
const INDUSTRY_API_URLS = [
  'https://dev.api.example.com',
  'https://staging.api.example.com',
  'https://preprod.api.example.com',
  'https://api.example.com',
  'https://dev.api.eu.example.com',
  'https://staging.api.eu.example.com',
  'https://preprod.api.eu.example.com',
  'https://api.eu.example.com',
  'https://dev.telemetry.example.com',
  'https://telemetry.example.com',
];

/**
 * IP geolocation API for cookie consent (EU detection).
 */
const IPAPI_URLS = ['https://ipapi.co'];

/**
 * Relay HTTP(S) and WebSocket URLs for computer relay connections.
 */
const RELAY_URLS = [
  'https://relay.example.com',
  'https://relay-dev.example.com',
  'wss://relay.example.com',
  'wss://relay-dev.example.com',
  'http://localhost:8080', // Local relay dev health endpoint (legacy default)
  'ws://localhost:8080', // Local relay dev server (legacy default)
  'http://localhost:18080', // Local relay dev health endpoint (current default)
  'ws://localhost:18080', // Local relay dev server (current default)
];

/**
 * Cloudflared tunnel URLs for local relay development.
 * Only included in development mode.
 */
export const CLOUDFLARED_URLS = [
  'wss://*.trycloudflare.com',
  'https://*.trycloudflare.com',
];

/**
 * OpenTelemetry collector endpoint for local development.
 * Only included in development mode.
 */
export const OTEL_URLS = ['http://localhost:4318'];

/**
 * Base CSP sources that are common to all applications.
 * Does NOT include dev-only URLs -- those are added by buildCSPSources(isDev).
 */
export const BASE_CSP_SOURCES = {
  defaultSrc: ["'self'"],
  scriptSrc: [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'", // Required for React DevTools and dynamic code evaluation
    'blob:',
    ...FIREBASE_URLS,
    ...GOOGLE_URLS,
    ...GOOGLE_ANALYTICS_URLS,
    ...GOOGLE_ADS_URLS,
    ...LINKEDIN_URLS,
  ],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: [
    "'self'",
    'blob:',
    'data:',
    ...GOOGLE_URLS,
    ...GOOGLE_ANALYTICS_URLS,
    ...GOOGLE_ADS_URLS,
    ...LINKEDIN_URLS,
    ...WORKOS_CDN_URLS,
  ],
  fontSrc: ["'self'"],
  connectSrc: [
    "'self'",
    'ws://localhost:37643', // Production daemon port
    'ws://localhost:41723', // Dev daemon port
    ...LOCALHOST_URLS,
    ...SENTRY_URLS,
    ...WORKOS_URLS,
    ...FIREBASE_URLS,
    ...E2B_URLS,
    ...INDUSTRY_API_URLS,
    ...GOOGLE_ANALYTICS_URLS,
    ...GOOGLE_ADS_URLS,
    ...LINKEDIN_URLS,
    ...RELAY_URLS,
    ...IPAPI_URLS,
  ],
  frameSrc: [
    "'self'",
    'http://localhost:37643', // Production daemon port (local preview proxy)
    'http://localhost:41723', // Dev daemon port (local preview proxy)
    ...GOOGLE_URLS,
    ...FIREBASE_URLS,
  ],
  mediaSrc: ["'self'", 'blob:', 'data:'],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'self'"], // Prevent clickjacking
} as const;
