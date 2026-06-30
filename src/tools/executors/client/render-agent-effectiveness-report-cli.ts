import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ToolExecutionErrorType } from '@industry/common/session';
import {
  buildAgentEffectivenessReportMetrics,
  buildDailyAgentEffectivenessTokenEfficiencyTrend,
  renderAgentEffectivenessHtmlReport,
} from '@industry/drool-core/agent-effectiveness-report';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import { logException } from '@industry/logging';
import { MetaError, ToolAbortError } from '@industry/logging/errors';

import {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';

import type {
  RenderAgentEffectivenessReportInput,
  RenderAgentEffectivenessReportOutput,
} from '@industry/drool-core/tools/definitions/schema';

const REQUIRED_HTML_MARKERS = [
  '<style>',
  '<script>',
  'metric-grid',
  'summary-grid',
  'distribution-grid',
  'distribution-plot',
  'chart-point',
  'chart-tooltip',
  'table-pagination',
  'repo-list',
  'gap-note',
  'Token spend / net LOC over time',
  'line-chart',
  'Breakdown by user',
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function inclusiveDayCount(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new MetaError('Invalid report date range', {
      startDate,
      endDate,
    });
  }

  return Math.floor((end - start) / MS_PER_DAY) + 1;
}

function countTrendPoints(html: string): number {
  return (
    html.match(/\sdata-trend-point-date="\d{4}-\d{2}-\d{2}"/g)?.length ?? 0
  );
}

function formatMetaErrorMetadata(error: unknown): string {
  if (!(error instanceof MetaError) || !error.metadata) {
    return '';
  }
  try {
    const entries = Object.entries(error.metadata).filter(
      ([, value]) => value !== undefined
    );
    if (entries.length === 0) {
      return '';
    }
    const serializable = Object.fromEntries(
      entries.map(([key, value]) => [
        key,
        value instanceof Error ? value.message : value,
      ])
    );
    return ` (${JSON.stringify(serializable)})`;
  } catch {
    return '';
  }
}

function validateHtml(html: string, expectedTrendPointCount: number): number {
  const missingMarkers = REQUIRED_HTML_MARKERS.filter(
    (marker) => !html.includes(marker)
  );
  if (!/<(?:polyline|path)\b/.test(html)) {
    missingMarkers.push('SVG polyline/path');
  }

  const trendPointCount = countTrendPoints(html);
  if (trendPointCount !== expectedTrendPointCount) {
    throw new MetaError('Report HTML validation failed', {
      errorMessage: `Expected ${expectedTrendPointCount} trend-points (one per calendar day, parsed from data-trend-point-date attribute), but the rendered HTML contains ${trendPointCount}.`,
      count: expectedTrendPointCount,
      currentCount: trendPointCount,
    });
  }

  if (missingMarkers.length > 0) {
    throw new MetaError('Report HTML validation failed', {
      errorMessage: `Missing HTML markers: ${missingMarkers.join(', ')}`,
    });
  }

  return trendPointCount;
}

function reportFilename(startDate: string, endDate: string): string {
  return `agent-effectiveness-report-${startDate}-to-${endDate}.html`;
}

export class RenderAgentEffectivenessReportCliExecutor
  implements
    ClientToolExecutor<
      CliClientSpecificToolDependencies,
      RenderAgentEffectivenessReportOutput
    >
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: RenderAgentEffectivenessReportInput
  ): AsyncGenerator<DraftToolFeedback<RenderAgentEffectivenessReportOutput>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    try {
      const expectedDayCount = inclusiveDayCount(
        parameters.request.startDate,
        parameters.request.endDate
      );
      if (parameters.dailyUsageRows.length !== expectedDayCount) {
        throw new MetaError('Daily usage row count does not match date range', {
          count: expectedDayCount,
          currentCount: parameters.dailyUsageRows.length,
        });
      }

      const metrics = buildAgentEffectivenessReportMetrics(
        parameters.request,
        parameters.codingUsage,
        parameters.totalUsage
      );
      const tokenEfficiencyTrend =
        buildDailyAgentEffectivenessTokenEfficiencyTrend({
          startDate: parameters.request.startDate,
          endDate: parameters.request.endDate,
          dailyUsageRows: parameters.dailyUsageRows,
          pullRequests: parameters.request.pullRequests,
          workItems: parameters.request.workItems,
          identityAliases: parameters.request.identityAliases,
        });
      const html = renderAgentEffectivenessHtmlReport(metrics, {
        tokenEfficiencyTrend,
      });
      const trendPointCount = validateHtml(html, expectedDayCount);

      const outputDirectory = join(tmpdir(), 'agent-effectiveness-report');
      await mkdir(outputDirectory, { recursive: true });

      const filename = reportFilename(
        parameters.request.startDate,
        parameters.request.endDate
      );
      const path = join(outputDirectory, filename);
      await writeFile(path, html, 'utf8');

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: {
          filename,
          path,
          fileUrl: pathToFileURL(path).href,
          trendPointCount,
          message: `Saved Agent Effectiveness HTML report to ${path}`,
        },
      };
    } catch (error) {
      logException(error, 'Failed to render agent effectiveness report');

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      const metadataSuffix = formatMetaErrorMetadata(error);
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: `Failed to render agent effectiveness report: ${errorMessage}${metadataSuffix}`,
        userError: `Failed to render agent effectiveness report: ${errorMessage}${metadataSuffix}`,
      };
    }
  }
}
