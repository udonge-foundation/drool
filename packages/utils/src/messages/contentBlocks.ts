import { TOOL_RESULT_PENDING_MARKER } from '@industry/common/sessionV2';
import { MessageContentBlockType } from '@industry/drool-sdk-ext/protocol/sessionV2';

import type {
  Base64ImageSource,
  ContentBlock,
  DocumentSource,
  IndustryDroolMessage,
  TextBlock,
  ToolResultBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

type ToolResultIdentityFields = {
  toolUseId?: string;
  tool_use_id?: string;
};

type ToolResultErrorFields = {
  isError?: boolean;
  is_error?: boolean;
};

type ToolResultContentFields = {
  content?: ToolResultBlock['content'] | null;
};

export function isNonEmptyTextBlock(block: ContentBlock): block is TextBlock {
  return (
    block.type === MessageContentBlockType.Text && block.text.trim() !== ''
  );
}

export function hasUsableTextContent(content: ContentBlock[]): boolean {
  return content.some(isNonEmptyTextBlock);
}

export function getToolResultToolUseId(
  block: ToolResultIdentityFields
): string | undefined {
  return block.toolUseId ?? block.tool_use_id;
}

export function isToolResultError(block: ToolResultErrorFields): boolean {
  return block.isError === true || block.is_error === true;
}

export function getToolResultBlocks(msg: {
  content?: IndustryDroolMessage['content'] | string | null;
}): ToolResultBlock[] {
  if (!Array.isArray(msg.content)) {
    return [];
  }
  return msg.content.filter(
    (block): block is ToolResultBlock =>
      block.type === MessageContentBlockType.ToolResult
  );
}

export function isPendingToolResult(block: ToolResultContentFields): boolean {
  return (
    block.content === undefined ||
    block.content === null ||
    block.content === TOOL_RESULT_PENDING_MARKER ||
    block.content === ''
  );
}

export function isPendingToolResultMarker(
  block: ToolResultContentFields
): boolean {
  return block.content === TOOL_RESULT_PENDING_MARKER;
}

interface BuildUserMessageContentBlocksParams {
  text?: string;
  images?: Base64ImageSource[];
  files?: DocumentSource[];
  trimText?: boolean;
  includeEmptyText?: boolean;
}

export function buildUserMessageContentBlocks({
  text,
  images,
  files,
  trimText = false,
  includeEmptyText = true,
}: BuildUserMessageContentBlocksParams): ContentBlock[] {
  const contentBlocks: ContentBlock[] = [];

  for (const image of images ?? []) {
    contentBlocks.push({
      type: MessageContentBlockType.Image,
      source: image,
    });
  }

  for (const file of files ?? []) {
    contentBlocks.push({
      type: MessageContentBlockType.Document,
      source: file,
    });
  }

  const textValue = trimText ? text?.trim() : text;
  if (textValue !== undefined && (includeEmptyText || textValue.length > 0)) {
    contentBlocks.push({
      type: MessageContentBlockType.Text,
      text: textValue,
    });
  }

  return contentBlocks;
}
