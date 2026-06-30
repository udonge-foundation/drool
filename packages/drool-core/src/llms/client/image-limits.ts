import {
  ContentBlock,
  DocumentBlock,
  IndustryDroolMessage,
  ImageBlock,
  MessageContentBlockType,
  TextBlock,
  ToolResultBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logInfo, logWarn } from '@industry/logging';

const MAX_IMAGES_IN_CONVERSATION = 10;
const MAX_PDFS_IN_CONVERSATION = 5;

interface ImageLocation {
  messageIndex: number;
  blockIndex: number;
  // For images inside tool_result content
  toolResultContentIndex?: number;
}

/**
 * Counts all images in a message's content blocks.
 * Images can be:
 * 1. Direct ImageBlock in message content
 * 2. ImageBlock inside ToolResultBlock.content array
 */
export function countImagesInMessage(message: IndustryDroolMessage): number {
  let count = 0;
  for (const block of message.content) {
    if (block.type === MessageContentBlockType.Image) {
      count++;
    } else if (
      block.type === MessageContentBlockType.ToolResult &&
      Array.isArray(block.content)
    ) {
      count += block.content.filter(
        (c) => c.type === MessageContentBlockType.Image
      ).length;
    }
  }
  return count;
}

/**
 * Collects locations of all images in the conversation, ordered from oldest to newest.
 */
function collectImageLocations(
  messages: IndustryDroolMessage[]
): ImageLocation[] {
  const locations: ImageLocation[] = [];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    for (
      let blockIndex = 0;
      blockIndex < message.content.length;
      blockIndex++
    ) {
      const block = message.content[blockIndex];

      if (block.type === MessageContentBlockType.Image) {
        locations.push({ messageIndex, blockIndex });
      } else if (
        block.type === MessageContentBlockType.ToolResult &&
        Array.isArray(block.content)
      ) {
        for (
          let toolResultContentIndex = 0;
          toolResultContentIndex < block.content.length;
          toolResultContentIndex++
        ) {
          if (
            block.content[toolResultContentIndex].type ===
            MessageContentBlockType.Image
          ) {
            locations.push({
              messageIndex,
              blockIndex,
              toolResultContentIndex,
            });
          }
        }
      }
    }
  }

  return locations;
}

/**
 * Creates a text block placeholder for a removed image.
 */
function createImagePlaceholder(): TextBlock {
  return {
    type: MessageContentBlockType.Text,
    text: '[Image was removed to reduce conversation size]',
  };
}

/**
 * Creates a text block placeholder for a removed PDF.
 */
function createPdfPlaceholder(name?: string): TextBlock {
  const nameInfo = name ? ` (${name})` : '';
  return {
    type: MessageContentBlockType.Text,
    text: `[PDF document${nameInfo} was removed to reduce conversation size]`,
  };
}

/**
 * Limits images in conversation history to avoid 413 errors.
 * Removes OLDEST images first to preserve recent context.
 * Replaces removed images with text placeholders.
 *
 * @param messages - The conversation history
 * @param maxImages - Maximum number of images to keep (default: 10)
 * @returns A new array of messages with old images replaced by placeholders
 */
export function limitConversationImages(
  messages: IndustryDroolMessage[],
  maxImages: number = MAX_IMAGES_IN_CONVERSATION
): IndustryDroolMessage[] {
  try {
    // Count total images
    let totalImages = 0;
    for (const message of messages) {
      totalImages += countImagesInMessage(message);
    }

    // If within limit, return as-is
    if (totalImages <= maxImages) {
      return messages;
    }

    const imagesToRemove = totalImages - maxImages;
    logWarn(
      '[limitConversationImages] Removing old images to stay within limit',
      {
        count: totalImages,
        limit: maxImages,
        deletedCount: imagesToRemove,
      }
    );

    // Collect all image locations (ordered oldest to newest)
    const imageLocations = collectImageLocations(messages);

    // Determine which images to remove (oldest first)
    const locationsToRemove = new Set(
      imageLocations.slice(0, imagesToRemove).map((loc) => JSON.stringify(loc))
    );

    // Create a deep copy and replace removed images with placeholders
    const result: IndustryDroolMessage[] = messages.map(
      (message, messageIndex) => {
        const newContent: ContentBlock[] = [];

        for (
          let blockIndex = 0;
          blockIndex < message.content.length;
          blockIndex++
        ) {
          const block = message.content[blockIndex];

          if (block.type === MessageContentBlockType.Image) {
            const locationKey = JSON.stringify({ messageIndex, blockIndex });
            if (locationsToRemove.has(locationKey)) {
              newContent.push(createImagePlaceholder());
            } else {
              newContent.push(block);
            }
          } else if (
            block.type === MessageContentBlockType.ToolResult &&
            Array.isArray(block.content)
          ) {
            // Process tool result content
            const newToolResultContent: Array<
              TextBlock | ImageBlock | DocumentBlock
            > = [];

            for (
              let toolResultContentIndex = 0;
              toolResultContentIndex < block.content.length;
              toolResultContentIndex++
            ) {
              const innerBlock = block.content[toolResultContentIndex];

              if (innerBlock.type === MessageContentBlockType.Image) {
                const locationKey = JSON.stringify({
                  messageIndex,
                  blockIndex,
                  toolResultContentIndex,
                });
                if (locationsToRemove.has(locationKey)) {
                  newToolResultContent.push(createImagePlaceholder());
                } else {
                  newToolResultContent.push(innerBlock);
                }
              } else {
                newToolResultContent.push(innerBlock);
              }
            }

            const newToolResult: ToolResultBlock = {
              ...block,
              content: newToolResultContent,
            };
            newContent.push(newToolResult);
          } else {
            newContent.push(block);
          }
        }

        return {
          ...message,
          content: newContent,
        };
      }
    );

    return result;
  } catch (error) {
    logWarn(
      '[limitConversationImages] Error processing images, returning original messages',
      {
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return messages;
  }
}

interface PdfLocation {
  messageIndex: number;
  blockIndex: number;
  toolResultContentIndex?: number;
  name?: string;
}

function collectPdfLocations(messages: IndustryDroolMessage[]): PdfLocation[] {
  const locations: PdfLocation[] = [];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    for (
      let blockIndex = 0;
      blockIndex < message.content.length;
      blockIndex++
    ) {
      const block = message.content[blockIndex];

      if (
        block.type === MessageContentBlockType.Document &&
        block.source.mediaType === 'application/pdf'
      ) {
        locations.push({
          messageIndex,
          blockIndex,
          name: block.source.name,
        });
      } else if (
        block.type === MessageContentBlockType.ToolResult &&
        Array.isArray(block.content)
      ) {
        for (
          let toolResultContentIndex = 0;
          toolResultContentIndex < block.content.length;
          toolResultContentIndex++
        ) {
          const inner = block.content[toolResultContentIndex];
          if (inner.type !== MessageContentBlockType.Document) continue;
          if (inner.source.mediaType !== 'application/pdf') continue;
          locations.push({
            messageIndex,
            blockIndex,
            toolResultContentIndex,
            name: inner.source.name,
          });
        }
      }
    }
  }

  return locations;
}

/**
 * Limits PDFs in conversation history to avoid excessive context size.
 * Removes OLDEST PDFs first to preserve recent context.
 * Replaces removed PDFs with text placeholders.
 */
export function limitConversationPDFs(
  messages: IndustryDroolMessage[],
  maxPdfs: number = MAX_PDFS_IN_CONVERSATION
): IndustryDroolMessage[] {
  try {
    const pdfLocations = collectPdfLocations(messages);

    if (pdfLocations.length <= maxPdfs) {
      return messages;
    }

    const pdfsToRemove = pdfLocations.length - maxPdfs;
    logWarn('[limitConversationPDFs] Removing old PDFs to stay within limit', {
      totalCount: pdfLocations.length,
      limit: maxPdfs,
      count: pdfsToRemove,
    });

    const locationsToRemove = new Map(
      pdfLocations.slice(0, pdfsToRemove).map((loc) => [
        JSON.stringify({
          messageIndex: loc.messageIndex,
          blockIndex: loc.blockIndex,
          ...(loc.toolResultContentIndex !== undefined && {
            toolResultContentIndex: loc.toolResultContentIndex,
          }),
        }),
        loc.name,
      ])
    );

    const result: IndustryDroolMessage[] = messages.map(
      (message, messageIndex) => {
        const newContent: ContentBlock[] = [];

        for (
          let blockIndex = 0;
          blockIndex < message.content.length;
          blockIndex++
        ) {
          const block = message.content[blockIndex];

          if (block.type === MessageContentBlockType.Document) {
            const locationKey = JSON.stringify({ messageIndex, blockIndex });
            if (locationsToRemove.has(locationKey)) {
              newContent.push(
                createPdfPlaceholder(locationsToRemove.get(locationKey))
              );
            } else {
              newContent.push(block);
            }
          } else if (
            block.type === MessageContentBlockType.ToolResult &&
            Array.isArray(block.content)
          ) {
            const newToolResultContent: Array<
              TextBlock | ImageBlock | DocumentBlock
            > = [];

            for (
              let toolResultContentIndex = 0;
              toolResultContentIndex < block.content.length;
              toolResultContentIndex++
            ) {
              const innerBlock = block.content[toolResultContentIndex];

              if (innerBlock.type === MessageContentBlockType.Document) {
                const locationKey = JSON.stringify({
                  messageIndex,
                  blockIndex,
                  toolResultContentIndex,
                });
                if (locationsToRemove.has(locationKey)) {
                  newToolResultContent.push(
                    createPdfPlaceholder(locationsToRemove.get(locationKey))
                  );
                } else {
                  newToolResultContent.push(innerBlock);
                }
              } else {
                newToolResultContent.push(innerBlock);
              }
            }

            const newToolResult: ToolResultBlock = {
              ...block,
              content: newToolResultContent,
            };
            newContent.push(newToolResult);
          } else {
            newContent.push(block);
          }
        }

        return {
          ...message,
          content: newContent,
        };
      }
    );

    return result;
  } catch (error) {
    logWarn(
      '[limitConversationPDFs] Error processing PDFs, returning original messages',
      {
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return messages;
  }
}

const IMAGE_NOT_SUPPORTED_PLACEHOLDER =
  '[Image not shown: this model does not support image inputs]';

function createImageNotSupportedPlaceholder(): TextBlock {
  return {
    type: MessageContentBlockType.Text,
    text: IMAGE_NOT_SUPPORTED_PLACEHOLDER,
  };
}

function replaceImagesInToolResult(block: ToolResultBlock): {
  newBlock: ToolResultBlock;
  count: number;
} {
  let count = 0;
  const newToolResultContent: Array<TextBlock | ImageBlock> = (
    block.content as Array<TextBlock | ImageBlock>
  ).map((c) => {
    if (c.type === MessageContentBlockType.Image) {
      count++;
      return createImageNotSupportedPlaceholder();
    }
    return c;
  });

  return {
    newBlock: { ...block, content: newToolResultContent },
    count,
  };
}

/**
 * Strips all image content blocks from a conversation history.
 * Used when the target model does not support image inputs (e.g., GLM-5, MiniMax M2.5).
 *
 * Images can appear in two places:
 * 1. Direct ImageBlock in user message content (user-attached images)
 * 2. ImageBlock inside ToolResultBlock.content (e.g., screenshots from Read, Figma, browser tools)
 *
 * Replaces removed images with a text placeholder so the model knows an image was present.
 */
export function stripImagesFromConversation(
  messages: IndustryDroolMessage[]
): IndustryDroolMessage[] {
  let strippedCount = 0;

  const result = messages.map((message) => {
    const newContent: ContentBlock[] = [];
    let messageModified = false;

    for (const block of message.content) {
      if (block.type === MessageContentBlockType.Image) {
        strippedCount++;
        messageModified = true;
        newContent.push(createImageNotSupportedPlaceholder());
      } else if (
        block.type === MessageContentBlockType.ToolResult &&
        Array.isArray(block.content)
      ) {
        const hasImages = block.content.some(
          (c) => c.type === MessageContentBlockType.Image
        );

        if (hasImages) {
          messageModified = true;
          const { newBlock, count } = replaceImagesInToolResult(block);
          strippedCount += count;
          newContent.push(newBlock);
        } else {
          newContent.push(block);
        }
      } else {
        newContent.push(block);
      }
    }

    if (messageModified) {
      return { ...message, content: newContent };
    }
    return message;
  });

  if (strippedCount > 0) {
    logInfo(
      '[stripImagesFromConversation] Stripped images for non-image model',
      {
        redactedCount: strippedCount,
      }
    );
  }

  return result;
}
