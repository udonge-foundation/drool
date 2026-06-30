/**
 * Returns BatchSpanProcessor config.
 * Uses production-grade batching (5s delay, 128 batch size) in all environments
 * to avoid overwhelming the OTEL endpoint with too many requests while keeping
 * individual payloads small enough for Axiom to accept reliably.
 */
export function getBatchSpanProcessorConfig(): {
  scheduledDelayMillis: number;
  maxExportBatchSize: number;
} {
  return {
    scheduledDelayMillis: 5000,
    maxExportBatchSize: 128,
  };
}
