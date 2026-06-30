import { METRICS_PREFIX } from './constants';
import { ExecutionEnvironment } from './enums';
import { logInfo } from './log';
import { MetricLabels } from './metrics/types';
import { TelemetryClient } from './telemetryClient';
import { getExecutionEnvironment } from './utils';

/**
 * Metrics manager that records metrics and exports them to Axiom.
 *
 * To add a new metric, follow the steps below:
 *
 * 1. Define a new metric in the 'Metric' enum.
 * 2. Use 'addToCounter', 'setGauge', or 'recordHistogram' to update the metric.
 * 3. Visualize the metric in Axiom by querying the name from Step #1.
 *
 */
export class Metrics {
  static addLog(metric: string, value: number, labels: MetricLabels = {}) {
    if (getExecutionEnvironment() === ExecutionEnvironment.CLIENT) {
      TelemetryClient.addMetric_INTERNAL_USE_ONLY(metric, value, labels);
    } else {
      // eslint-disable-next-line industry/structured-logging
      logInfo(`${METRICS_PREFIX}${metric}]`, {
        ...labels,
        metric,
        value,
      });
    }
  }

  public static addToCounter(
    metric: string,
    value: number,
    labels: MetricLabels = {}
  ): void {
    Metrics.addLog(metric, value, labels);
  }

  public static setGauge(
    metric: string,
    value: number,
    labels: MetricLabels = {}
  ): void {
    Metrics.addLog(metric, value, labels);
  }

  public static recordHistogram(
    name: string,
    value: number,
    labels: MetricLabels = {}
  ): void {
    Metrics.addLog(name, value, labels);
  }
}
