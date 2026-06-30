/**
 * Custom OTLP exporter that adds common attributes (user.id, organization.id)
 * to all metrics at export time, rather than at recording time.
 * This is more efficient as auth is fetched once per export batch.
 */

import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import {
  AggregationOption,
  AggregationTemporality,
  InstrumentType,
  PushMetricExporter,
  ResourceMetrics,
  MetricData,
} from '@opentelemetry/sdk-metrics';

import { logException } from '@industry/logging';
import { getAuthedUser } from '@industry/runtime/auth';

import { getRuntimeAuthConfig } from '@/environment';
import { getSessionService } from '@/services/SessionService';

import type { ExportResult } from '@opentelemetry/core';

export class AttributeEnhancingExporter implements PushMetricExporter {
  private readonly baseExporter: OTLPMetricExporter;

  constructor(baseExporter: OTLPMetricExporter) {
    this.baseExporter = baseExporter;
  }

  async export(
    metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void
  ): Promise<void> {
    try {
      // Fetch common attributes once for this export batch
      const auth = await getAuthedUser(getRuntimeAuthConfig());
      const sessionId = getSessionService().getCurrentSessionId();
      const commonAttributes = {
        'user.id': auth?.userId ?? 'anonymous',
        'organization.id': auth?.orgId ?? 'unknown',
        'session.id': sessionId ?? 'unknown',
      };

      // Create enhanced metrics with common attributes added to all data points
      const enhancedMetrics =
        AttributeEnhancingExporter.enhanceMetricsWithAttributes(
          metrics,
          commonAttributes
        );

      return this.baseExporter.export(enhancedMetrics, resultCallback);
    } catch (error) {
      logException(
        error,
        '[AttributeEnhancingExporter] Failed to add common attributes'
      );
      // Fallback: export without enhancement if fetching attributes fails
      return this.baseExporter.export(metrics, resultCallback);
    }
  }

  /**
   * Add common attributes to all data points in the metrics
   */
  private static enhanceMetricsWithAttributes(
    metrics: ResourceMetrics,
    commonAttributes: Record<string, string>
  ): ResourceMetrics {
    return {
      resource: metrics.resource,
      scopeMetrics: metrics.scopeMetrics.map((scopeMetric) => ({
        scope: scopeMetric.scope,
        metrics: scopeMetric.metrics.map((metric) =>
          AttributeEnhancingExporter.enhanceMetric(metric, commonAttributes)
        ),
      })),
    };
  }

  private static enhanceMetric(
    metric: MetricData,
    commonAttributes: Record<string, string>
  ): MetricData {
    const enhancedDataPoints = metric.dataPoints.map((dataPoint) => ({
      ...dataPoint,
      attributes: {
        ...dataPoint.attributes,
        ...commonAttributes,
      },
    }));

    // Type assertion needed because map() loses the discriminated union type
    return {
      ...metric,
      dataPoints: enhancedDataPoints,
    } as MetricData;
  }

  async forceFlush(): Promise<void> {
    return this.baseExporter.forceFlush();
  }

  selectAggregation(instrumentType: InstrumentType): AggregationOption {
    return this.baseExporter.selectAggregation(instrumentType);
  }

  selectAggregationTemporality(
    instrumentType: InstrumentType
  ): AggregationTemporality {
    return this.baseExporter.selectAggregationTemporality(instrumentType);
  }

  async shutdown(): Promise<void> {
    return this.baseExporter.shutdown();
  }
}
