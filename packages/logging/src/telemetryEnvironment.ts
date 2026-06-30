/**
 * Returns the base URL for the telemetry ingest cloud function.
 * Routes to the production endpoint on Vercel production deploys and
 * otherwise defaults to the dev endpoint.
 */
export function getTelemetryIngestBaseUrl(): string {
  return (
    // eslint-disable-next-line industry/no-direct-process-env -- Browser telemetry clients use Vite build-time env vars (VITE_*)
    process.env.VITE_TELEMETRY_INGEST_BASE_URL ||
    // eslint-disable-next-line industry/no-direct-process-env -- Browser telemetry clients use Vite build-time env vars (VITE_*)
    (process.env.VITE_VERCEL_ENV === 'production'
      ? 'https://telemetry.example.com'
      : 'https://dev.telemetry.example.com')
  );
}
