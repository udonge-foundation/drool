/**
 * Cross-platform clipboard utilities for terminal applications
 */

import { spawn, execSync, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { SUPPORTED_IMAGE_TYPES } from '@industry/drool-core/tools/definitions/cli/constants';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { getI18n } from '@/i18n';
import { getImageStorage, ImageStorageService } from '@/services/imageStorage';
import {
  ClipboardImageInfo,
  ImageFileDetection,
  ImagePasteResult,
} from '@/types/types';
import { isWsl } from '@/utils/isWsl';
import {
  requestTerminalClipboardData,
  requestTerminalClipboardMimeList,
} from '@/utils/terminalClipboardProtocol';
import {
  withWindowsPowerShellFallback,
  withWindowsPowerShellFallbackSync,
} from '@/utils/windowsShell';

import type { exec as execType, execSync as execSyncType } from 'child_process';

type ExecAsyncOptions = Parameters<typeof execType>[1];
type ExecSyncOptions = Parameters<typeof execSyncType>[1];

const execAsync = promisify(exec);

const IMAGE_FILE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif',
  '.webp',
] as const;
const WINDOWS_DRIVE_PATH_REGEX = /^[a-zA-Z]:\\/;
const WINDOWS_UNC_PATH_REGEX = /^\\\\/;
const WAYLAND_CLIPBOARD_TOOL_MISSING_ERROR =
  'Image paste on Wayland requires wl-paste. Install wl-clipboard and try again.';

function isExecMaxBufferError(error: unknown): boolean {
  const maybeError = error as { code?: unknown; message?: unknown };
  return (
    maybeError.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
    (typeof maybeError.message === 'string' &&
      maybeError.message.includes('maxBuffer'))
  );
}

function isWaylandSession(): boolean {
  return (
    process.platform === 'linux' &&
    !isWsl() &&
    Boolean(process.env.WAYLAND_DISPLAY)
  );
}

function isCommandMissingError(error: unknown): boolean {
  const maybeError = error as { code?: unknown; stderr?: unknown };
  return (
    maybeError.code === 127 ||
    (typeof maybeError.stderr === 'string' &&
      maybeError.stderr.includes('not found')) ||
    (Buffer.isBuffer(maybeError.stderr) &&
      maybeError.stderr.toString('utf8').includes('not found'))
  );
}

function buildRawImageTooLargeError(): Error {
  return new Error(
    getI18n().t('common:clipboard.imageSizeExceeds', {
      size: `>${ImageStorageService.formatFileSize(
        ImageStorageService.MAX_RAW_IMAGE_SIZE_BYTES
      )}`,
    })
  );
}

async function execWindowsPowerShell(
  command: string,
  options: ExecAsyncOptions = {}
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  return withWindowsPowerShellFallback(
    (powershellPath) =>
      execAsync(command, {
        ...options,
        shell: powershellPath,
      }) as Promise<{ stdout: string | Buffer; stderr: string | Buffer }>
  );
}

function execWindowsPowerShellSync(
  command: string,
  options: ExecSyncOptions = {}
): string | Buffer {
  return withWindowsPowerShellFallbackSync((powershellPath) =>
    execSync(command, {
      ...options,
      shell: powershellPath,
    })
  );
}

/**
 * Gets the clipboard temp directory, ensuring it exists.
 * Uses ~/.industry/temp/clipboard instead of os.tmpdir() to avoid permission issues.
 */
function getClipboardTempDir(): string {
  const tempDir = path.join(
    getIndustryHome(),
    getIndustryDirName(),
    'temp',
    'clipboard'
  );

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  return tempDir;
}

function isWindowsPath(filePath: string): boolean {
  return (
    WINDOWS_DRIVE_PATH_REGEX.test(filePath) ||
    WINDOWS_UNC_PATH_REGEX.test(filePath)
  );
}

function cleanPastedFilePath(text: string): string {
  let cleanPath = text.trim().replace(/^['"]|['"]$/g, '');

  if (!cleanPath) {
    return '';
  }

  if (!isWindowsPath(cleanPath)) {
    cleanPath = cleanPath.replace(/\\(.)/g, '$1');
  }

  return cleanPath;
}

function hasImageExtension(filePath: string): boolean {
  const lowerPath = filePath.toLowerCase();
  for (const ext of IMAGE_FILE_EXTENSIONS) {
    if (lowerPath.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

function containsImageExtension(text: string): boolean {
  const lowerText = text.toLowerCase();
  return IMAGE_FILE_EXTENSIONS.some((ext) => lowerText.includes(ext));
}

function splitPastedFilePathTokens(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const char of text.trim()) {
    if (
      (char === ' ' || char === '\t' || char === '\n' || char === '\r') &&
      !quote &&
      !escaped
    ) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? undefined : char;
    }
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function getPastedFilePathCandidates(text: string): string[] {
  return splitPastedFilePathTokens(text)
    .map(cleanPastedFilePath)
    .filter(Boolean);
}

function looksLikeSingleImageFilePath(filePath: string): boolean {
  if (!filePath.startsWith('/') && !isWindowsPath(filePath)) {
    return false;
  }

  return hasImageExtension(filePath);
}

/**
 * Copy text via OSC 52 terminal escape sequence.
 * Works over SSH when the terminal emulator supports it (VSCode, iTerm2,
 * kitty, alacritty, WezTerm, Windows Terminal, Ghostty, etc.).
 * Returns true optimistically -- there is no ACK mechanism.
 */
function copyViaOsc52(text: string): boolean {
  try {
    if (!process.stdout.isTTY) {
      return false;
    }
    const encoded = Buffer.from(text).toString('base64');
    process.stdout.write(`\x1b]52;c;${encoded}\x07`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy text to clipboard using system commands
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const platform = process.platform;

    if (platform === 'darwin') {
      const child = spawn('pbcopy');
      child.stdin.write(text);
      child.stdin.end();

      return new Promise((resolve) => {
        child.on('close', (code) => {
          resolve(code === 0);
        });
        child.on('error', () => {
          resolve(false);
        });
      });
    }
    if (platform === 'win32' || isWsl()) {
      const child = spawn('clip.exe');
      child.stdin.write(text);
      child.stdin.end();

      return new Promise((resolve) => {
        child.on('close', (code) => {
          resolve(code === 0);
        });
        child.on('error', () => {
          resolve(false);
        });
      });
    }
    // Linux (non-WSL) - try xclip, then xsel, then OSC 52
    const tryXselThenOsc52 = (resolve: (value: boolean) => void): void => {
      try {
        const xselChild = spawn('xsel', ['--clipboard', '--input']);
        xselChild.stdin.write(text);
        xselChild.stdin.end();
        xselChild.on('close', (xselCode) => {
          if (xselCode === 0) {
            resolve(true);
            return;
          }
          resolve(copyViaOsc52(text));
        });
        xselChild.on('error', () => {
          resolve(copyViaOsc52(text));
        });
      } catch {
        resolve(copyViaOsc52(text));
      }
    };

    try {
      const child = spawn('xclip', ['-selection', 'clipboard']);
      child.stdin.write(text);
      child.stdin.end();

      return new Promise((resolve) => {
        child.on('close', (code) => {
          if (code === 0) {
            resolve(true);
            return;
          }
          tryXselThenOsc52(resolve);
        });
        child.on('error', () => {
          tryXselThenOsc52(resolve);
        });
      });
    } catch {
      return copyViaOsc52(text);
    }
  } catch {
    return false;
  }
}

/**
 * Read text from clipboard using system commands
 */
export async function readFromClipboard(): Promise<string | null> {
  try {
    const platform = process.platform;

    if (platform === 'darwin') {
      const result = execSync('pbpaste', { encoding: 'utf8' });
      return result;
    }
    if (platform === 'win32' || isWsl()) {
      const result = execWindowsPowerShellSync('Get-Clipboard', {
        encoding: 'utf8',
      });
      return result.toString().trim();
    }
    // Linux (non-WSL) - try xclip first, then xsel, then OSC 5522 terminal
    // clipboard protocol as a final fallback so text paste degrades
    // gracefully over SSH and on Wayland.
    //
    // IMPORTANT: use `execAsync` (not `execSync`) for xclip/xsel on Linux.
    // Node's `execSync` default stdio is `['pipe','pipe','inherit']`, so the
    // child's stderr is written straight to the user's TTY before we ever
    // reach our `catch` block. That is exactly how "Error: Can't open
    // display" / "xsel: Can't open display" leak into the user's chat over
    // SSH. `execAsync` pipes stderr and surfaces it only on the rejected
    // error object, which we intentionally discard.
    try {
      const { stdout } = await execAsync('xclip -selection clipboard -o', {
        encoding: 'utf8',
      });
      return String(stdout);
    } catch {
      try {
        const { stdout } = await execAsync('xsel --clipboard --output', {
          encoding: 'utf8',
        });
        return String(stdout);
      } catch {
        const terminalText = await requestTerminalClipboardData('text/plain');
        if (terminalText && terminalText.length > 0) {
          return terminalText.toString('utf8');
        }
        return null;
      }
    }
  } catch {
    return null;
  }
}

/**
 * Map a blob of MIME-type text to the image format Drool recognises. Used by
 * wl-paste, xclip TARGETS, and the OSC 5522 MIME-list fallback.
 */
function imageFormatFromTargets(blob: string): 'png' | 'jpeg' | 'gif' | null {
  if (blob.includes('image/png')) return 'png';
  if (blob.includes('image/jpeg')) return 'jpeg';
  if (blob.includes('image/gif')) return 'gif';
  // Some terminals report only the generic `image/*` family.
  if (blob.includes('image/')) return 'png';
  return null;
}

/**
 * Linux-specific image clipboard probe with injectable dependencies so tests
 * can exercise backend fallback deterministically without relying on host
 * clipboard tooling.
 */
export async function checkClipboardForImageOnLinux(
  deps: {
    execCommand?: (cmd: string) => Promise<{ stdout: string }>;
    readTerminalMimeTypes?: () => Promise<string[]>;
  } = {}
): Promise<ClipboardImageInfo> {
  const execCommand =
    deps.execCommand ??
    (async (cmd: string) => {
      const { stdout } = await execAsync(cmd);
      return { stdout: stdout.toString() };
    });
  const readTerminalMimeTypes =
    deps.readTerminalMimeTypes ?? requestTerminalClipboardMimeList;
  let missingWaylandClipboardTool = false;

  try {
    const { stdout } = await execCommand('wl-paste --list-types');
    const format = imageFormatFromTargets(stdout);
    if (format) return { hasImage: true, format };
  } catch (error) {
    missingWaylandClipboardTool =
      isWaylandSession() && isCommandMissingError(error);
    // Try X11 and terminal protocol fallbacks below.
  }

  try {
    const { stdout } = await execCommand(
      'xclip -selection clipboard -t TARGETS -o'
    );
    const format = imageFormatFromTargets(stdout);
    if (format) return { hasImage: true, format };
  } catch {
    // Fall through to OSC 5522 fallback below.
  }

  const format = imageFormatFromTargets(
    (await readTerminalMimeTypes()).join('\n')
  );
  if (format) return { hasImage: true, format };
  return missingWaylandClipboardTool
    ? { hasImage: false, error: WAYLAND_CLIPBOARD_TOOL_MISSING_ERROR }
    : { hasImage: false };
}

/**
 * Check if clipboard contains an image
 */
export async function checkClipboardForImage(): Promise<ClipboardImageInfo> {
  try {
    const platform = process.platform;

    if (platform === 'darwin') {
      // macOS - use osascript to check clipboard type
      try {
        const { stdout } = await execAsync(
          'osascript -e "clipboard info" 2>/dev/null'
        );

        // Check for various image formats
        const hasImage = /«class (PNG|JPEG|TIFF|GIF)/.test(stdout);
        if (hasImage) {
          // Try to determine format
          if (stdout.includes('PNGf')) return { hasImage: true, format: 'png' };
          if (stdout.includes('JPEG'))
            return { hasImage: true, format: 'jpeg' };
          if (stdout.includes('TIFF'))
            return { hasImage: true, format: 'tiff' };
          if (stdout.includes('GIFf')) return { hasImage: true, format: 'gif' };
          return { hasImage: true, format: 'png' }; // Default to PNG
        }
      } catch {
        // Fall back to checking with file command
        try {
          await execAsync(
            `osascript -e 'try' -e 'set the_data to the clipboard as «class PNGf»' -e 'end try' 2>/dev/null`
          );
          return { hasImage: true, format: 'png' };
        } catch {
          return { hasImage: false };
        }
      }
    }

    if (platform === 'win32' || isWsl()) {
      try {
        const checkScript = `
          Add-Type -AssemblyName System.Windows.Forms
          $clip = [System.Windows.Forms.Clipboard]::GetDataObject()
          if ($clip.GetDataPresent([System.Windows.Forms.DataFormats]::Bitmap)) {
            $img = [System.Windows.Forms.Clipboard]::GetImage()
            if ($img) {
              $format = $img.RawFormat.Guid
              if ($format -eq [System.Drawing.Imaging.ImageFormat]::Png.Guid) {
                Write-Output "png"
              } elseif ($format -eq [System.Drawing.Imaging.ImageFormat]::Jpeg.Guid) {
                Write-Output "jpeg"
              } elseif ($format -eq [System.Drawing.Imaging.ImageFormat]::Gif.Guid) {
                Write-Output "gif"
              } elseif ($format -eq [System.Drawing.Imaging.ImageFormat]::Bmp.Guid) {
                Write-Output "bmp"
              } else {
                Write-Output "image"
              }
            } else {
              Write-Output "false"
            }
          } else {
            Write-Output "false"
          }
        `.replace(/\n/g, ' ');

        const { stdout } = await execWindowsPowerShell(checkScript);
        const result = stdout.toString().trim();

        if (result === 'false') {
          return { hasImage: false };
        }
        if (result === 'image') {
          return { hasImage: true, format: 'png' };
        }
        return {
          hasImage: true,
          format: result as 'png' | 'jpeg' | 'gif' | 'bmp',
        };
      } catch {
        try {
          const { stdout } = await execWindowsPowerShell(
            'Get-Clipboard -Format Image'
          );
          return {
            hasImage: stdout.toString().trim().length > 0,
            format: 'png',
          };
        } catch {
          return { hasImage: false };
        }
      }
    }

    // Linux (non-WSL) - try Wayland first, then X11, then OSC 5522 (the
    // Kitty/Ghostty terminal clipboard protocol).
    return await checkClipboardForImageOnLinux();
  } catch {
    return { hasImage: false };
  }
}

/**
 * Linux-specific image clipboard read with injectable dependencies. Tries
 * Wayland first, then X11, then OSC 5522 terminal clipboard protocol.
 */
export async function readLinuxClipboardImageBytes(
  deps: {
    execBuffer?: (
      cmd: string,
      options: { maxBuffer: number }
    ) => Promise<{ stdout: Buffer } | { stdout: string }>;
    readTerminalMimeTypes?: () => Promise<string[]>;
    readTerminalData?: (mime: string) => Promise<Buffer | null>;
  } = {}
): Promise<{ data: Buffer; mimeType: string } | null> {
  const execBuffer =
    deps.execBuffer ??
    (async (cmd: string, options: { maxBuffer: number }) => {
      const { stdout } = await execAsync(cmd, {
        encoding: 'buffer',
        maxBuffer: options.maxBuffer,
      });
      return { stdout: stdout as unknown as Buffer };
    });
  const readTerminalMimeTypes =
    deps.readTerminalMimeTypes ?? requestTerminalClipboardMimeList;
  const readTerminalData =
    deps.readTerminalData ?? requestTerminalClipboardData;

  for (const mimeType of ['image/png', 'image/jpeg'] as const) {
    try {
      const { stdout } = await execBuffer(`wl-paste --type ${mimeType}`, {
        maxBuffer: ImageStorageService.MAX_RAW_IMAGE_SIZE_BYTES,
      });
      const data =
        stdout instanceof Buffer
          ? stdout
          : Buffer.from(String(stdout), 'binary');
      if (data.length > 0) return { data, mimeType };
    } catch (error) {
      if (isExecMaxBufferError(error)) {
        throw buildRawImageTooLargeError();
      }
      // Try the next backend for this MIME.
    }

    try {
      const { stdout } = await execBuffer(
        `xclip -selection clipboard -t ${mimeType} -o`,
        { maxBuffer: ImageStorageService.MAX_RAW_IMAGE_SIZE_BYTES }
      );
      const data =
        stdout instanceof Buffer
          ? stdout
          : Buffer.from(String(stdout), 'binary');
      if (data.length > 0) return { data, mimeType };
    } catch (error) {
      if (isExecMaxBufferError(error)) {
        throw buildRawImageTooLargeError();
      }
      // Try the next MIME, then fall through to the terminal protocol.
    }
  }

  const terminalMimeTypes = await readTerminalMimeTypes();
  const preferredMime =
    terminalMimeTypes.find((mime) => mime === 'image/png') ||
    terminalMimeTypes.find((mime) => mime === 'image/jpeg') ||
    terminalMimeTypes.find((mime) => mime.startsWith('image/'));
  if (!preferredMime) return null;
  const terminalData = await readTerminalData(preferredMime);
  if (terminalData && terminalData.length > 0) {
    return { data: terminalData, mimeType: preferredMime };
  }
  return null;
}

/**
 * Paste image from clipboard
 */
export async function pasteImageFromClipboard(): Promise<ImagePasteResult> {
  try {
    const platform = process.platform;
    let imageData: Buffer | null = null;
    let mimeType = 'image/png';

    if (platform === 'darwin') {
      // macOS - use pngpaste if available
      const tempFile = path.join(
        getClipboardTempDir(),
        `clipboard-${Date.now()}.png`
      );

      try {
        // First try pngpaste (more reliable for clipboard images)
        try {
          await execAsync(`pngpaste "${tempFile}"`);
          imageData = await fs.promises.readFile(tempFile);
          mimeType = 'image/png';

          try {
            await fs.promises.unlink(tempFile);
          } catch {
            // Ignore cleanup errors
          }
        } catch {
          // Fallback to osascript - try reading in original format first
          await new Promise((resolve) => {
            setTimeout(resolve, 50);
          });

          // Check what formats are available in clipboard
          const infoResult = await execAsync(`osascript -e 'clipboard info'`);

          let format = 'PNGf'; // default
          let extension = 'png';

          if (infoResult.stdout.includes('JPEG')) {
            format = 'JPEG';
            extension = 'jpg';
            mimeType = 'image/jpeg';
          } else if (infoResult.stdout.includes('TIFF')) {
            format = 'TIFF';
            extension = 'tiff';
            mimeType = 'image/tiff';
          }

          const formatTempFile = path.join(
            getClipboardTempDir(),
            `clipboard-${Date.now()}.${extension}`
          );

          const script = `
            set img_data to the clipboard as «class ${format}»
            set the_file to open for access POSIX file "${formatTempFile}" with write permission
            write img_data to the_file
            close access the_file
          `;

          await execAsync(`osascript -e '${script.replace(/\n/g, "' -e '")}'`);

          // Read the file
          imageData = await fs.promises.readFile(formatTempFile);

          // Clean up temp file
          try {
            await fs.promises.unlink(formatTempFile);
          } catch {
            // Ignore cleanup errors
          }
        }
      } catch {
        // Try TIFF format as fallback
        try {
          const tiffScript = `
            set tiff_data to the clipboard as TIFF picture
            set the_file to open for access POSIX file "${tempFile}" with write permission
            write tiff_data to the_file
            close access the_file
          `;

          await execAsync(
            `osascript -e '${tiffScript.replace(/\n/g, "' -e '")}'`
          );
          imageData = await fs.promises.readFile(tempFile);
          mimeType = 'image/tiff';

          try {
            await fs.promises.unlink(tempFile);
          } catch {
            // Ignore cleanup errors
          }
        } catch {
          return {
            success: false,
            error: getI18n().t('common:clipboard.failedToExtract'),
          };
        }
      }
    } else if (platform === 'win32') {
      // Windows - Enhanced PowerShell implementation with multiple format support
      try {
        // Generate unique temp file name
        const timestamp = Date.now();
        const tempDir = getClipboardTempDir();

        // PowerShell script that handles multiple image formats
        const saveScript = `
          Add-Type -AssemblyName System.Windows.Forms
          Add-Type -AssemblyName System.Drawing
          
          try {
            $clip = [System.Windows.Forms.Clipboard]::GetDataObject()
            
            if ($clip.GetDataPresent([System.Windows.Forms.DataFormats]::Bitmap)) {
              $img = [System.Windows.Forms.Clipboard]::GetImage()
              
              if ($img) {
                # Determine the best format to save
                $format = $img.RawFormat.Guid
                $extension = "png"
                $imgFormat = [System.Drawing.Imaging.ImageFormat]::Png
                
                if ($format -eq [System.Drawing.Imaging.ImageFormat]::Jpeg.Guid) {
                  $extension = "jpg"
                  $imgFormat = [System.Drawing.Imaging.ImageFormat]::Jpeg
                } elseif ($format -eq [System.Drawing.Imaging.ImageFormat]::Gif.Guid) {
                  $extension = "gif"
                  $imgFormat = [System.Drawing.Imaging.ImageFormat]::Gif
                } elseif ($format -eq [System.Drawing.Imaging.ImageFormat]::Bmp.Guid) {
                  # Convert BMP to PNG for better compression
                  $extension = "png"
                  $imgFormat = [System.Drawing.Imaging.ImageFormat]::Png
                }
                
                $filePath = "${tempDir}\\clipboard-${timestamp}.$extension"
                
                # Save with appropriate format
                $img.Save($filePath, $imgFormat)
                
                # Output the saved file path and format
                Write-Output "$filePath|$extension"
                
                # Clean up
                $img.Dispose()
                exit 0
              } else {
                Write-Error "No image found"
                exit 1
              }
            } elseif ($clip.GetDataPresent("PNG") -or $clip.GetDataPresent("DeviceIndependentBitmap")) {
              # Handle other image data formats
              $data = $clip.GetData("DeviceIndependentBitmap")
              if ($data) {
                # Convert DIB to image
                $stream = [System.IO.MemoryStream]::new($data)
                $img = [System.Drawing.Image]::FromStream($stream)
                $filePath = "${tempDir}\\clipboard-${timestamp}.png"
                $img.Save($filePath, [System.Drawing.Imaging.ImageFormat]::Png)
                Write-Output "$filePath|png"
                $img.Dispose()
                $stream.Dispose()
                exit 0
              } else {
                Write-Error "Could not retrieve image data"
                exit 1
              }
            } else {
              Write-Error "No image in clipboard"
              exit 1
            }
          } catch {
            Write-Error $_.Exception.Message
            exit 1
          }
        `
          .replace(/\n/g, ' ')
          .replace(/\s+/g, ' ');

        const { stdout, stderr } = await execWindowsPowerShell(saveScript, {
          encoding: 'utf8',
        });

        if (stderr && stderr.includes('No image')) {
          return {
            success: false,
            error: getI18n().t('common:clipboard.noImageFound'),
          };
        }

        // Parse the output to get file path and format
        const output = stdout.toString().trim();
        const [filePath, format] = output.split('|');

        if (!filePath || !fs.existsSync(filePath)) {
          return {
            success: false,
            error: getI18n().t('common:clipboard.failedToSave'),
          };
        }

        // Read the saved image
        imageData = await fs.promises.readFile(filePath);

        // Set appropriate MIME type
        switch (format) {
          case 'jpg':
          case 'jpeg':
            mimeType = 'image/jpeg';
            break;
          case 'gif':
            mimeType = 'image/gif';
            break;
          case 'bmp':
            mimeType = 'image/bmp';
            break;
          default:
            mimeType = 'image/png';
        }

        // Clean up temp file
        try {
          await fs.promises.unlink(filePath);
        } catch {
          // Ignore cleanup errors
        }
      } catch (_error) {
        // Fallback to simpler implementation if the enhanced version fails
        try {
          const tempFile = path.join(
            getClipboardTempDir(),
            `clipboard-${Date.now()}.png`
          );
          await execWindowsPowerShell(
            `$img = Get-Clipboard -Format Image; if($img) { $img.Save('${tempFile}'); Write-Output 'OK' } else { Write-Error 'No image' }`
          );

          if (fs.existsSync(tempFile)) {
            imageData = await fs.promises.readFile(tempFile);
            mimeType = 'image/png';

            try {
              await fs.promises.unlink(tempFile);
            } catch {
              // Ignore cleanup errors
            }
          } else {
            return {
              success: false,
              error: getI18n().t('common:clipboard.noImageFound'),
            };
          }
        } catch {
          return {
            success: false,
            error: getI18n().t('common:clipboard.failedToExtractCopy'),
          };
        }
      }
    } else {
      // Linux - try native clipboard tools first, then OSC 5522 terminal
      // clipboard protocol for SSH / terminal-mediated reads.
      const linuxResult = await readLinuxClipboardImageBytes();
      if (!linuxResult) {
        return {
          success: false,
          error: getI18n().t('common:clipboard.failedToExtract'),
        };
      }
      imageData = linuxResult.data;
      mimeType = linuxResult.mimeType;
    }

    if (!imageData) {
      return {
        success: false,
        error: getI18n().t('common:clipboard.noImageData'),
      };
    }

    // Only a restricted set of image types are supported for chat attachments
    if (
      !SUPPORTED_IMAGE_TYPES.includes(
        mimeType as (typeof SUPPORTED_IMAGE_TYPES)[number]
      )
    ) {
      return {
        success: false,
        error: getI18n().t('common:clipboard.unsupportedFormat', {
          mimeType,
          supported: SUPPORTED_IMAGE_TYPES.join(', '),
        }),
      };
    }

    // Validate raw image size before compression (guard against huge files)
    if (!ImageStorageService.validateRawImageSize(imageData.length)) {
      return {
        success: false,
        error: getI18n().t('common:clipboard.imageSizeExceeds', {
          size: ImageStorageService.formatFileSize(imageData.length),
        }),
      };
    }

    // Save image to storage
    const image = await getImageStorage().saveImage(
      imageData,
      undefined,
      mimeType
    );

    return {
      success: true,
      image,
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : getI18n().t('common:clipboard.unknownError'),
    };
  }
}

/**
 * Quick synchronous check if text looks like an image file path
 * Does not verify file existence - use detectImageFilePath for full validation
 */
export function looksLikeImageFilePath(text: string): boolean {
  if (!containsImageExtension(text)) {
    return false;
  }

  const cleanPath = cleanPastedFilePath(text);
  if (cleanPath && looksLikeSingleImageFilePath(cleanPath)) {
    return true;
  }

  const candidates = getPastedFilePathCandidates(text);
  if (candidates.length === 0) {
    return false;
  }

  return candidates.every(looksLikeSingleImageFilePath);
}

/**
 * Detect if a text string is a valid image file path
 * Performs full validation including file existence and size
 */
export async function detectImageFilePath(
  text: string
): Promise<ImageFileDetection> {
  const cleanPath = cleanPastedFilePath(text);

  if (!cleanPath) {
    return { isImageFile: false };
  }

  if (!hasImageExtension(cleanPath)) {
    return { isImageFile: false };
  }

  // Check file exists and is accessible
  try {
    const stats = await fs.promises.stat(cleanPath);
    if (!stats.isFile()) {
      return {
        isImageFile: false,
        error: getI18n().t('common:clipboard.notAFile'),
      };
    }

    // Restrict supported formats for attachments to JPEG and PNG
    const ext = path.extname(cleanPath).toLowerCase();
    const isSupportedExt = ext === '.png' || ext === '.jpg' || ext === '.jpeg';
    if (!isSupportedExt) {
      return {
        isImageFile: true,
        path: cleanPath,
        error: getI18n().t('common:clipboard.unsupportedImageFormat'),
      };
    }

    // 5. Check raw file size (20MB limit before compression)
    if (!ImageStorageService.validateRawImageSize(stats.size)) {
      return {
        isImageFile: false,
        error: getI18n().t('common:clipboard.imageSizeExceeds', {
          size: ImageStorageService.formatFileSize(stats.size),
        }),
      };
    }

    return { isImageFile: true, path: cleanPath };
  } catch {
    // File doesn't exist or not accessible
    return { isImageFile: false };
  }
}

/**
 * Detect if pasted text contains one or more valid image file paths.
 */
export async function detectImageFilePaths(
  text: string
): Promise<ImageFileDetection[]> {
  if (!containsImageExtension(text)) {
    return [{ isImageFile: false }];
  }

  const candidates = getPastedFilePathCandidates(text);

  if (candidates.length === 0) {
    return [{ isImageFile: false }];
  }

  if (candidates.length > 1) {
    if (candidates.every(looksLikeSingleImageFilePath)) {
      return Promise.all(
        candidates.map((candidate) => detectImageFilePath(candidate))
      );
    }

    const cleanPath = cleanPastedFilePath(text);
    if (!looksLikeSingleImageFilePath(cleanPath)) {
      return [{ isImageFile: false }];
    }
  }

  return [await detectImageFilePath(text)];
}

/**
 * Load an image from a file path
 */
export async function loadImageFromFile(
  filePath: string
): Promise<ImagePasteResult> {
  try {
    const imageData = await fs.promises.readFile(filePath);

    // Determine MIME type from extension
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;

    // Use existing imageStorage service
    const image = await getImageStorage().saveImage(
      imageData,
      path.basename(filePath),
      mimeType
    );

    return { success: true, image };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : getI18n().t('common:clipboard.failedToLoadImage'),
    };
  }
}
