import jpeg from 'jpeg-js';
import { PNG } from 'pngjs/lib/png.js';

import { MetaError } from '@industry/logging/errors';

import {
  MAX_LLM_IMAGE_DIMENSION_PX,
  MAX_LLM_IMAGE_SIZE_BYTES,
} from '@/utils/images/constants';
import type {
  CompressedImageResult,
  ImageCompressionOptions,
} from '@/utils/images/types';

interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
}

function decodeImage(buffer: Buffer, mimeType: string): RgbaImage {
  const normalizedMime = mimeType.toLowerCase();

  if (normalizedMime === 'image/jpeg' || normalizedMime === 'image/jpg') {
    const decoded = jpeg.decode(buffer, { useTArray: true });

    if (!decoded || !decoded.data || !decoded.width || !decoded.height) {
      throw new Error('Failed to decode JPEG image');
    }

    return {
      data: decoded.data,
      width: decoded.width,
      height: decoded.height,
    };
  }

  if (normalizedMime === 'image/png') {
    const png = PNG.sync.read(buffer);

    return {
      data: png.data,
      width: png.width,
      height: png.height,
    };
  }

  throw new MetaError(
    'Unsupported image type for compression. Only PNG and JPEG images are supported.',
    { mimeType }
  );
}

function resizeImageNearestNeighbor(
  src: RgbaImage,
  maxDimension: number
): RgbaImage {
  const { width, height, data } = src;
  const maxSide = Math.max(width, height);

  if (maxSide <= maxDimension) {
    return src;
  }

  const scale = maxDimension / maxSide;
  const newWidth = Math.max(1, Math.round(width * scale));
  const newHeight = Math.max(1, Math.round(height * scale));

  const dstData = new Uint8Array(newWidth * newHeight * 4);

  for (let y = 0; y < newHeight; y += 1) {
    const srcY = Math.min(height - 1, Math.floor((y * height) / newHeight));

    for (let x = 0; x < newWidth; x += 1) {
      const srcX = Math.min(width - 1, Math.floor((x * width) / newWidth));

      const srcIdx = (srcY * width + srcX) * 4;
      const dstIdx = (y * newWidth + x) * 4;

      dstData[dstIdx] = data[srcIdx];
      dstData[dstIdx + 1] = data[srcIdx + 1];
      dstData[dstIdx + 2] = data[srcIdx + 2];
      dstData[dstIdx + 3] = data[srcIdx + 3];
    }
  }

  return {
    data: dstData,
    width: newWidth,
    height: newHeight,
  };
}

const INITIAL_JPEG_QUALITY = 100;
const MIN_JPEG_QUALITY = 20;
const MAX_QUALITY_ITERATIONS = 8;

function encodeJpeg(image: RgbaImage, quality: number): Buffer {
  const encoded = jpeg.encode(
    {
      data: image.data,
      width: image.width,
      height: image.height,
    },
    quality
  );

  return Buffer.from(encoded.data);
}

function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png);
}

export async function compressImageForLLM(
  buffer: Buffer,
  mimeType: string,
  options?: ImageCompressionOptions
): Promise<CompressedImageResult> {
  const maxSizeBytes = options?.maxSizeBytes ?? MAX_LLM_IMAGE_SIZE_BYTES;
  const maxDimensionPx = options?.maxDimensionPx ?? MAX_LLM_IMAGE_DIMENSION_PX;
  const originalSize = buffer.length;

  // Canonicalize MIME type (normalize casing and image/jpg -> image/jpeg)
  const normalizedMimeType = mimeType.toLowerCase();
  const canonicalMimeType =
    normalizedMimeType === 'image/jpg' ? 'image/jpeg' : normalizedMimeType;

  const decoded = decodeImage(buffer, canonicalMimeType);
  const needsResize = Math.max(decoded.width, decoded.height) > maxDimensionPx;

  // Resize only if necessary
  const imageToEncode = needsResize
    ? resizeImageNearestNeighbor(decoded, maxDimensionPx)
    : decoded;

  // Try to keep original format first
  // Always re-encode (even when under limits) to strip metadata (EXIF, PNG chunks, etc.)
  let currentBuffer: Buffer;
  let currentContentType: string;

  if (canonicalMimeType === 'image/png') {
    currentBuffer = encodePng(imageToEncode);
    currentContentType = 'image/png';
  } else {
    currentBuffer = encodeJpeg(imageToEncode, INITIAL_JPEG_QUALITY);
    currentContentType = 'image/jpeg';
  }

  // If still under limit with original format, we're done
  if (currentBuffer.length <= maxSizeBytes) {
    return {
      buffer: currentBuffer,
      contentType: currentContentType,
      originalSize,
      finalSize: currentBuffer.length,
    };
  }

  // Last resort: convert to JPEG and compress quality
  let quality = INITIAL_JPEG_QUALITY;
  currentBuffer = encodeJpeg(imageToEncode, quality);
  let lastSize = currentBuffer.length;
  let iterations = 0;

  while (
    currentBuffer.length > maxSizeBytes &&
    quality > MIN_JPEG_QUALITY &&
    iterations < MAX_QUALITY_ITERATIONS
  ) {
    const nextQuality = Math.max(MIN_JPEG_QUALITY, Math.floor(quality * 0.8));

    if (nextQuality >= quality) {
      break;
    }

    quality = nextQuality;
    const nextBuffer = encodeJpeg(imageToEncode, quality);
    iterations += 1;

    if (nextBuffer.length >= lastSize) {
      break;
    }

    currentBuffer = nextBuffer;
    lastSize = currentBuffer.length;
  }

  if (currentBuffer.length > maxSizeBytes) {
    const maxSizeMb = Math.round((maxSizeBytes / (1024 * 1024)) * 100) / 100;
    const finalSizeMb =
      Math.round((currentBuffer.length / (1024 * 1024)) * 100) / 100;

    throw new MetaError('Unable to compress image below provider size limit', {
      maxSizeMb,
      finalSizeMb,
    });
  }

  return {
    buffer: currentBuffer,
    contentType: 'image/jpeg',
    originalSize,
    finalSize: currentBuffer.length,
  };
}
