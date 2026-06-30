import {
  type Base64ImageSource,
  type ContentBlock,
  type DocumentSource,
  MessageContentBlockType,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { buildUserMessageContentBlocks } from '@industry/utils/messages';

import {
  convertAttachmentsToBase64Images,
  convertBase64ImagesToAttachments,
} from '@/exec/imageAttachments';
import type { ImageAttachment } from '@/types/types';

/**
 * Serialize a queued user prompt (text + optional attachments) into the
 * `ContentBlock[]` shape that the SessionStateManager queue stores, for any
 * queue kind (e.g. LocalDeferredAfterEsc, LocalPausedAfterEsc,
 * DaemonQueuedDiscardable, DaemonQueuedEndOfLoop).
 *
 * Images are emitted first and only if they carry inline `base64Data`, so the
 * stored payload is self-contained and can be drained later without touching
 * the filesystem.
 */
export function buildQueuedPromptContent({
  text,
  images,
  files,
}: {
  text: string;
  images?: ImageAttachment[];
  files?: DocumentSource[];
}): ContentBlock[] {
  return buildUserMessageContentBlocks({
    text,
    images: convertAttachmentsToBase64Images(images),
    files,
  });
}

/**
 * Inverse of `buildQueuedPromptContent`: unpack a stored queue entry back into
 * the `{ text, images, files }` tuple that `processAndRun` / `handleSubmit`
 * expect.
 *
 * Text blocks are concatenated with newlines; base64 image blocks are
 * reconstructed as `ImageAttachment`s with synthetic filenames / sizes so the
 * drain path can feed them through the normal submission pipeline.
 */
export function extractQueuedPromptContent(content: ContentBlock[]): {
  text: string;
  images?: ImageAttachment[];
  files?: DocumentSource[];
} {
  const text = content
    .filter(
      (
        block
      ): block is Extract<
        ContentBlock,
        { type: MessageContentBlockType.Text }
      > => block.type === MessageContentBlockType.Text
    )
    .map((block) => block.text)
    .join('\n');

  const imageSources: Base64ImageSource[] = [];
  const files: DocumentSource[] = [];
  content.forEach((block) => {
    if (block.type === MessageContentBlockType.Document) {
      files.push(block.source);
      return;
    }

    if (
      block.type !== MessageContentBlockType.Image ||
      block.source.type !== 'base64'
    ) {
      return;
    }

    imageSources.push(block.source);
  });
  const images = convertBase64ImagesToAttachments(imageSources);

  return {
    text,
    ...(images ? { images } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
}
