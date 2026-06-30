/**
 * Maximum constraints for wiki API payloads
 */
export const WIKI_MAX_PAGES = 200;
export const WIKI_MAX_PAGE_CONTENT_LENGTH = 512_000; // 500KB
export const WIKI_MAX_PAGE_TREE_DEPTH = 5;

/**
 * Wiki image constraints
 */

/** Maximum size per image in bytes (5MB) */
export const WIKI_MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB = 5242880

/** Maximum total size of all images in a single request in bytes (50MB) */
export const WIKI_MAX_TOTAL_IMAGES_SIZE = 50 * 1024 * 1024; // 50MB = 52428800

/** Maximum number of images per wiki run */
export const WIKI_MAX_IMAGE_COUNT = 100;

/** Supported image MIME types */
export const WIKI_SUPPORTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

/**
 * Wiki video overview constraints
 */

/** Maximum size of a wiki video overview in bytes (100MB) */
export const WIKI_VIDEO_MAX_BYTES = 100 * 1024 * 1024; // 100MB = 104857600

/** Required content type for wiki video overviews */
export const WIKI_VIDEO_CONTENT_TYPE = 'video/mp4' as const;

/** Maximum size of a wiki video caption track in bytes (1MB) */
export const WIKI_VIDEO_CAPTION_MAX_BYTES = 1 * 1024 * 1024; // 1MB = 1048576

/** Required content type for wiki video caption tracks */
export const WIKI_VIDEO_CAPTION_CONTENT_TYPE = 'text/vtt' as const;

/** Expiry time in seconds for presigned video playback URLs (15 minutes) */
export const WIKI_VIDEO_PLAYBACK_EXPIRY_SECONDS = 15 * 60; // 900s
