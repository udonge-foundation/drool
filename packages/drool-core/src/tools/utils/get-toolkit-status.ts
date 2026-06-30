import { IntegrationType } from '@industry/common/integrations';

import { ToolkitStatus } from './types';
import {
  SLACK_POST_FILE_TOOL_ID,
  SLACK_POST_MESSAGE_TOOL_ID,
} from '../definitions/slack/schema';
import { IsNativeToolEnabledParams } from '../types';

const SLACK_TOOL_IDS = new Set([
  SLACK_POST_FILE_TOOL_ID,
  SLACK_POST_MESSAGE_TOOL_ID,
]);

export function isSlackAvailable(
  params: IsNativeToolEnabledParams,
  toolId?: string
): ToolkitStatus {
  // Check if explicitly enabled via enabledToolIds (e.g., Slack delegations, --enabled-tools)
  if (toolId && params.enabledToolIds?.some((id) => SLACK_TOOL_IDS.has(id))) {
    return params.enabledToolIds.includes(toolId)
      ? { isAvailable: true }
      : {
          isAvailable: false,
          message:
            'Slack integration is not set up. Please connect Slack first.',
        };
  }

  if (params.enabledToolIds?.some((id) => SLACK_TOOL_IDS.has(id))) {
    return { isAvailable: true };
  }

  // In web context, check if Slack integration is configured
  if (!params.integrations.includes(IntegrationType.SLACK)) {
    return {
      isAvailable: false,
      message: 'Slack integration is not set up. Please connect Slack first.',
    };
  }
  return { isAvailable: true };
}
