import fs from 'fs/promises';
import path from 'path';

import mime from 'mime';

import { ToolExecutionErrorType } from '@industry/common/session';
import { ReadCliParams } from '@industry/drool-core/tools/definitions';
import {
  MAX_IMAGE_SIZE_BYTES,
  MAX_PDF_PAGES,
  MAX_PDF_SIZE_BYTES,
  SUPPORTED_IMAGE_TYPES,
  SUPPORTED_PDF_TYPES,
} from '@industry/drool-core/tools/definitions/cli/constants';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import {
  DocumentBlock,
  DocumentSourceType,
  ImageBlock,
  MessageContentBlockType,
  TextBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logWarn } from '@industry/logging';
import { ToolAbortError } from '@industry/logging/errors';
import { scrubSecrets } from '@industry/utils/secretScrubber';

import {
  normalizeMacScreenshotPath,
  trackReadFile,
} from '@/agent/file-edit/utils';
import { ToolResultContent } from '@/hooks/types';
import {
  CliClientToolDependencies,
  CliClientSpecificToolDependencies,
} from '@/tools/types';
import {
  DynamicContextDiscovery,
  formatDynamicDiscoveryReminder,
} from '@/utils/dynamicContextDiscovery';
import { compressImageForLLM } from '@/utils/images/compressForLLM';
import type { ImageCompressionOptions } from '@/utils/images/types';
import {
  formatSecretRedactionReminder,
  wrapInSystemReminder,
} from '@/utils/systemReminderUtils';
import { truncateFileLines } from '@/utils/truncate';

function appendRedactionReminder(before: string, scrubbed: string): string {
  return scrubbed === before
    ? scrubbed
    : `${scrubbed}\n\n${wrapInSystemReminder(formatSecretRedactionReminder())}`;
}

async function getPdfPageCount(buffer: Buffer): Promise<number | null> {
  try {
    const { getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    return pdf.numPages;
  } catch (error) {
    logWarn('[ReadCli] PDF page count extraction failed', { cause: error });
    return null;
  }
}

async function extractPdfText(buffer: Buffer): Promise<string | null> {
  try {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(pdf, { mergePages: true });
    return result.text.trim() || null;
  } catch (error) {
    logWarn('[ReadCli] PDF text extraction failed, will use raw content', {
      cause: error,
    });
    return null;
  }
}

export class ReadCliExecutor
  implements
    ClientToolExecutor<CliClientSpecificToolDependencies, ToolResultContent>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: ReadCliParams
  ): AsyncGenerator<DraftToolFeedback<ToolResultContent>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const {
      file_path: filePath,
      offset = 0,
      limit = 2400,
      image_quality: imageQuality = 'default',
    } = parameters;

    if (!filePath || typeof filePath !== 'string') {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'file_path is required and must be a string',
        userError: 'Invalid file path provided',
      };
      return;
    }

    // Validate that the path is absolute
    if (!path.isAbsolute(filePath)) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'file_path must be an absolute path, not a relative path',
        userError: 'File path must be absolute',
      };
      return;
    }

    // Validate limit parameter (offset can be negative to read from end)
    if (limit <= 0) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'limit must be a positive number',
        userError: 'Invalid limit parameter',
      };
      return;
    }

    const resolveFilePath = async (candidatePath: string): Promise<string> => {
      try {
        await fs.access(candidatePath);
        return candidatePath;
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          // macOS screenshots: replace space before AM/PM with non-breaking space
          const correctedPath = normalizeMacScreenshotPath(candidatePath);

          if (correctedPath !== candidatePath) {
            try {
              await fs.access(correctedPath);
              return correctedPath;
            } catch {
              // Fall through to throw the original error
            }
          }
        }

        throw error;
      }
    };

    try {
      const resolvedFilePath = await resolveFilePath(filePath);

      // Check file type
      const mimeType = mime.getType(resolvedFilePath);
      const isImage = mimeType?.startsWith('image/');
      const isPdf = SUPPORTED_PDF_TYPES.includes(
        mimeType as (typeof SUPPORTED_PDF_TYPES)[number]
      );

      // Special handling: treat SVG files as text, not images
      const isSvg = mimeType === 'image/svg+xml';
      const shouldProcessAsImage = isImage && !isSvg;

      if (isPdf && mimeType) {
        // PDF handling: return as DocumentBlock for native provider support
        const stats = await fs.stat(resolvedFilePath);
        const buffer = await fs.readFile(resolvedFilePath);

        trackReadFile(resolvedFilePath, dependencies.toolCallId);

        if (stats.size <= MAX_PDF_SIZE_BYTES) {
          // Check page count — Anthropic limits PDFs to MAX_PDF_PAGES pages
          const pageCount = await getPdfPageCount(buffer);

          if (pageCount !== null && pageCount > MAX_PDF_PAGES) {
            // Too many pages for native PDF support — fall back to text extraction
            const extractedText = await extractPdfText(buffer);

            if (extractedText) {
              const header = `PDF file: ${path.basename(resolvedFilePath)} (${pageCount} pages, exceeds ${MAX_PDF_PAGES}-page limit for native PDF support — showing extracted text)`;
              const before = truncateFileLines(
                `${header}\n\n${extractedText}`,
                offset,
                limit
              );
              const scrubbed = scrubSecrets(before);

              yield {
                type: DraftToolFeedbackType.Result,
                isError: false,
                value: appendRedactionReminder(before, scrubbed),
              };
            } else {
              yield {
                type: DraftToolFeedbackType.Result,
                isError: true,
                errorType: ToolExecutionErrorType.ToolInternalError,
                llmError: `Failed to read PDF: ${path.basename(resolvedFilePath)} has ${pageCount} pages which exceeds the ${MAX_PDF_PAGES}-page limit, and text extraction failed. The file may be scanned/image-based. Try asking the user to provide a shorter document or specific page ranges.`,
                userError: `PDF has ${pageCount} pages (max ${MAX_PDF_PAGES} for native support) and text extraction failed`,
              };
            }
          } else {
            // Small enough for native PDF support
            const blocks: Array<TextBlock | DocumentBlock> = [
              {
                type: MessageContentBlockType.Text,
                text: `PDF file: ${path.basename(resolvedFilePath)} (${(stats.size / 1024).toFixed(1)} KB, ${Math.ceil((stats.size / 1024 / 1024) * 100) / 100} MB)`,
              },
              {
                type: MessageContentBlockType.Document,
                source: {
                  type: DocumentSourceType.Base64,
                  mediaType: 'application/pdf',
                  data: buffer.toString('base64'),
                  name: path.basename(resolvedFilePath),
                  path: resolvedFilePath,
                },
              },
            ];

            yield {
              type: DraftToolFeedbackType.Result,
              isError: false,
              value: blocks,
            };
          }
        } else {
          // Oversized PDF: fall back to text extraction
          const extractedText = await extractPdfText(buffer);
          const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
          const limitMB = MAX_PDF_SIZE_BYTES / (1024 * 1024);

          if (extractedText) {
            const header = `PDF file: ${path.basename(resolvedFilePath)} (${sizeMB}MB, exceeds ${limitMB}MB native limit — showing extracted text)`;
            const before = truncateFileLines(
              `${header}\n\n${extractedText}`,
              offset,
              limit
            );
            const scrubbed = scrubSecrets(before);

            yield {
              type: DraftToolFeedbackType.Result,
              isError: false,
              value: appendRedactionReminder(before, scrubbed),
            };
          } else {
            yield {
              type: DraftToolFeedbackType.Result,
              isError: true,
              errorType: ToolExecutionErrorType.ToolInternalError,
              llmError: `Failed to read PDF: ${path.basename(resolvedFilePath)} (${sizeMB}MB). Could not extract text from this file — it may be scanned/image-based or corrupted. Try converting it to text first using an external tool, or use a smaller PDF (under ${limitMB}MB) for native support.`,
              userError: `Failed to extract text from PDF (${sizeMB}MB)`,
            };
          }
        }
      } else if (shouldProcessAsImage && mimeType) {
        // Validate supported image types
        if (
          !SUPPORTED_IMAGE_TYPES.includes(
            mimeType as (typeof SUPPORTED_IMAGE_TYPES)[number]
          )
        ) {
          yield {
            type: DraftToolFeedbackType.Result,
            isError: true,
            errorType: ToolExecutionErrorType.InvalidParameterLLMError,
            llmError: `Unsupported image type: ${mimeType}. Supported types: ${SUPPORTED_IMAGE_TYPES.join(', ')}`,
            userError: 'Unsupported image format',
          };
          return;
        }

        // Read image as buffer
        const buffer = await fs.readFile(resolvedFilePath);
        const stats = await fs.stat(resolvedFilePath);

        // Validate size (5MB limit for Claude)
        if (stats.size > MAX_IMAGE_SIZE_BYTES) {
          yield {
            type: DraftToolFeedbackType.Result,
            isError: true,
            errorType: ToolExecutionErrorType.InvalidParameterLLMError,
            llmError: `Image file exceeds ${MAX_IMAGE_SIZE_BYTES / (1024 * 1024)}MB size limit. File size: ${(stats.size / (1024 * 1024)).toFixed(2)}MB`,
            userError: `Image file too large (max ${MAX_IMAGE_SIZE_BYTES / (1024 * 1024)}MB)`,
          };
          return;
        }

        // Track that this file has been read
        trackReadFile(resolvedFilePath, dependencies.toolCallId);

        // Compress image before sending to LLM
        const compressionOptions: ImageCompressionOptions | undefined =
          imageQuality === 'high'
            ? { maxSizeBytes: 1024 * 1024, maxDimensionPx: 2048 }
            : undefined;
        const compressed = await compressImageForLLM(
          buffer,
          mimeType,
          compressionOptions
        );

        const mediaType = (compressed.contentType ||
          mimeType) as (typeof SUPPORTED_IMAGE_TYPES)[number];

        const blocks: Array<TextBlock | ImageBlock> = [
          {
            type: MessageContentBlockType.Text,
            text: `Image file: ${path.basename(resolvedFilePath)} (original size: ${(stats.size / 1024).toFixed(1)} KB). Image quality: ${imageQuality}`,
          },
          {
            type: MessageContentBlockType.Image,
            source: {
              type: 'base64',
              mediaType,
              data: compressed.buffer.toString('base64'),
            },
          },
        ];

        yield {
          type: DraftToolFeedbackType.Result,
          isError: false,
          value: blocks,
        };
      } else {
        // Regular text file handling
        const content = await fs.readFile(resolvedFilePath, 'utf-8');

        // Track that this file has been read with toolCallId
        trackReadFile(resolvedFilePath, dependencies.toolCallId);

        // Apply offset and limit with line numbering
        let processedContent = truncateFileLines(content, offset, limit);

        // Discover AGENTS.md and skills along the path to this file
        try {
          const discovery = DynamicContextDiscovery.getInstance();
          const discovered =
            await discovery.discoverAlongPath(resolvedFilePath);
          const reminder = formatDynamicDiscoveryReminder(discovered);
          if (reminder) {
            processedContent = `${processedContent}\n\n${reminder}`;
          }
        } catch {
          // Discovery failure should never block the read result
        }

        // Scrub secrets from file contents (and any appended reminders) before returning to the LLM
        const before = processedContent;
        processedContent = appendRedactionReminder(
          before,
          scrubSecrets(before)
        );

        yield {
          type: DraftToolFeedbackType.Result,
          isError: false,
          value: processedContent,
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: `Error reading file: ${errorMessage}`,
        userError: 'Failed to read file',
      };
    }
  }
}
