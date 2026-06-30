import fs from 'fs';

import { logInfo, logWarn } from '@industry/logging';

import type { DocumentBlock } from '@industry/drool-sdk-ext/protocol/sessionV2';

/**
 * Populates PDF document block data from disk.
 * Reads the PDF file from the stored path and sets the data field.
 */
export async function populatePdfDataFromDisk(
  docBlock: DocumentBlock
): Promise<DocumentBlock> {
  // Only process PDFs with a path but no data
  if (docBlock.source.mediaType !== 'application/pdf') {
    return docBlock;
  }

  if (!docBlock.source.path || docBlock.source.data) {
    return docBlock;
  }

  try {
    const fileBuffer = await fs.promises.readFile(docBlock.source.path);
    const base64Data = fileBuffer.toString('base64');

    logInfo('[Session] Populated PDF document block with file content', {
      path: docBlock.source.path,
      mimeType: docBlock.source.mediaType,
      size: fileBuffer.length,
    });

    return {
      ...docBlock,
      source: {
        ...docBlock.source,
        data: base64Data,
      },
    };
  } catch (error) {
    logWarn('[Session] Failed to read file for PDF document block', {
      path: docBlock.source.path,
      cause: error,
    });
    return docBlock;
  }
}
