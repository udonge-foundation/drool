import type { ImageAttachment } from '@/types/types';
import { generateUUID } from '@/utils/uuid';

import type { Base64ImageSource } from '@industry/drool-sdk-ext/protocol/sessionV2';

const ALLOWED_IMAGE_MEDIA_TYPES = new Set<Base64ImageSource['mediaType']>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

function normalizeImageMediaType(
  mime: string | undefined
): Base64ImageSource['mediaType'] {
  const normalized = (mime || '').toLowerCase().trim();
  if (normalized === 'image/jpg') {
    return 'image/jpeg';
  }
  if (
    ALLOWED_IMAGE_MEDIA_TYPES.has(normalized as Base64ImageSource['mediaType'])
  ) {
    return normalized as Base64ImageSource['mediaType'];
  }
  return 'image/png';
}

function convertAttachmentsToBase64ImagesWithData(
  images: ImageAttachment[] | undefined,
  getData: (image: ImageAttachment) => string
): Base64ImageSource[] | undefined {
  const base64Images = images
    ?.filter((image) => image.base64Data)
    .map((image) => ({
      type: 'base64' as const,
      data: getData(image),
      mediaType: normalizeImageMediaType(image.mimeType),
    }));

  return base64Images && base64Images.length > 0 ? base64Images : undefined;
}

export function convertAttachmentsToBase64Images(
  images?: ImageAttachment[]
): Base64ImageSource[] | undefined {
  return convertAttachmentsToBase64ImagesWithData(
    images,
    (image) => image.base64Data ?? ''
  );
}

export function convertAttachmentsToPlaceholderBase64Images(
  images?: ImageAttachment[]
): Base64ImageSource[] | undefined {
  return convertAttachmentsToBase64ImagesWithData(images, () => '');
}

export function convertBase64ImagesToAttachments(
  images?: Base64ImageSource[]
): ImageAttachment[] | undefined {
  if (!images || images.length === 0) {
    return undefined;
  }

  return images.map((img, index) => ({
    id: generateUUID(),
    filename: `image-${index + 1}`,
    path: '',
    size: Math.ceil((img.data.length * 3) / 4),
    mimeType: img.mediaType,
    base64Data: img.data,
    displayIndex: index + 1,
  }));
}
