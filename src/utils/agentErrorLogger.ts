import { logException, Metrics } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';

import { extractStatusCodeFromMessage } from '@/utils/statusCode';

export function logAgentException(
  error: unknown,
  message: string,
  params: {
    modelId: string;
    severity: 'fatal' | 'severe'; // 'fatal' for process exit, 'severe' for recoverable major errors
    [key: string]: unknown;
  }
) {
  const errorMessage = error instanceof Error ? error.message : String(error);

  const statusCode = extractStatusCodeFromMessage(errorMessage);

  logException(error, message, {
    statusCode,
    ...params,
  });

  Metrics.addToCounter(Metric.AGENT_ERROR_COUNT, 1, {
    reason: message,
    errorMessage,
    statusCode,
    ...params,
  });
}
