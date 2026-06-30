/**
 * Customer metrics interface
 * Provides a clean API for recording customer-facing metrics
 */

import { logWarn } from '@industry/logging';

import { CustomerOtelClient } from '@/telemetry/customer/CustomerOtelClient';
import { MetricName } from '@/telemetry/customer/enums';

import type { Attributes, Counter, Gauge, Histogram } from '@opentelemetry/api';

const METER_NAME = 'cli-customer-metrics';

/**
 * CustomerMetrics - Static class for customer telemetry metrics
 *
 * @example
 * // Record a counter
 * CustomerMetrics.addToCounter(MetricName.TOOL_EXECUTION_COUNT, 1, {
 *   'tool.name': 'execute',
 * });
 *
 * // Record a histogram (for duration/latency)
 * CustomerMetrics.recordHistogram(MetricName.TOOL_EXECUTION_DURATION, durationMs, {
 *   'tool.name': 'execute',
 * });
 *
 * // Set a gauge (for current values)
 * CustomerMetrics.setGauge(MetricName.SESSION_MESSAGE_COUNT, messageCount, {
 *   'session.id': sessionId,
 * });
 */
export class CustomerMetrics {
  private static client: CustomerOtelClient | null = null;

  // Cache instruments to avoid recreating them
  private static counters = new Map<string, Counter>();

  private static gauges = new Map<string, Gauge>();

  private static histograms = new Map<string, Histogram>();

  public static initialize() {
    if (this.client) return;
    this.client = new CustomerOtelClient();
  }

  public static enable() {
    if (!this.client) {
      this.initialize();
    }
    this.client?.enable();
  }

  /**
   * Increment a counter metric
   * Use for: counts, totals (e.g., request count, error count)
   * Automatically includes user.id and organization.id attributes
   *
   * @param metric - Metric name from MetricName enum
   * @param value - Value to add to the counter (typically 1)
   * @param attributes - Optional attributes/labels for the metric
   */
  public static addToCounter(
    metric: MetricName,
    value: number,
    attributes: Attributes = {}
  ): void {
    if (!this.client) return;
    const meter = this.client.getMeter(METER_NAME);
    if (!meter) return;

    // Get or create counter instrument
    let counter = CustomerMetrics.counters.get(metric);
    if (!counter) {
      counter = meter.createCounter(metric, {
        description: `Counter metric: ${metric}`,
      });
      CustomerMetrics.counters.set(metric, counter);
    }

    try {
      counter.add(value, attributes);
    } catch (error) {
      logWarn('[CustomerMetrics] Failed to record counter', {
        cause: error,
        name: metric,
      });
    }
  }

  /**
   * Set a gauge metric (current value)
   * Use for: current state values (e.g., active sessions, queue size)
   * Implemented using UpDownCounter which allows adding positive/negative values
   * Automatically includes user.id and organization.id attributes
   *
   * @param metric - Metric name from MetricName enum
   * @param value - Current value
   * @param attributes - Optional attributes/labels for the metric
   */
  public static setGauge(
    metric: MetricName,
    value: number,
    attributes: Attributes = {}
  ): void {
    if (!this.client) return;
    const meter = this.client.getMeter(METER_NAME);
    if (!meter) return;

    // Get or create gauge
    let gauge = CustomerMetrics.gauges.get(metric);
    if (!gauge) {
      gauge = meter.createGauge(metric, {
        description: `Gauge metric: ${metric}`,
      });
      CustomerMetrics.gauges.set(metric, gauge);
    }

    try {
      gauge.record(value, attributes);
    } catch (error) {
      logWarn('[CustomerMetrics] Failed to record gauge', {
        cause: error,
        name: metric,
      });
    }
  }

  /**
   * Record a histogram metric (distribution of values)
   * Use for: durations, sizes, latencies
   * Automatically includes user.id and organization.id attributes
   *
   * @param metric - Metric name from MetricName enum
   * @param value - Value to record
   * @param attributes - Optional attributes/labels for the metric
   */
  public static recordHistogram(
    metric: MetricName,
    value: number,
    attributes: Attributes = {}
  ): void {
    if (!this.client) return;
    const meter = this.client.getMeter(METER_NAME);
    if (!meter) return;

    // Get or create histogram instrument
    let histogram = CustomerMetrics.histograms.get(metric);
    if (!histogram) {
      histogram = meter.createHistogram(metric, {
        description: `Histogram metric: ${metric}`,
      });
      CustomerMetrics.histograms.set(metric, histogram);
    }

    try {
      histogram.record(value, attributes);
    } catch (error) {
      logWarn('[CustomerMetrics] Failed to record histogram', {
        cause: error,
        name: metric,
      });
    }
  }

  /**
   * Shutdown OTEL client gracefully
   * Call before process exit to ensure metrics are flushed
   */
  static async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.shutdown();
      this.client = null;
      this.counters.clear();
      this.gauges.clear();
      this.histograms.clear();
    }
  }

  /**
   * Force flush pending metrics immediately
   * Useful for testing
   */
  static async forceFlush(): Promise<void> {
    if (this.client) {
      await this.client.forceFlush();
    }
  }
}
