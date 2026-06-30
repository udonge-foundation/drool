import { Metrics } from './metrics';
import { Metric } from './metrics/enums';
import { getSentryAdapter, isSentryEnabled } from './sentry';

/**
 * A general-purpose outcome recorder for tracking API and operation outcomes.
 * This class can be used to record success or failure metrics for any operation
 * and ensures that metrics are only recorded once per instance.
 */
export class OutcomeRecorder {
  private recorded = false;

  private identifier: string;

  private successMetric: Metric;

  private failureMetric: Metric;

  private sentryTagName: string;

  /**
   * Creates a new OutcomeRecorder instance
   * @param identifier The identifier for this operation (e.g. toolId, messageId)
   * @param successMetric The metric to increment on success
   * @param failureMetric The metric to increment on failure
   * @param sentryTagName The name of the Sentry tag to set (defaults to 'operation_success')
   */
  constructor(
    identifier: string,
    successMetric: Metric,
    failureMetric: Metric,
    sentryTagName: string
  ) {
    this.identifier = identifier;
    this.successMetric = successMetric;
    this.failureMetric = failureMetric;
    this.sentryTagName = sentryTagName;
  }

  /**
   * Records the outcome of an operation
   * @param success Whether the operation was successful
   * @param extraLabels Additional labels to include with the metric
   */
  recordOutcome = (
    success: boolean,
    extraLabels: Record<string, string> = {}
  ) => {
    if (this.recorded) return;

    Metrics.addToCounter(success ? this.successMetric : this.failureMetric, 1, {
      identifier: this.identifier,
      ...extraLabels,
    });

    if (isSentryEnabled()) {
      const adapter = getSentryAdapter();
      adapter?.setTag(this.sentryTagName, success);
    }
    this.recorded = true;
  };
}
