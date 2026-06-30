import path from 'node:path';

import mime from 'mime';

import { FileType } from '@/tools/executors/client/file-tools/enums';

/**
 * Detects the type of file based on extension and content.
 * @param filePath Path to the file.
 * @returns Promise that resolves to 'text', 'image', 'pdf', 'audio', 'video', 'binary' or 'svg'.
 */
export async function detectFileType(filePath: string): Promise<FileType> {
  const ext = path.extname(filePath).toLowerCase();

  // The mimetype for "ts" is MPEG transport stream (a video format) but we want
  // to assume these are typescript files instead.
  if (ext === '.ts') {
    return FileType.TEXT;
  }

  if (ext === '.svg') {
    return FileType.SVG;
  }

  const lookedUpMimeType = mime.getType(filePath); // Returns false if not found, or the mime type string
  if (lookedUpMimeType) {
    if (lookedUpMimeType.startsWith('image/')) {
      return FileType.IMAGE;
    }
    if (lookedUpMimeType.startsWith('audio/')) {
      return FileType.AUDIO;
    }
    if (lookedUpMimeType.startsWith('video/')) {
      return FileType.VIDEO;
    }
    if (lookedUpMimeType === 'application/pdf') {
      return FileType.PDF;
    }
  }

  // Stricter binary check for common non-text extensions before content check
  // These are often not well-covered by mime-types or might be misidentified.
  if (
    [
      '.zip',
      '.tar',
      '.gz',
      '.exe',
      '.dll',
      '.so',
      '.class',
      '.jar',
      '.war',
      '.7z',
      '.doc',
      '.docx',
      '.xls',
      '.xlsx',
      '.ppt',
      '.pptx',
      '.odt',
      '.ods',
      '.odp',
      '.bin',
      '.dat',
      '.obj',
      '.o',
      '.a',
      '.lib',
      '.wasm',
      '.pyc',
      '.pyo',
    ].includes(ext)
  ) {
    return FileType.BINARY;
  }

  return FileType.TEXT;
}
