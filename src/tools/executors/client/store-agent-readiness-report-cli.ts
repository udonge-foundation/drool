import { ToolExecutionErrorType } from '@industry/common/session';
import { fetch } from '@industry/drool-core/api/fetch';
import { readinessReportSchemaShape } from '@industry/drool-core/tools/definitions/schema';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import { logException, logInfo } from '@industry/logging';
import { MetaError, ToolAbortError } from '@industry/logging/errors';

import packageJson from '../../../../package.json';
import { getIndustryApiConfig } from '@/api/config';
import { getEnv } from '@/environment';
import { getSessionService } from '@/services/SessionService';
import {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';

import type {
  StoreAgentReadinessReportRemoteInput,
  StoreAgentReadinessReportRemoteOutput,
} from '@industry/drool-core/tools/definitions/schema';

export class StoreAgentReadinessReportCliExecutor
  implements
    ClientToolExecutor<
      CliClientSpecificToolDependencies,
      StoreAgentReadinessReportRemoteOutput
    >
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: StoreAgentReadinessReportRemoteInput
  ): AsyncGenerator<DraftToolFeedback<StoreAgentReadinessReportRemoteOutput>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const {
      repoUrl,
      report,
      apps,
      commitHash,
      branch,
      hasLocalChanges,
      hasNonRemoteCommits,
      modelUsed,
    } = parameters;

    if (!repoUrl || typeof repoUrl !== 'string') {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'repoUrl parameter is required and must be a string',
        userError: 'Invalid repository URL provided',
      };
      return;
    }

    if (!report || typeof report !== 'object') {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'report parameter is required and must be an object',
        userError: 'Invalid report data provided',
      };
      return;
    }

    // Validate that report contains all required criterion IDs (extra keys are allowed)
    // Use schema shape as single source of truth for required keys
    const requiredKeys = Object.keys(readinessReportSchemaShape);

    const reportKeys = Object.keys(report);
    const missingKeys = requiredKeys.filter((key) => !reportKeys.includes(key));

    if (missingKeys.length > 0) {
      const errorMessage =
        `Report must contain all required criterion IDs: ${requiredKeys.join(', ')}` +
        `\n\nMissing required keys (${missingKeys.length}): ${missingKeys.join(', ')}` +
        '\n\nYou MUST include all these criterion IDs as keys in the report object.';

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: errorMessage,
        userError: 'Invalid report structure - missing required criterion IDs',
      };
      return;
    }

    try {
      // Get current session ID
      const sessionService = getSessionService();
      const sessionId = sessionService.getCurrentSessionId();

      if (!sessionId) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.ToolInternalError,
          llmError: 'No active session found',
          userError: 'No active session found',
        };
        return;
      }

      // Get drool version (only metadata captured by executor)
      const droolVersion = packageJson.version;
      // Log request details for debugging
      logInfo('Store agent readiness report: Making API request', {
        sessionId,
        repoUrl,
      });

      const response = await fetch(
        '/api/organization/agent-readiness-reports',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            repoUrl,
            report,
            sessionId,
            apps,
            commitHash,
            branch,
            hasLocalChanges,
            hasNonRemoteCommits,
            modelUsed,
            droolVersion,
          }),
        },
        getIndustryApiConfig()
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new MetaError('API request failed', {
          code: response.status,
          errorMessage: errorText,
        });
      }

      const result =
        (await response.json()) as StoreAgentReadinessReportRemoteOutput;

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: result,
      };
    } catch (error) {
      // Get session ID for logging
      const currentSessionId = getSessionService().getCurrentSessionId();

      logException(
        error,
        'Failed to store agent readiness report in CLI executor',
        {
          repoUrl,
          sessionId: currentSessionId || undefined,
          url: `${getEnv().appBaseUrl}/api/organization/agent-readiness-reports`,
        }
      );

      // Provide detailed error information
      let errorMessage = 'Unknown error';
      let errorDetails = '';

      if (error instanceof MetaError) {
        errorMessage = error.message;
        const statusCode = error.metadata?.code;
        if (statusCode) {
          errorDetails = ` (Status: ${statusCode})`;
          // 405 Method Not Allowed - endpoint likely not deployed
          if (statusCode === 405) {
            errorDetails += ` - The POST endpoint may not be deployed to ${getEnv().apiBaseUrl}. Try running backend locally or set INDUSTRY_API_BASE_URL=http://localhost:3000`;
          }
        }
      } else if (error instanceof Error) {
        errorMessage = error.message;
        // Check for common network errors
        if (error.message.includes('fetch failed')) {
          errorDetails = ` - Check network connectivity and INDUSTRY_API_BASE_URL (${getEnv().apiBaseUrl})`;
        }
      }

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ExternalAPIError,
        llmError: `Failed to store agent readiness report: ${errorMessage}${errorDetails}`,
        userError: `Failed to store agent readiness report: ${errorMessage}`,
      };
    }
  }
}
