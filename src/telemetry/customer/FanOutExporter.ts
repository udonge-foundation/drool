/**
 * Fan-out exporter that sends metrics to multiple OTLP endpoints in parallel.
 * Used to dual-ship metrics to both Industry's collector and a customer's own collector.
 * If one exporter fails, the others still succeed.
 */

import { ExportResultCode } from '@opentelemetry/core';
import {
  AggregationOption,
  AggregationTemporality,
  AggregationType,
  InstrumentType,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

import type { ExportResult } from '@opentelemetry/core';

export class FanOutExporter implements PushMetricExporter {
  private readonly exporters: PushMetricExporter[];

  constructor(exporters: PushMetricExporter[]) {
    this.exporters = exporters;
  }

  async export(
    metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void
  ): Promise<void> {
    const results = await Promise.allSettled(
      this.exporters.map(
        (exporter) =>
          new Promise<ExportResult>((resolve) => {
            exporter.export(metrics, resolve);
          })
      )
    );

    const anySuccess = results.some(
      (r) =>
        r.status === 'fulfilled' && r.value.code === ExportResultCode.SUCCESS
    );

    resultCallback({
      code: anySuccess ? ExportResultCode.SUCCESS : ExportResultCode.FAILED,
    });
  }

  async forceFlush(): Promise<void> {
    await Promise.allSettled(
      this.exporters.map((exporter) => exporter.forceFlush())
    );
  }

  selectAggregation(instrumentType: InstrumentType): AggregationOption {
    return (
      this.exporters[0]?.selectAggregation?.(instrumentType) ?? {
        type: AggregationType.DEFAULT,
      }
    );
  }

  selectAggregationTemporality(
    instrumentType: InstrumentType
  ): AggregationTemporality {
    return (
      this.exporters[0]?.selectAggregationTemporality?.(instrumentType) ??
      AggregationTemporality.CUMULATIVE
    );
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      this.exporters.map((exporter) => exporter.shutdown())
    );
  }
}
