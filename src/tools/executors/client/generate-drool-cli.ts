import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { YOU_ARE_DROOL_SYSTEM_PROMPT } from '@industry/common/cli';
import { ToolExecutionErrorType } from '@industry/common/session';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import { ApiProvider } from '@industry/drool-sdk-ext/protocol/llm';
import { logException } from '@industry/logging';
import { MetaError, ToolAbortError } from '@industry/logging/errors';
import { getCachedRegion, resolveCliApiBaseUrl } from '@industry/runtime/auth';
import { DEFAULT_DROOL_GENERATOR_MODEL } from '@industry/utils/llm';

import { getRuntimeAuthConfig } from '@/environment';
import { createProxyHeaders } from '@/llm-proxy/utils';
import { getSessionService } from '@/services/SessionService';
import type {
  CliClientToolDependencies,
  CliClientSpecificToolDependencies,
} from '@/tools/types';
import { sanitizeDroolName } from '@/utils/drools/paths';

interface GenerateDroolParams {
  description: string;
  location?: 'project' | 'personal';
}

interface GenerateDroolResult {
  identifier: string;
  description: string;
  systemPrompt: string;
}

// Internal schema for LLM response validation
const llmResponseSchema = z.object({
  identifier: z.string(),
  description: z.string(),
  systemPrompt: z.string(),
});

export class GenerateDroolCliExecutor
  implements
    ClientToolExecutor<CliClientSpecificToolDependencies, GenerateDroolResult>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: GenerateDroolParams
  ): AsyncGenerator<DraftToolFeedback<GenerateDroolResult>> {
    const { description } = parameters;

    // Validate inputs
    if (!description || description.trim().length < 10) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'Description must be at least 10 characters',
        userError: 'Please provide a more detailed description of the drool',
      };
      return;
    }

    try {
      // Check abort signal
      if (dependencies.abortSignal?.aborted) {
        throw new ToolAbortError();
      }

      // Get session for API authentication
      const sessionService = getSessionService();
      const sessionId =
        sessionService.getCurrentSessionId() ||
        (await sessionService.createNewSession({
          firstUserMessage: 'Generate drool',
        }));

      // Generate configuration using Claude 4.5 Sonnet
      const config = await this.generateWithClaude(
        description,
        sessionId,
        dependencies.abortSignal
      );

      // Normalize and validate the configuration
      const result = this.normalizeConfig(config);

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: result,
      };
    } catch (error) {
      if (error instanceof ToolAbortError) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      logException(error, 'Failed to generate drool configuration');

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: `Error generating drool: ${errorMessage}`,
        userError: `Failed to generate drool configuration. Please try again.`,
      };
    }
  }

  private async generateWithClaude(
    description: string,
    sessionId: string,
    abortSignal?: AbortSignal
  ): Promise<unknown> {
    const anthropic = new Anthropic({
      apiKey: 'placeholder',
      baseURL: `${resolveCliApiBaseUrl(
        getRuntimeAuthConfig(),
        getCachedRegion()
      )}/api/llm/a`,
    });

    const headers = await createProxyHeaders({
      sessionId,
      proxyApiProvider: ApiProvider.ANTHROPIC,
    });

    const prompt = this.buildPrompt(description);

    const response = await anthropic.messages.create(
      {
        model: DEFAULT_DROOL_GENERATOR_MODEL,
        max_tokens: 2048,
        system: `${YOU_ARE_DROOL_SYSTEM_PROMPT} You are a specialized drool configuration generator. Create configurations that EXACTLY match the user's description. Never create generic assistants.`,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      },
      {
        headers,
        signal: abortSignal,
      }
    );

    // Extract text from response
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('');

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      throw new MetaError('Failed to extract JSON from LLM response', {
        value: { responsePreview: text.slice(0, 200) },
      });
    }

    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      throw new MetaError('Failed to parse JSON from LLM response', {
        value: {
          parseError: e instanceof Error ? e.message : 'Unknown parse error',
          json: jsonMatch[0],
        },
      });
    }
  }

  private buildPrompt(description: string): string {
    return `USER PROVIDED THIS INITIAL DESCRIPTION:
"""
${description}
"""

You are designing a specialized software-engineering drool. Your job:
1. Expand the user's description into a richer, more precise mission statement (2-4 sentences). Cover responsibilities, boundaries, and any success criteria. This becomes the drool's description.
2. Write a detailed system prompt that begins with "You are a ...". Give specific instructions about goals, tone, priorities, required outputs, and pitfalls to avoid.
3. Produce a concise kebab-case identifier derived from the enhanced description.

Hard constraints:
- DO NOT mention tools, capabilities, or model choices.
- The description must be at least 120 characters.
- The system prompt must be at least 200 characters and provide concrete guidance.
- Output JSON only with exactly these keys:
  {
    "identifier": string,
    "description": string,
    "systemPrompt": string
  }
- No prose outside the JSON.`;
  }

  private normalizeConfig(raw: unknown): GenerateDroolResult {
    // Validate against schema
    const parseResult = llmResponseSchema.safeParse(raw);
    if (!parseResult.success) {
      throw new MetaError('Invalid configuration structure from LLM', {
        value: {
          zodErrors: parseResult.error.errors,
          raw,
        },
      });
    }

    const config = parseResult.data;

    // Sanitize and validate identifier
    const sanitizedIdentifier = sanitizeDroolName(config.identifier);
    if (!sanitizedIdentifier) {
      throw new MetaError('Generated identifier is invalid', {
        value: { original: config.identifier },
      });
    }

    const refinedDescription = config.description.trim();
    if (refinedDescription.length < 120) {
      throw new MetaError('Generated description is too short', {
        value: { length: refinedDescription.length },
      });
    }

    const systemPrompt = config.systemPrompt.trim();
    if (systemPrompt.length < 200) {
      throw new MetaError('System prompt is too short', {
        value: { length: systemPrompt.length },
      });
    }

    return {
      identifier: sanitizedIdentifier,
      description: refinedDescription,
      systemPrompt,
    };
  }
}
