/**
 * Temporary image storage service for CLI chat
 */

import * as fs from 'fs';
import * as path from 'path';

import { v4 as uuidv4 } from 'uuid';

import { logWarn } from '@industry/logging';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { ImageAttachment } from '@/types/types';
import { SHUTDOWN_HOOK_PRIORITY } from '@/utils/constants';
import { compressImageForLLM } from '@/utils/images/compressForLLM';
import { MAX_LLM_IMAGE_SIZE_BYTES } from '@/utils/images/constants';
import { getShutdownCoordinator } from '@/utils/shutdownCoordinator';

class ImageStorageService {
  static readonly MAX_RAW_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;

  private tempDir: string;

  private images: Map<string, ImageAttachment> = new Map();

  constructor() {
    // Create a unique temp directory for this session
    const sessionId = uuidv4().substring(0, 8);
    this.tempDir = path.join(
      getIndustryHome(),
      getIndustryDirName(),
      'temp',
      'images',
      sessionId
    );
    this.ensureTempDir();
  }

  private ensureTempDir(): void {
    try {
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }
    } catch (error) {
      // Log error but don't throw - allow service to initialize
      // Image features may not work, but CLI won't crash on startup
      logWarn('Failed to create temp directory for images', {
        directory: this.tempDir,
        cause: error,
      });
    }
  }

  /**
   * Save image data to temporary storage
   */
  async saveImage(
    data: Buffer,
    originalFilename?: string,
    mimeType?: string
  ): Promise<ImageAttachment> {
    // Compress image client-side before persisting to disk to avoid
    // exceeding provider / transport limits when sending to the LLM.
    const compressed = await compressImageForLLM(data, mimeType || 'image/png');

    const finalMimeType = compressed.contentType || mimeType || 'image/jpeg';
    const id = uuidv4();
    const extension =
      ImageStorageService.getExtensionFromMimeType(finalMimeType) || 'jpg';
    const filename =
      originalFilename || `pasted-image-${Date.now()}.${extension}`;
    const filepath = path.join(this.tempDir, `${id}.${extension}`);

    // Write image to disk
    await fs.promises.writeFile(filepath, compressed.buffer);

    // Get file stats
    const stats = await fs.promises.stat(filepath);

    // Convert to base64 for API transmission
    const base64Data = compressed.buffer.toString('base64');

    const image: ImageAttachment = {
      id,
      filename,
      path: filepath,
      size: stats.size,
      mimeType: finalMimeType,
      base64Data,
    };

    this.images.set(id, image);
    return image;
  }

  /**
   * Get image by ID
   */
  getImage(id: string): ImageAttachment | undefined {
    return this.images.get(id);
  }

  /**
   * Get all stored images
   */
  getAllImages(): ImageAttachment[] {
    return Array.from(this.images.values());
  }

  /**
   * Remove an image from storage
   */
  async removeImage(id: string): Promise<boolean> {
    const image = this.images.get(id);
    if (!image) return false;

    try {
      await fs.promises.unlink(image.path);
      this.images.delete(id);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear all stored images
   */
  async clearAll(): Promise<void> {
    const promises = Array.from(this.images.values()).map(async (image) => {
      try {
        await fs.promises.unlink(image.path);
      } catch (error) {
        logWarn('Failed to clear stored image', { path: image.path, error });
      }
    });
    await Promise.all(promises);
    this.images.clear();
  }

  /**
   * Clean up temp directory on exit
   */
  async cleanup(): Promise<void> {
    await this.clearAll();
    try {
      await fs.promises.rmdir(this.tempDir);
    } catch {
      // Ignore cleanup errors
    }
  }

  static getExtensionFromMimeType(mimeType?: string): string | null {
    if (!mimeType) return null;
    const parts = mimeType.split('/');
    if (parts.length !== 2) return null;
    return parts[1].toLowerCase();
  }

  /**
   * Validate **compressed** image size for LLM usage.
   */
  static validateImageSize(sizeInBytes: number): boolean {
    return sizeInBytes <= MAX_LLM_IMAGE_SIZE_BYTES;
  }

  /**
   * Validate raw image size before attempting compression. This guards
   * against extremely large files that would be slow to process.
   */
  static validateRawImageSize(sizeInBytes: number): boolean {
    return sizeInBytes <= ImageStorageService.MAX_RAW_IMAGE_SIZE_BYTES;
  }

  /**
   * Get human-readable file size
   */
  static formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

// Lazy singleton instance
let imageStorageInstance: ImageStorageService | null = null;
let shutdownHookRegistered = false;

function ensureShutdownHookRegistered(): void {
  if (shutdownHookRegistered) {
    return;
  }
  shutdownHookRegistered = true;

  const shutdownCoordinator = getShutdownCoordinator();
  shutdownCoordinator.registerHook(
    'image-storage',
    async () => {
      if (imageStorageInstance) {
        await imageStorageInstance.cleanup();
      }
    },
    { priority: SHUTDOWN_HOOK_PRIORITY.ImageStorage }
  );
}

/**
 * Gets the singleton ImageStorageService instance.
 * Creates the instance and temp directories only when first accessed.
 */
export function getImageStorage(): ImageStorageService {
  if (!imageStorageInstance) {
    imageStorageInstance = new ImageStorageService();
  }
  ensureShutdownHookRegistered();
  return imageStorageInstance;
}

// Export the class for static methods
export { ImageStorageService };
