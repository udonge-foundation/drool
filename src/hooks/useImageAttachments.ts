/**
 * Hook for managing image attachments in chat
 */

import { useState, useCallback } from 'react';

import { getI18n } from '@/i18n';
import { getTuiModelConfig, modelSupportsImages } from '@/models/config';
import { getImageStorage } from '@/services/imageStorage';
import { ImageAttachment } from '@/types/types';
import {
  checkClipboardForImage,
  pasteImageFromClipboard,
  detectImageFilePaths,
  loadImageFromFile,
} from '@/utils/clipboard';

interface UseImageAttachmentsOptions {
  currentModel?: string;
  onWarning?: (message: string) => void;
}

export function useImageAttachments(options: UseImageAttachmentsOptions = {}) {
  const { currentModel, onWarning } = options;
  const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([]);
  const [isProcessingImage, setIsProcessingImage] = useState(false);

  /**
   * Handle image paste from clipboard
   */
  const handleImagePaste = useCallback(async (): Promise<boolean> => {
    try {
      // Check if clipboard contains an image before showing any processing UI.
      // This avoids a brief "Processing image..." flash when pasting text.
      const clipboardInfo = await checkClipboardForImage();

      if (!clipboardInfo.hasImage) {
        if (clipboardInfo.error) {
          onWarning?.(
            getI18n().t('common:imageAttachment.failedClipboard', {
              error: clipboardInfo.error,
            })
          );
        }
        return false; // No image in clipboard
      }

      setIsProcessingImage(true);

      // Check if current model supports images
      if (currentModel && !modelSupportsImages(currentModel)) {
        const config = getTuiModelConfig(currentModel);
        onWarning?.(
          getI18n().t('common:imageAttachment.modelNoImageSupport', {
            model: config.shortDisplayName,
          })
        );
        return false;
      }

      // Extract and save the image
      const result = await pasteImageFromClipboard();

      if (result.success && result.image) {
        // Add display index for showing as [Image N]
        const newImage = {
          ...result.image,
          displayIndex: attachedImages.length + 1,
        };

        setAttachedImages((prev) => [...prev, newImage]);
        return true; // Image successfully pasted
      }

      if (!result.success && result.error) {
        onWarning?.(
          getI18n().t('common:imageAttachment.failedClipboard', {
            error: result.error,
          })
        );
      }

      return false;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : getI18n().t('common:imageAttachment.unknownPasteError');
      onWarning?.(
        getI18n().t('common:imageAttachment.failedClipboard', {
          error: message,
        })
      );
      return false;
    } finally {
      setIsProcessingImage(false);
    }
  }, [attachedImages.length, currentModel, onWarning]);

  /**
   * Remove an attached image
   */
  const removeImage = useCallback(async (imageId: string) => {
    // Remove from storage
    await getImageStorage().removeImage(imageId);

    // Update state and reassign display indices
    setAttachedImages((prev) => {
      const filtered = prev.filter((img) => img.id !== imageId);
      // Reassign display indices
      return filtered.map((img, index) => ({
        ...img,
        displayIndex: index + 1,
      }));
    });
  }, []);

  /**
   * Clear image state without touching on-disk storage. This is used when a
   * message is submitted so the UI immediately reflects that images were
   * sent, while the agent can continue reading from temp files.
   */
  const clearImagesStateOnly = useCallback(() => {
    setAttachedImages([]);
  }, []);

  const setImages = useCallback((images: ImageAttachment[]) => {
    setAttachedImages(
      images.map((image, index) => ({
        ...image,
        displayIndex: index + 1,
      }))
    );
  }, []);

  /**
   * Clear all attached images
   */
  const clearImages = useCallback(async () => {
    // Clear from storage
    await getImageStorage().clearAll();

    // Clear state
    clearImagesStateOnly();
  }, [clearImagesStateOnly]);

  /**
   * Get formatted display text for images
   */
  const getImageDisplayText = useCallback((): string => {
    if (attachedImages.length === 0) return '';

    const t = getI18n().t;
    if (attachedImages.length === 1) {
      return t('common:imageAttachment.imageLabel', { index: 1 });
    }

    return attachedImages
      .map((img) =>
        t('common:imageAttachment.imageLabel', { index: img.displayIndex })
      )
      .join(' ');
  }, [attachedImages]);

  /**
   * Get image references for API submission
   */
  const getImagesForSubmission = useCallback(
    (): ImageAttachment[] =>
      attachedImages.map((img) => ({
        ...img,
        // Ensure base64 data is included
        base64Data: img.base64Data,
      })),
    [attachedImages]
  );

  /**
   * Handle image file path paste (drag-and-drop)
   * Returns true if the text was an image file and was processed
   */
  const handleImageFilePathPaste = useCallback(
    async (text: string): Promise<boolean> => {
      // Check if current model supports images
      if (currentModel && !modelSupportsImages(currentModel)) {
        return false; // Don't interfere with text paste
      }

      setIsProcessingImage(true);

      try {
        // Check if this is one or more valid image file paths
        const detections = await detectImageFilePaths(text);

        if (!detections.every((detection) => detection.isImageFile)) {
          return false; // Not an image file, handle as normal text
        }

        const detectionError = detections.find((detection) => detection.error);
        if (detectionError?.error) {
          onWarning?.(detectionError.error);
          return false; // Error with file, insert as text
        }

        const loadedImages: ImageAttachment[] = [];

        for (const detection of detections) {
          const result = await loadImageFromFile(detection.path!);

          if (result.success && result.image) {
            loadedImages.push(result.image);
            continue;
          }

          await Promise.all(
            loadedImages.map((image) => getImageStorage().removeImage(image.id))
          );

          if (!result.success && result.error) {
            const target = detection.path || text;
            onWarning?.(
              getI18n().t('common:imageAttachment.failedAttachFile', {
                path: target,
                error: result.error,
              })
            );
          }

          return false; // Failed to load, insert path as text
        }

        setAttachedImages((prev) => [
          ...prev,
          ...loadedImages.map((image, index) => ({
            ...image,
            displayIndex: prev.length + index + 1,
          })),
        ]);
        return true; // Image(s) successfully loaded
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : getI18n().t('common:imageAttachment.unknownLoadError');
        onWarning?.(
          getI18n().t('common:imageAttachment.failedAttachFile', {
            path: text,
            error: message,
          })
        );
        return false;
      } finally {
        setIsProcessingImage(false);
      }
    },
    [currentModel, onWarning]
  );

  return {
    attachedImages,
    isProcessingImage,
    handleImagePaste,
    handleImageFilePathPaste,
    removeImage,
    clearImages,
    clearImagesStateOnly,
    setImages,
    getImageDisplayText,
    getImagesForSubmission,
  };
}
