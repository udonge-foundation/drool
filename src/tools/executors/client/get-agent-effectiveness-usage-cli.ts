import { ToolExecutionErrorType } from '@industry/common/session';
import { fetch } from '@industry/drool-core/api/fetch';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import { logException } from '@industry/logging';
import { MetaError, ToolAbortError } from '@industry/logging/errors';

import { getIndustryApiConfig } from '@/api/config';
import { getEnv } from '@/environment';
import {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';

import type {
  GetAgentEffectivenessUsageInput,
  GetAgentEffectivenessUsageOutput,
} from '@industry/drool-core/tools/definitions/schema';

const AGENT_EFFECTIVENESS_USAGE_ENDPOINT =
  '/api/organization/agent-effectiveness/usage';

export class GetAgentEffectivenessUsageCliExecutor
  implements
    ClientToolExecutor<
      CliClientSpecificToolDependencies,
      GetAgentEffectivenessUsageOutput
    >
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: GetAgentEffectivenessUsageInput
  ): AsyncGenerator<DraftToolFeedback<GetAgentEffectivenessUsageOutput>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    try {
      const response = await fetch(
        AGENT_EFFECTIVENESS_USAGE_ENDPOINT,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(parameters),
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
        (await response.json()) as GetAgentEffectivenessUsageOutput;

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: result,
      };
    } catch (error) {
      logException(error, 'Failed to fetch agent effectiveness usage', {
        url: `${getEnv().apiBaseUrl}${AGENT_EFFECTIVENESS_USAGE_ENDPOINT}`,
      });

      let errorMessage = 'Unknown error';
      let errorDetails = '';
      if (error instanceof MetaError) {
        errorMessage = error.message;
        const statusCode = error.metadata?.code;
        if (statusCode) {
          errorDetails = ` (Status: ${statusCode})`;
        }
      } else if (error instanceof Error) {
        errorMessage = error.message;
        if (error.message.includes('fetch failed')) {
          errorDetails = ` - Check network connectivity and INDUSTRY_API_BASE_URL (${getEnv().apiBaseUrl})`;
        }
      }

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ExternalAPIError,
        llmError: `Failed to fetch agent effectiveness usage: ${errorMessage}${errorDetails}`,
        userError: `Failed to fetch agent effectiveness usage: ${errorMessage}`,
      };
    }
  }
}
