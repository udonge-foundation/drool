/**
 * Customer telemetry client for CLI
 * Routes customer-facing telemetry to a separate OTLP endpoint
 */

import { type Meter } from '@opentelemetry/api';
import {
  OTLPMetricExporter,
  AggregationTemporalityPreference,
} from '@opentelemetry/exporter-metrics-otlp-http';
import {
  type Resource,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import {
  PeriodicExportingMetricReader,
  MeterProvider,
} from '@opentelemetry/sdk-metrics';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

import { ClientType } from '@industry/common/shared';
import { logException, logInfo } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { getRuntimeAuthConfig } from '@/environment';
import { AttributeEnhancingExporter } from '@/telemetry/customer/AttributeEnhancingExporter';
import { FanOutExporter } from '@/telemetry/customer/FanOutExporter';

import type { PushMetricExporter } from '@opentelemetry/sdk-metrics';

interface CustomerOtelClientConfig {
  serviceName: ClientType;
  serviceVersion: string;
  deploymentEnv: string;
  endpoint?: string;
  headers: Record<string, string>;
  enabled: boolean;
}

const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 60000; // 60 seconds
const DEFAULT_EXPORTER_TIMEOUT_MS = 10000; // 10 seconds

// Default OTEL collector endpoint (Cloud Run)
const DEFAULT_CUSTOMER_OTEL_ENDPOINT =
  process.env.INDUSTRY_ENV === 'production'
    ? 'https://otel-collector-123358924663.us-central1.run.app'
    : 'https://otel-collector-dev-i2uucsj4hq-uc.a.run.app';

function getMetricsUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/metrics`;
}

/**
 * CustomerOtelClient - OpenTelemetry client for customer-facing metrics and traces
 * Uses separate configuration from system telemetry to route to customer-specific sink
 */
export class CustomerOtelClient {
  private config: CustomerOtelClientConfig;

  private meterProvider: MeterProvider | null = null;

  constructor() {
    let airgapEnabled = false;
    try {
      airgapEnabled = getRuntimeAuthConfig().airgapEnabled === true;
    } catch {
      // Runtime auth config may not be initialized in some test contexts.
      airgapEnabled = false;
    }

    // Read config from environment variables
    this.config = {
      serviceName: ClientType.CLI,
      serviceVersion: process.env.CLI_VERSION || 'unknown',
      deploymentEnv: process.env.INDUSTRY_ENV || 'localhost',
      endpoint:
        process.env.OTEL_CUSTOMER_ENDPOINT || DEFAULT_CUSTOMER_OTEL_ENDPOINT,
      headers: CustomerOtelClient.parseHeaders(
        process.env.OTEL_CUSTOMER_HEADERS
      ),
      enabled: !airgapEnabled && process.env.OTEL_CUSTOMER_ENABLED === 'true',
    };

    if (airgapEnabled) {
      logInfo(
        '[CustomerOtelClient] Airgap Mode is enabled; OTEL client disabled'
      );
      return;
    }

    if (this.config.enabled) {
      this.init();
    } else {
      logInfo('[CustomerOtelClient] OTEL client is disabled');
    }
  }

  /**
   * Parse headers from a comma-separated "key=value" string.
   * Format: "key=value,key2=value2"
   */
  static parseHeaders(raw?: string): Record<string, string> {
    if (!raw) return {};

    const headers: Record<string, string> = {};
    try {
      raw.split(',').forEach((pair) => {
        const eqIdx = pair.indexOf('=');
        if (eqIdx === -1) return;
        const key = pair.slice(0, eqIdx);
        const value = pair.slice(eqIdx + 1);
        if (key && value) {
          headers[key.trim()] = value.trim();
        }
      });
    } catch (error) {
      logException(error, '[CustomerOtelClient] Failed to parse headers');
    }
    return headers;
  }

  /**
   * Initialize the customer telemetry client
   */
  private init(): void {
    if (!this.config.enabled) {
      logInfo('[CustomerOtelClient] Customer telemetry disabled');
      return;
    }

    try {
      const resource = resourceFromAttributes({
        [ATTR_SERVICE_NAME]: this.config.serviceName,
        [ATTR_SERVICE_VERSION]: this.config.serviceVersion,
      });

      this.initializeMetrics(resource);
      logInfo('[CustomerOtelClient] Initialized successfully');
    } catch (error) {
      logException(error, '[CustomerOtelClient] Failed to initialize');
      // Don't throw - gracefully degrade
    }
  }

  /**
   * Initialize metrics provider
   * Note: Does NOT set global provider - keeps metrics isolated
   */
  private initializeMetrics(resource: Resource): void {
    if (!this.config.enabled) return;

    if (!this.config.endpoint) {
      throw new MetaError('No OTLP exporter endpoint found in config');
    }

    // Industry exporter (always active)
    const industryExporter = new AttributeEnhancingExporter(
      new OTLPMetricExporter({
        url: getMetricsUrl(this.config.endpoint),
        headers: this.config.headers || {},
        timeoutMillis: DEFAULT_EXPORTER_TIMEOUT_MS,
        // Use delta temporality so each export only sends NEW metric values,
        // not cumulative totals. Prevents re-sending same commits/PRs repeatedly.
        temporalityPreference: AggregationTemporalityPreference.DELTA,
      })
    );

    const exporters: PushMetricExporter[] = [industryExporter];

    // Customer exporter (opt-in via OTEL_TELEMETRY_ENDPOINT)
    const customerEndpoint = process.env.OTEL_TELEMETRY_ENDPOINT;
    if (
      customerEndpoint &&
      getMetricsUrl(customerEndpoint) !== getMetricsUrl(this.config.endpoint)
    ) {
      const customerExporter = new AttributeEnhancingExporter(
        new OTLPMetricExporter({
          url: getMetricsUrl(customerEndpoint),
          headers: CustomerOtelClient.parseHeaders(
            process.env.OTEL_TELEMETRY_HEADERS
          ),
          timeoutMillis: DEFAULT_EXPORTER_TIMEOUT_MS,
          temporalityPreference: AggregationTemporalityPreference.DELTA,
        })
      );
      exporters.push(customerExporter);
      logInfo('[CustomerOtelClient] Customer OTLP endpoint configured');
    } else if (customerEndpoint) {
      logInfo(
        '[CustomerOtelClient] Customer OTLP endpoint matches Industry endpoint; skipping duplicate exporter'
      );
    }

    const metricReader = new PeriodicExportingMetricReader({
      exporter: new FanOutExporter(exporters),
      exportIntervalMillis: DEFAULT_METRIC_EXPORT_INTERVAL_MS,
    });

    this.meterProvider = new MeterProvider({
      resource,
      readers: [metricReader],
    });

    // Do NOT set global provider - we want separate providers for customer vs system telemetry
  }

  /**
   * Get a meter for creating metrics
   * @param name - Meter name
   * @returns Meter instance or null if not initialized/disabled
   */
  public getMeter(name: string): Meter | null {
    if (!this.config.enabled || !this.meterProvider) {
      return null;
    }
    return this.meterProvider.getMeter(name, this.config.serviceVersion);
  }

  public isEnabled(): boolean {
    return this.config.enabled;
  }

  public enable(): void {
    let airgapEnabled = false;
    try {
      airgapEnabled = getRuntimeAuthConfig().airgapEnabled === true;
    } catch {
      // Runtime auth config may not be initialized in some test contexts.
      airgapEnabled = false;
    }
    if (airgapEnabled) {
      logInfo('[CustomerOtelClient] Airgap Mode is enabled; enable() ignored');
      return;
    }

    if (this.config.enabled && this.meterProvider) {
      logInfo('[CustomerOtelClient] OTEL already enabled');
      return;
    }

    logInfo('[CustomerOtelClient] Enabling OTEL');
    this.config.enabled = true;
    this.init();
  }

  /**
   * Force flush all pending metrics immediately
   * Useful for testing or before shutdown
   */
  public async forceFlush(): Promise<void> {
    try {
      if (this.meterProvider) {
        await this.meterProvider.forceFlush();
        logInfo('[CustomerOtelClient] Force flush complete');
      }
    } catch (error) {
      logException(error, '[CustomerOtelClient] Error during force flush');
    }
  }

  /**
   * Shutdown the telemetry client gracefully
   */
  public async shutdown(): Promise<void> {
    try {
      if (this.meterProvider) {
        await this.meterProvider.shutdown();
        this.meterProvider = null;
      }
      logInfo('[CustomerOtelClient] Shutdown complete');
    } catch (error) {
      logException(error, '[CustomerOtelClient] Error during shutdown');
    }
  }
}
