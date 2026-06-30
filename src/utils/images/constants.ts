/**
 * Maximum size of an image payload we send to the LLM (in bytes).
 * Can be overridden per-call via ImageCompressionOptions.
 */
export const MAX_LLM_IMAGE_SIZE_BYTES = 200 * 1024; // ~200KB

/**
 * Maximum width/height in pixels for an image. Larger images are downscaled
 * while preserving aspect ratio. For CLI we use a much smaller cap since
 * images are only used as LLM hints, not for high-fidelity display.
 * Can be overridden per-call via ImageCompressionOptions.
 */
export const MAX_LLM_IMAGE_DIMENSION_PX = 1_024;
