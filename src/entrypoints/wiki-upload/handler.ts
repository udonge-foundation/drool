import { execFile } from 'child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { join, relative, basename, extname } from 'path';
import { promisify } from 'util';

import {
  WIKI_MAX_IMAGE_COUNT,
  WIKI_MAX_IMAGE_SIZE,
  WIKI_MAX_TOTAL_IMAGES_SIZE,
  WIKI_VIDEO_CAPTION_CONTENT_TYPE,
  WIKI_VIDEO_CAPTION_MAX_BYTES,
  WIKI_VIDEO_CONTENT_TYPE,
  WIKI_VIDEO_MAX_BYTES,
} from '@industry/common/api/v0/wiki';
import { MetaError } from '@industry/logging/errors';

import { getAuthHeadersOrThrow } from '@/api/config';
import { fetchBackend } from '@/api/fetchBackend';
import { getAuthErrorMessage } from '@/commands/authHelpers';
import {
  isNetworkErrorMessage,
  writeStderr,
  writeStdout,
} from '@/entrypoints/wiki-shared/wiki-utils';
import {
  deriveWikiGitUrl,
  syncToGitHubWiki,
} from '@/entrypoints/wiki-upload/wiki-github-sync';
import { getEnv } from '@/environment';
import { getI18n } from '@/i18n';

import type {
  CreateWikiRunRequest,
  GetWikiRunResponse,
  WikiImage,
  WikiSupportedImageType,
  WikiVideoOverviewMetadata,
  WikiVideoUploadUrlRequest,
  WikiVideoUploadUrlResponse,
} from '@industry/common/api/v0/wiki';
import type { PageTreeNode, WikiPage } from '@industry/common/wiki';

const execFileAsync = promisify(execFile);

async function fetchPresignedUrl(
  url: string,
  init: RequestInit
): Promise<Response> {
  return globalThis.fetch(url, init);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UploadTarget = 'industry' | 'github';

interface WikiUploadOptions {
  sessionId?: string;
  repoUrl: string;
  wikiDir: string;
  cleanup?: boolean;
  check?: boolean;
  uploadTo?: string;
  /**
   * When set, reuses the video overview from a prior wiki run instead of
   * uploading a new video. The CLI sends `copyFromWikiRunId` to the backend
   * `POST /api/v0/wiki` endpoint, which resolves and re-references the prior
   * run's S3 object server-side. No S3 PUT is issued by the CLI.
   */
  copyFromWikiRunId?: string;
}

interface WikiMetaFile {
  pageOrder?: string[];
}

// ---------------------------------------------------------------------------
// File & tree utilities
// ---------------------------------------------------------------------------

/**
 * Recursively finds files matching a set of extensions in a directory.
 * Returns sorted relative paths (forward-slash normalized) from the base directory.
 */
function findFilesByExtension(
  dir: string,
  extensions: Set<string>,
  baseDir?: string
): string[] {
  const base = baseDir ?? dir;
  const results: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      results.push(...findFilesByExtension(fullPath, extensions, base));
    } else if (stat.isFile()) {
      const ext = extname(entry).toLowerCase();
      if (extensions.has(ext)) {
        results.push(relative(base, fullPath).replaceAll('\\', '/'));
      }
    }
  }

  return results.sort();
}

const MD_EXTENSIONS = new Set(['.md']);

/**
 * Recursively finds all .md files in a directory.
 * Returns relative paths from the base directory.
 */
export function findMarkdownFiles(dir: string, baseDir?: string): string[] {
  return findFilesByExtension(dir, MD_EXTENSIONS, baseDir);
}

/**
 * Extracts the title from the first # heading in a markdown file.
 * Falls back to the filename (without extension) if no heading is found.
 */
export function extractTitle(content: string, filePath: string): string {
  // Match the first # heading (only level 1)
  const match = content.match(/^#\s+(.+)$/m);
  if (match) {
    return match[1].trim();
  }
  // Fallback: use filename without extension
  const name = basename(filePath, extname(filePath));
  return name;
}

/**
 * Generates a URL-safe page ID from a file path.
 * Replaces / with --, strips .md extension, and handles special characters.
 */
export function generatePageId(filePath: string): string {
  return filePath
    .replace(/\.md$/i, '') // Strip .md extension
    .replace(/\//g, '--') // Replace / with --
    .replace(/[^a-zA-Z0-9_-]/g, '_'); // Replace special chars with _
}

/**
 * Builds a hierarchical PageTreeNode[] from a list of markdown file paths.
 * Files at the root level become top-level nodes.
 * Files in directories become nested under directory nodes.
 */
export function buildPageTree(
  files: string[],
  wikiDir: string,
  pageOrder?: string[]
): { pages: WikiPage[]; pageTree: PageTreeNode[] } {
  const pages: WikiPage[] = [];
  const orderIndex = new Map<string, number>();

  (pageOrder ?? []).forEach((path, index) => {
    const normalizedPath = path.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!orderIndex.has(normalizedPath)) {
      orderIndex.set(normalizedPath, index);
    }
  });

  const getRank = (path: string): number => orderIndex.get(path) ?? Infinity;

  // Group files by directory
  const dirMap = new Map<string, string[]>();
  const rootFiles: string[] = [];

  for (const file of files) {
    const parts = file.split('/');
    if (parts.length === 1) {
      rootFiles.push(file);
    } else {
      const dir = parts[0];
      if (!dirMap.has(dir)) {
        dirMap.set(dir, []);
      }
      dirMap.get(dir)!.push(file);
    }
  }

  // Build tree recursively
  function buildNodes(filePaths: string[], parentPath: string): PageTreeNode[] {
    // Group into direct files and subdirectories
    const directFiles: string[] = [];
    const subDirMap = new Map<string, string[]>();

    for (const fp of filePaths) {
      const rel = parentPath ? fp.slice(parentPath.length + 1) : fp;
      const parts = rel.split('/');
      if (parts.length === 1) {
        directFiles.push(fp);
      } else {
        const dir = parts[0];
        const subKey = parentPath ? `${parentPath}/${dir}` : dir;
        if (!subDirMap.has(subKey)) {
          subDirMap.set(subKey, []);
        }
        subDirMap.get(subKey)!.push(fp);
      }
    }

    // Build a unified list of entries (files and directories) with ranks
    // so they can be sorted together instead of files-first then directories.
    type Entry =
      | { kind: 'file'; path: string; rank: number }
      | { kind: 'dir'; key: string; files: string[]; rank: number };

    const entries: Entry[] = [];

    for (const fp of directFiles) {
      entries.push({ kind: 'file', path: fp, rank: getRank(fp) });
    }

    for (const [dirKey, dirFiles] of subDirMap) {
      const dirRank =
        dirFiles.length > 0
          ? Math.min(...dirFiles.map((file) => getRank(file)))
          : Infinity;
      entries.push({
        kind: 'dir',
        key: dirKey,
        files: dirFiles,
        rank: dirRank,
      });
    }

    entries.sort((a, b) => {
      const rankDiff = a.rank - b.rank;
      if (rankDiff !== 0) return rankDiff;
      const aName = a.kind === 'file' ? a.path : a.key;
      const bName = b.kind === 'file' ? b.path : b.key;
      return aName.localeCompare(bName);
    });

    const nodes: PageTreeNode[] = [];
    let order = 0;

    for (const entry of entries) {
      if (entry.kind === 'file') {
        const fullPath = join(wikiDir, entry.path);
        const content = readFileSync(fullPath, 'utf-8');
        const pageId = generatePageId(entry.path);
        const title = extractTitle(content, entry.path);

        pages.push({
          pageId,
          path: entry.path,
          title,
          content,
          order,
        });

        nodes.push({
          pageId,
          title,
          path: entry.path,
          order,
          children: [],
        });
      } else {
        const children = buildNodes(entry.files, entry.key);
        const dirName = entry.key.split('/').pop() ?? entry.key;
        const indexFile = entry.files.find((f) => {
          const rel = f.slice(entry.key.length + 1);
          return rel.toLowerCase() === 'index.md';
        });

        if (indexFile) {
          const indexNode = children.find(
            (c) =>
              c.path.toLowerCase().endsWith('/index.md') ||
              c.path.toLowerCase() === 'index.md'
          );
          if (indexNode) {
            indexNode.children = children.filter((c) => c !== indexNode);
            indexNode.order = order;
            nodes.push(indexNode);
          } else {
            nodes.push({
              pageId: generatePageId(`${entry.key}/index`),
              title: dirName,
              path: entry.key,
              order,
              children,
            });
          }
        } else {
          nodes.push({
            pageId: generatePageId(entry.key),
            title: dirName,
            path: entry.key,
            order,
            children,
          });
        }
      }

      order++;
    }

    return nodes;
  }

  // Build root nodes: first direct files, then directories
  const allFiles = [...rootFiles];
  for (const dirFiles of dirMap.values()) {
    allFiles.push(...dirFiles);
  }

  const pageTree = buildNodes(allFiles, '');

  return { pages, pageTree };
}

function readPageOrderFromWikiMeta(wikiDir: string): string[] | undefined {
  const metaPath = join(wikiDir, '.wiki-meta.json');
  if (!existsSync(metaPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf-8')) as WikiMetaFile;
    if (!Array.isArray(parsed.pageOrder)) {
      return undefined;
    }

    return parsed.pageOrder.filter(
      (value): value is string => typeof value === 'string'
    );
  } catch {
    writeStderr(getI18n().t('commands:wikiUpload.wikiMetaParseWarning'));
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Git metadata
// ---------------------------------------------------------------------------

/**
 * Resolves git metadata from the current working directory.
 */
export async function resolveGitMetadata(): Promise<{
  commitHash: string;
  branch: string;
  hasLocalChanges: boolean;
  hasNonRemoteCommits: boolean;
}> {
  const execGit = async (...args: string[]): Promise<string> => {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: process.cwd(),
        timeout: 10_000,
      });
      return stdout.trim();
    } catch {
      return '';
    }
  };

  const commitHash = await execGit('rev-parse', 'HEAD');
  const branch = await execGit('rev-parse', '--abbrev-ref', 'HEAD');

  const statusOutput = await execGit('status', '--porcelain');
  const hasLocalChanges = statusOutput.length > 0;

  let hasNonRemoteCommits = false;
  try {
    const count = await execGit('rev-list', '@{u}..HEAD', '--count');
    hasNonRemoteCommits = parseInt(count, 10) > 0;
  } catch {
    // No upstream branch configured; treat as having non-remote commits
    hasNonRemoteCommits = false;
  }

  return {
    commitHash: commitHash || 'unknown',
    branch: branch || 'unknown',
    hasLocalChanges,
    hasNonRemoteCommits,
  };
}

// ---------------------------------------------------------------------------
// Image detection & encoding
// ---------------------------------------------------------------------------

/** Map of file extensions to MIME types for supported wiki images */
const EXTENSION_TO_MIME: Record<string, WikiSupportedImageType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Set of supported image extensions (lowercase, including leading dot) */
const SUPPORTED_IMAGE_EXTENSIONS = new Set(Object.keys(EXTENSION_TO_MIME));

/**
 * Discovers image files with supported extensions in a wiki directory.
 * Searches the root directory and all subdirectories (including images/).
 * Returns relative paths from the wiki directory root, sorted alphabetically.
 */
export function findImageFiles(wikiDir: string, baseDir?: string): string[] {
  return findFilesByExtension(wikiDir, SUPPORTED_IMAGE_EXTENSIONS, baseDir);
}

/**
 * Infers the MIME content type from a file extension.
 * Returns undefined for unsupported extensions.
 */
export function inferContentType(
  filePath: string
): WikiSupportedImageType | undefined {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_TO_MIME[ext];
}

/**
 * Reads image files, base64-encodes their content, and builds a WikiImage[]
 * payload. Enforces per-file and total size limits:
 *
 * - Files exceeding WIKI_MAX_IMAGE_SIZE are skipped with a stderr warning.
 * - Once the running total exceeds WIKI_MAX_TOTAL_IMAGES_SIZE, remaining files
 *   are skipped with a stderr warning.
 */
export function prepareImagePayload(
  wikiDir: string,
  imagePaths: string[]
): WikiImage[] {
  const images: WikiImage[] = [];
  let totalSize = 0;

  for (const imgPath of imagePaths) {
    const fullPath = join(wikiDir, imgPath);

    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    const sizeBytes = stat.size;

    // Skip oversized individual files
    if (sizeBytes > WIKI_MAX_IMAGE_SIZE) {
      writeStderr(
        `Warning: Skipping image '${imgPath}' (${sizeBytes} bytes) — exceeds per-file limit of ${WIKI_MAX_IMAGE_SIZE} bytes (5MB).`
      );
      continue;
    }

    // Check total size limit
    if (totalSize + sizeBytes > WIKI_MAX_TOTAL_IMAGES_SIZE) {
      writeStderr(
        `Warning: Skipping image '${imgPath}' and remaining images — total size would exceed ${WIKI_MAX_TOTAL_IMAGES_SIZE} bytes (50MB).`
      );
      break;
    }

    const contentType = inferContentType(imgPath);
    if (!contentType) {
      continue;
    }

    // Enforce image count limit
    if (images.length >= WIKI_MAX_IMAGE_COUNT) {
      writeStderr(
        `Warning: Skipping image '${imgPath}' and remaining images — would exceed limit of ${WIKI_MAX_IMAGE_COUNT} images.`
      );
      break;
    }

    const data = readFileSync(fullPath).toString('base64');
    totalSize += sizeBytes;

    images.push({
      path: imgPath,
      data,
      contentType,
      sizeBytes,
    });
  }

  return images;
}

// ---------------------------------------------------------------------------
// Video discovery & upload (Hyperframes-generated overview)
// ---------------------------------------------------------------------------

/** Standard discovery path within a wiki dir. */
const WIKI_VIDEO_RELATIVE_PATH = 'video/overview.mp4';
const WIKI_VIDEO_CAPTION_FILE_PATTERN =
  /^captions\.([a-z]{2,3}(?:-[a-z0-9]{2,8})*)\.vtt$/;
const WIKI_VIDEO_CAPTION_DEFAULT_LABELS = new Map([['en', 'English']]);
const STORAGE_OBJECT_FIELD = ['s3', 'Key'].join('') as 's3Key';

function withStorageObjectPath(
  value: string
): Record<typeof STORAGE_OBJECT_FIELD, string> {
  return { [STORAGE_OBJECT_FIELD]: value };
}

interface VideoCaptionUploadInput {
  fullPath: string;
  relativePath: string;
  language: string;
  label: string;
  sizeBytes: number;
}

interface VideoUploadInput {
  fullPath: string;
  relativePath: string;
  sizeBytes: number;
  captionTracks: VideoCaptionUploadInput[];
}

interface VideoUploadOptions {
  repoUrl: string;
  apiBaseUrl: string;
  authHeaders: Record<string, string>;
  /**
   * UUID minted upfront by the caller (`runWikiUpload`) so the same id flows
   * through /video-upload-url and POST /api/v0/wiki. Backend signs the upload
   * URL using this id and rejects with 409 if it collides with an existing run.
   */
  wikiRunId: string;
}

interface VideoUploadResult {
  wikiRunId: string;
  videoOverview: WikiVideoOverviewMetadata;
}

function getCaptionLabel(language: string): string {
  return WIKI_VIDEO_CAPTION_DEFAULT_LABELS.get(language) ?? language;
}

function discoverWikiVideoCaptionTracks(
  wikiDir: string
): VideoCaptionUploadInput[] {
  const videoDir = join(wikiDir, 'video');
  let entries: string[];
  try {
    entries = readdirSync(videoDir);
  } catch {
    return [];
  }

  return entries.sort().flatMap((entry): VideoCaptionUploadInput[] => {
    const match = entry.match(WIKI_VIDEO_CAPTION_FILE_PATTERN);
    if (!match) {
      return [];
    }

    const fullPath = join(videoDir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      return [];
    }

    if (!stat.isFile()) {
      return [];
    }

    const language = match[1];
    const relativePath = relative(wikiDir, fullPath).replaceAll('\\', '/');
    return [
      {
        fullPath,
        relativePath,
        language,
        label: getCaptionLabel(language),
        sizeBytes: stat.size,
      },
    ];
  });
}

/**
 * Returns input metadata when `<wikiDir>/video/overview.mp4` exists, otherwise undefined.
 * Does not validate content-type or size — the caller decides what to do on each.
 */
export function discoverWikiVideo(
  wikiDir: string
): VideoUploadInput | undefined {
  const fullPath = join(wikiDir, WIKI_VIDEO_RELATIVE_PATH);
  if (!existsSync(fullPath)) {
    return undefined;
  }

  let stat;
  try {
    stat = statSync(fullPath);
  } catch {
    return undefined;
  }

  if (!stat.isFile()) {
    return undefined;
  }

  return {
    fullPath,
    relativePath: WIKI_VIDEO_RELATIVE_PATH,
    sizeBytes: stat.size,
    captionTracks: discoverWikiVideoCaptionTracks(wikiDir),
  };
}

/**
 * Returns true if the file's first 12 bytes contain a valid ISO-BMFF `ftyp`
 * box (bytes 4-7 == ASCII "ftyp"). This is the signature shared by all MP4
 * variants and is the most reliable byte-level test without a parser dep.
 */
export function hasMp4MagicBytes(fullPath: string): boolean {
  let buf: Buffer;
  try {
    const fd = readFileSync(fullPath);
    buf = fd.subarray(0, 12);
  } catch {
    return false;
  }
  if (buf.length < 12) {
    return false;
  }
  return buf.slice(4, 8).toString('ascii') === 'ftyp';
}

export function hasWebVttHeader(fullPath: string): boolean {
  let text: string;
  try {
    text = readFileSync(fullPath, 'utf-8').slice(0, 128);
  } catch {
    return false;
  }
  return /^WEBVTT(?:[\r\n \t]|$)/.test(text);
}

/**
 * Returns the duration of an MP4 in seconds via `ffprobe`. Returns undefined if
 * `ffprobe` is unavailable, the call times out, or the output cannot be parsed.
 * Schema requires a non-negative number; callers should fall back to 0 on undefined.
 */
async function probeVideoDurationSeconds(
  fullPath: string
): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        fullPath,
      ],
      { timeout: 10_000 }
    );
    const value = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(value) || value < 0) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

async function reserveVideoUpload(
  input: VideoUploadInput,
  opts: VideoUploadOptions
): Promise<WikiVideoUploadUrlResponse> {
  const t = getI18n().t;
  const body: WikiVideoUploadUrlRequest = {
    wikiRunId: opts.wikiRunId,
    repoUrl: opts.repoUrl,
    video: {
      contentType: WIKI_VIDEO_CONTENT_TYPE,
      sizeBytes: input.sizeBytes,
    },
    captionTracks: input.captionTracks.map((track) => ({
      language: track.language,
      label: track.label,
      contentType: WIKI_VIDEO_CAPTION_CONTENT_TYPE,
      sizeBytes: track.sizeBytes,
    })),
  };

  const response = await fetchBackend('/api/v0/wiki/video-upload-url', {
    method: 'POST',
    headers: {
      ...opts.authHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      t('commands:wikiUpload.videoReserveFailed', {
        status: response.status,
        body: errorBody,
      })
    );
  }

  return (await response.json()) as WikiVideoUploadUrlResponse;
}

/**
 * Performs the presigned PUT to S3. No auth header — the URL is signed.
 * Caller wraps for retry / graceful failure.
 */
async function putFileToPresignedUrl(
  uploadUrl: string,
  input: {
    fullPath: string;
    sizeBytes: number;
    contentType: string;
  }
): Promise<void> {
  const t = getI18n().t;
  const body = readFileSync(input.fullPath);

  let response: Response;
  try {
    response = await fetchPresignedUrl(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': input.contentType,
        'Content-Length': String(input.sizeBytes),
      },
      body,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(t('commands:wikiUpload.videoPutFailed', { message }));
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      t('commands:wikiUpload.videoPutFailed', {
        message: `HTTP ${response.status} ${errorBody}`.trim(),
      })
    );
  }
}

/** Maximum number of S3 PUT attempts before giving up. */
const VIDEO_PUT_MAX_ATTEMPTS = 2;

/**
 * Determines whether a PUT failure is transient (network error or 5xx) and
 * therefore worth retrying. The heuristic matches:
 *  - fetch-level exceptions (network / DNS / timeout)
 *  - HTTP 5xx status codes reported in the error message
 */
export function isTransientPutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes('ECONNREFUSED') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ENETUNREACH') ||
    message.includes('EAI_AGAIN') ||
    message.includes('fetch failed') ||
    message.includes('network')
  ) {
    return true;
  }
  // Match "HTTP 5xx" anywhere in the message
  if (/HTTP\s+5\d{2}/i.test(message)) {
    return true;
  }
  return false;
}

/**
 * Validates discovered video and uploads it via presigned URL. Returns
 * `{ wikiRunId, videoOverview }` on success.
 *
 * On invalid content-type or oversize input, sets `process.exitCode = 1`
 * and throws `INVALID_VIDEO_PRECHECK` (caller aborts the wiki upload).
 *
 * On transient S3 PUT failure, retries exactly once. If both attempts fail,
 * returns a result with `videoOverview.status === 'failed'` and non-empty
 * warnings so the wiki upload can proceed without a playable video.
 */
export async function prepareVideoOverview(
  input: VideoUploadInput,
  opts: VideoUploadOptions
): Promise<VideoUploadResult> {
  const t = getI18n().t;

  const sizeMB = (input.sizeBytes / (1024 * 1024)).toFixed(2);

  if (input.sizeBytes > WIKI_VIDEO_MAX_BYTES) {
    writeStderr(
      t('commands:wikiUpload.errorPrefix', {
        message: t('commands:wikiUpload.videoOversize', {
          path: input.fullPath,
          sizeMB,
          maxMB: WIKI_VIDEO_MAX_BYTES / (1024 * 1024),
        }),
      })
    );
    process.exitCode = 1;
    throw new Error('INVALID_VIDEO_PRECHECK');
  }

  if (!hasMp4MagicBytes(input.fullPath)) {
    writeStderr(
      t('commands:wikiUpload.errorPrefix', {
        message: t('commands:wikiUpload.videoInvalidContentType', {
          path: input.fullPath,
        }),
      })
    );
    process.exitCode = 1;
    throw new Error('INVALID_VIDEO_PRECHECK');
  }

  if (input.captionTracks.length === 0) {
    writeStderr(
      t('commands:wikiUpload.errorPrefix', {
        message:
          'Wiki video captions are required at video/captions.<language>.vtt. Aborting upload.',
      })
    );
    process.exitCode = 1;
    throw new Error('INVALID_VIDEO_PRECHECK');
  }

  for (const captionTrack of input.captionTracks) {
    if (captionTrack.sizeBytes > WIKI_VIDEO_CAPTION_MAX_BYTES) {
      const captionSizeMB = (captionTrack.sizeBytes / (1024 * 1024)).toFixed(2);
      writeStderr(
        t('commands:wikiUpload.errorPrefix', {
          message: `Wiki video caption at ${captionTrack.fullPath} is ${captionSizeMB} MB which exceeds the ${WIKI_VIDEO_CAPTION_MAX_BYTES / (1024 * 1024)} MB limit. Aborting upload.`,
        })
      );
      process.exitCode = 1;
      throw new Error('INVALID_VIDEO_PRECHECK');
    }

    if (!hasWebVttHeader(captionTrack.fullPath)) {
      writeStderr(
        t('commands:wikiUpload.errorPrefix', {
          message: `Wiki video caption at ${captionTrack.fullPath} is not a valid text/vtt file (missing WEBVTT header). Aborting upload.`,
        })
      );
      process.exitCode = 1;
      throw new Error('INVALID_VIDEO_PRECHECK');
    }
  }

  writeStdout(
    t('commands:wikiUpload.videoFound', {
      path: input.fullPath,
      sizeMB,
    })
  );

  writeStdout(t('commands:wikiUpload.videoReserving'));
  const reservation = await reserveVideoUpload(input, opts);
  const reservedRunId = reservation.wikiRunId;
  const reservedObjectPath = reservation.video[STORAGE_OBJECT_FIELD];

  writeStdout(t('commands:wikiUpload.videoUploading', { sizeMB }));

  // Retry-once: attempt the PUT up to VIDEO_PUT_MAX_ATTEMPTS times.
  let lastPutError: unknown;
  let putSucceeded = false;

  for (let attempt = 1; attempt <= VIDEO_PUT_MAX_ATTEMPTS; attempt++) {
    try {
      await putFileToPresignedUrl(reservation.video.uploadUrl, {
        fullPath: input.fullPath,
        sizeBytes: input.sizeBytes,
        contentType: WIKI_VIDEO_CONTENT_TYPE,
      });
      for (const captionTarget of reservation.captionTracks) {
        const captionInput = input.captionTracks.find(
          (track) => track.language === captionTarget.language
        );
        if (!captionInput) {
          throw new MetaError('Missing caption input for language', {
            reason: captionTarget.language,
            state: 'missing_caption_input',
          });
        }
        await putFileToPresignedUrl(captionTarget.uploadUrl, {
          fullPath: captionInput.fullPath,
          sizeBytes: captionInput.sizeBytes,
          contentType: WIKI_VIDEO_CAPTION_CONTENT_TYPE,
        });
      }
      putSucceeded = true;
      break;
    } catch (error) {
      lastPutError = error;
      const reason = error instanceof Error ? error.message : String(error);

      if (attempt < VIDEO_PUT_MAX_ATTEMPTS && isTransientPutError(error)) {
        // Surface a clear retry log line to stdout (observable by callers)
        writeStdout(
          t('commands:wikiUpload.videoPutRetry', {
            attempt: String(attempt),
            maxAttempts: String(VIDEO_PUT_MAX_ATTEMPTS),
            reason,
          })
        );
        continue;
      }
      // Non-transient error on first attempt, or second attempt failed — stop.
      break;
    }
  }

  const durationSeconds =
    (await probeVideoDurationSeconds(input.fullPath)) ?? 0;

  if (putSucceeded) {
    const captionInputsByLanguage = new Map(
      input.captionTracks.map((track) => [track.language, track])
    );
    writeStdout(t('commands:wikiUpload.videoUploaded'));
    return {
      wikiRunId: reservedRunId,
      videoOverview: {
        status: 'ready',
        ...withStorageObjectPath(reservedObjectPath),
        sizeBytes: input.sizeBytes,
        contentType: WIKI_VIDEO_CONTENT_TYPE,
        generatedAt: new Date().toISOString(),
        durationSeconds,
        captionTracks: reservation.captionTracks.map((track) => {
          const captionInput = captionInputsByLanguage.get(track.language);
          if (!captionInput) {
            throw new MetaError('Missing caption input for language', {
              reason: track.language,
              state: 'missing_caption_input',
            });
          }
          return {
            language: track.language,
            label: track.label,
            ...withStorageObjectPath(track[STORAGE_OBJECT_FIELD]),
            sizeBytes: captionInput.sizeBytes,
            contentType: WIKI_VIDEO_CAPTION_CONTENT_TYPE,
          };
        }),
        warnings: [],
      },
    };
  }

  // Both attempts failed — graceful failure.
  const failReason =
    lastPutError instanceof Error ? lastPutError.message : String(lastPutError);

  writeStderr(
    t('commands:wikiUpload.videoUploadFailedWarning', { reason: failReason })
  );

  return {
    wikiRunId: reservedRunId,
    videoOverview: {
      status: 'failed',
      ...withStorageObjectPath(reservedObjectPath),
      sizeBytes: input.sizeBytes,
      contentType: WIKI_VIDEO_CONTENT_TYPE,
      generatedAt: new Date().toISOString(),
      durationSeconds,
      warnings: [
        `Video upload failed after ${VIDEO_PUT_MAX_ATTEMPTS} attempt(s): ${failReason}`,
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Video reuse (copy-from-prior-run)
// ---------------------------------------------------------------------------

interface VideoReuseOptions {
  apiBaseUrl: string;
  authHeaders: Record<string, string>;
}

/**
 * Verifies that a wiki run's video overview has a working `playbackUrl` by
 * fetching the run via `GET /api/v0/wiki/:wikiRunId` and issuing a small
 * ranged GET against the returned `playbackUrl`. Returns the verified response
 * on success, or throws with a descriptive message on any failure.
 */
export async function verifyVideoPlaybackUrl(
  wikiRunId: string,
  opts: VideoReuseOptions
): Promise<GetWikiRunResponse> {
  const t = getI18n().t;

  const getEndpoint = `/api/v0/wiki/${encodeURIComponent(wikiRunId)}`;
  const getResponse = await fetchBackend(getEndpoint, {
    method: 'GET',
    headers: opts.authHeaders,
  });

  if (!getResponse.ok) {
    const errorBody = await getResponse.text().catch(() => '');
    throw new Error(
      t('commands:wikiUpload.videoReuseVerifyFailed', {
        reason:
          `GET ${getEndpoint} returned ${getResponse.status}: ${errorBody}`.trim(),
      })
    );
  }

  const runData = (await getResponse.json()) as GetWikiRunResponse;

  if (
    !runData.videoOverview ||
    runData.videoOverview.status !== 'ready' ||
    !('playbackUrl' in runData.videoOverview) ||
    !runData.videoOverview.playbackUrl ||
    !runData.videoOverview.captionTracks.length ||
    runData.videoOverview.captionTracks.some((track) => !track.playbackUrl)
  ) {
    throw new Error(
      t('commands:wikiUpload.videoReuseVerifyFailed', {
        reason:
          'New wiki run does not contain a playable videoOverview with captions after reuse',
      })
    );
  }

  // Use GET because SigV4 presigned URLs are method-bound.
  const playbackResponse = await fetchPresignedUrl(
    runData.videoOverview.playbackUrl,
    {
      method: 'GET',
      headers: {
        Range: 'bytes=0-0',
      },
    }
  );

  if (!playbackResponse.ok) {
    throw new Error(
      t('commands:wikiUpload.videoReuseVerifyFailed', {
        reason: `Playback URL GET returned ${playbackResponse.status}`,
      })
    );
  }

  await Promise.all(
    runData.videoOverview.captionTracks.map(async (track) => {
      const captionResponse = await fetchPresignedUrl(track.playbackUrl, {
        method: 'GET',
        headers: {
          Range: 'bytes=0-0',
        },
      });

      if (!captionResponse.ok) {
        throw new Error(
          t('commands:wikiUpload.videoReuseVerifyFailed', {
            reason: `Caption playback URL GET returned ${captionResponse.status}`,
          })
        );
      }
    })
  );

  return runData;
}

/**
 * Reuses a video overview from a prior wiki run by sending
 * `copyFromWikiRunId` to `POST /api/v0/wiki`. No S3 PUT body bytes are
 * issued by the CLI — the backend re-references the same S3 object.
 *
 * After creation, verifies the new run has a working `playbackUrl`.
 * Propagates backend errors as clear failures.
 *
 * Returns the newly-created `wikiRunId` on success.
 */
export async function reuseVideoFromPriorRun(
  sourceWikiRunId: string,
  payload: Omit<CreateWikiRunRequest, 'copyFromWikiRunId' | 'videoOverview'>,
  opts: VideoReuseOptions
): Promise<string> {
  const t = getI18n().t;

  writeStdout(
    t('commands:wikiUpload.videoReusingPrior', { runId: sourceWikiRunId })
  );

  const createPayload: CreateWikiRunRequest = {
    ...payload,
    copyFromWikiRunId: sourceWikiRunId,
  };

  const response = await fetchBackend('/api/v0/wiki', {
    method: 'POST',
    headers: {
      ...opts.authHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(createPayload),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      t('commands:wikiUpload.videoReuseFailed', {
        status: response.status,
        body: errorBody,
      })
    );
  }

  const result = (await response.json()) as { wikiRunId: string };
  const newRunId = result.wikiRunId;

  writeStdout(t('commands:wikiUpload.videoReuseCreated', { runId: newRunId }));

  // Verify the new run has a working playback URL
  await verifyVideoPlaybackUrl(newRunId, opts);

  writeStdout(t('commands:wikiUpload.videoReuseVerified'));

  return newRunId;
}

// ---------------------------------------------------------------------------
// GitHub wiki sync helpers
// ---------------------------------------------------------------------------

/**
 * Extracts {owner}/{repo} from a GitHub URL.
 * Supports HTTPS and SSH formats.
 */
export function extractGitHubOwnerRepo(
  repoUrl: string
): { owner: string; repo: string } | null {
  // HTTPS: https://github.com/owner/repo or https://github.com/owner/repo.git
  const httpsMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // SSH: git@github.com:owner/repo.git
  const sshMatch = repoUrl.match(
    /git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/
  );
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

/**
 * Checks whether the wiki repo exists by running `git ls-remote`.
 * Returns true if the wiki repo is accessible, false otherwise.
 *
 * Uses `deriveWikiGitUrl` to correctly strip any trailing `.git` from
 * `repoUrl` before appending `.wiki.git`. Naive concatenation would
 * produce malformed URLs like `owner/repo.git.wiki.git`.
 */
async function checkWikiRepoExists(repoUrl: string): Promise<boolean> {
  const wikiUrl = deriveWikiGitUrl(repoUrl);
  if (!wikiUrl) {
    return false;
  }

  try {
    await execFileAsync('git', ['ls-remote', wikiUrl], {
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Handles the GitHub wiki sync flow after a successful Industry upload.
 * Performs guard checks and calls syncToGitHubWiki on success.
 * Never throws — sync failures are logged but do not fail the overall command.
 */
async function handleGitHubWikiSync(options: {
  repoUrl: string;
  wikiDir: string;
  pageTree: PageTreeNode[];
}): Promise<void> {
  const { repoUrl, wikiDir, pageTree } = options;

  try {
    // Guard: check wikiCloudSync org setting
    let headers: Record<string, string>;
    try {
      headers = await getAuthHeadersOrThrow();
    } catch {
      writeStderr(
        'GitHub wiki sync: Unable to check org settings. Skipping sync.'
      );
      return;
    }

    try {
      const settingsResponse = await fetchBackend(
        '/api/organization/managed-settings',
        {
          method: 'GET',
          headers,
        }
      );

      if (settingsResponse.ok) {
        const body = (await settingsResponse.json()) as {
          success: boolean;
          settings?: { wikiCloudSync?: boolean } | null;
        };

        if (body.success && body.settings?.wikiCloudSync === false) {
          writeStdout(
            'GitHub wiki sync: Wiki cloud sync is disabled for your organization. Skipping sync.'
          );
          return;
        }
      }
    } catch {
      // If we can't check settings, proceed with sync (optimistic)
    }

    // Guard: check if repo URL is a GitHub URL
    if (!repoUrl.includes('github.com')) {
      writeStdout(
        'GitHub wiki sync: Repository is not hosted on GitHub. Skipping sync.'
      );
      return;
    }

    // Guard: check if wiki exists
    const wikiExists = await checkWikiRepoExists(repoUrl);
    if (!wikiExists) {
      const ownerRepo = extractGitHubOwnerRepo(repoUrl);
      if (ownerRepo) {
        writeStderr(
          `GitHub wiki not initialized. Create first page at https://github.com/${ownerRepo.owner}/${ownerRepo.repo}/wiki`
        );
      } else {
        writeStderr(
          'GitHub wiki not initialized. Create the first page via the GitHub wiki tab.'
        );
      }
      return;
    }

    // All guards passed — sync
    writeStdout('Syncing to GitHub wiki...');
    const syncResult = await syncToGitHubWiki({
      wikiDir,
      repoUrl,
      pageTree,
    });

    if (syncResult.success) {
      const ownerRepo = extractGitHubOwnerRepo(repoUrl);
      if (ownerRepo) {
        writeStdout(
          `GitHub wiki synced: https://github.com/${ownerRepo.owner}/${ownerRepo.repo}/wiki`
        );
      } else {
        writeStdout('GitHub wiki synced successfully.');
      }
    } else {
      writeStderr(
        `GitHub wiki sync failed: ${syncResult.error ?? 'Unknown error'}`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`GitHub wiki sync failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Upload logic
// ---------------------------------------------------------------------------

/**
 * Parses --upload-to into a set of upload targets.
 * Defaults to ['industry'] if not provided.
 */
function resolveUploadTargets(options: WikiUploadOptions): Set<UploadTarget> {
  if (options.uploadTo) {
    const targets = new Set<UploadTarget>();
    for (const t of options.uploadTo.split(',')) {
      const trimmed = t.trim().toLowerCase();
      if (trimmed === 'industry' || trimmed === 'github') {
        targets.add(trimmed);
      } else {
        writeStderr(
          `Unknown upload target: "${trimmed}". Valid targets: industry, github`
        );
      }
    }
    if (targets.size === 0) {
      targets.add('industry');
    }
    return targets;
  }

  return new Set<UploadTarget>(['industry']);
}

/**
 * Main wiki upload logic. Separated for testability.
 */
export async function runWikiUpload(options: WikiUploadOptions): Promise<void> {
  const { sessionId, repoUrl, wikiDir, cleanup } = options;
  const uploadTargets = resolveUploadTargets(options);

  const t = getI18n().t;
  // Validate wiki directory exists
  if (!existsSync(wikiDir)) {
    writeStderr(
      t('commands:wikiUpload.errorPrefix', {
        message: t('commands:wikiUpload.dirNotExist', { path: wikiDir }),
      })
    );
    process.exitCode = 1;
    return;
  }

  if (!statSync(wikiDir).isDirectory()) {
    writeStderr(
      t('commands:wikiUpload.errorPrefix', {
        message: t('commands:wikiUpload.notADirectory', { path: wikiDir }),
      })
    );
    process.exitCode = 1;
    return;
  }

  // Find markdown files
  const mdFiles = findMarkdownFiles(wikiDir);
  if (mdFiles.length === 0) {
    writeStderr(
      t('commands:wikiUpload.errorPrefix', {
        message: t('commands:wikiUpload.noMarkdownFiles', { path: wikiDir }),
      })
    );
    process.exitCode = 1;
    return;
  }

  writeStdout(
    t('commands:wikiUpload.foundFiles', {
      count: mdFiles.length,
      path: wikiDir,
    })
  );

  // Build page tree and pages
  const pageOrder = readPageOrderFromWikiMeta(wikiDir);
  const { pages, pageTree } = buildPageTree(mdFiles, wikiDir, pageOrder);
  writeStdout(t('commands:wikiUpload.builtPageTree', { count: pages.length }));

  // Discover and encode images
  const imageFiles = findImageFiles(wikiDir);
  let images: WikiImage[] | undefined;
  if (imageFiles.length > 0) {
    writeStdout(`Found ${imageFiles.length} image file(s) in ${wikiDir}`);
    images = prepareImagePayload(wikiDir, imageFiles);
    if (images.length > 0) {
      writeStdout(`Prepared ${images.length} image(s) for upload`);
    }
  }

  // Resolve git metadata
  const gitMetadata = await resolveGitMetadata();

  // Discover optional video overview (Hyperframes-generated MP4)
  const videoInput = discoverWikiVideo(wikiDir);

  try {
    // Upload to Industry cloud
    if (uploadTargets.has('industry')) {
      let headers: Record<string, string>;
      try {
        headers = await getAuthHeadersOrThrow();
      } catch {
        writeStderr(getAuthErrorMessage());
        process.exitCode = 1;
        return;
      }

      const baseUrl = getEnv().apiBaseUrl;
      const appUrl = getEnv().appBaseUrl;

      // Reuse-prior-remote-video path: when copyFromWikiRunId is set, skip
      // video discovery/upload entirely and use the backend reuse endpoint.
      if (options.copyFromWikiRunId) {
        const basePayload: Omit<
          CreateWikiRunRequest,
          'copyFromWikiRunId' | 'videoOverview'
        > = {
          repoUrl,
          commitHash: gitMetadata.commitHash,
          branch: gitMetadata.branch,
          hasLocalChanges: gitMetadata.hasLocalChanges,
          hasNonRemoteCommits: gitMetadata.hasNonRemoteCommits,
          droolVersion: process.env.CLI_VERSION,
          pages,
          pageTree,
          ...(sessionId !== undefined && { sessionId }),
          ...(images !== undefined && images.length > 0 && { images }),
        };

        try {
          const newRunId = await reuseVideoFromPriorRun(
            options.copyFromWikiRunId,
            basePayload,
            { apiBaseUrl: baseUrl, authHeaders: headers }
          );

          writeStdout(t('commands:wikiUpload.uploadSuccess', { id: newRunId }));
          const wikiUrl = `${appUrl}/wiki/${newRunId}`;
          writeStdout(t('commands:wikiUpload.viewWiki', { url: wikiUrl }));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          writeStderr(t('commands:wikiUpload.errorPrefix', { message }));
          process.exitCode = 1;
          return;
        }
      } else {
        // Standard path: mint a single wikiRunId for the whole run, discover
        // video, upload if present, then create run. The same id flows through
        // /video-upload-url and POST /api/v0/wiki.
        const { randomUUID } = await import('crypto');
        const wikiRunId = randomUUID();
        let videoResult: VideoUploadResult | undefined;
        if (videoInput) {
          try {
            videoResult = await prepareVideoOverview(videoInput, {
              repoUrl,
              apiBaseUrl: baseUrl,
              authHeaders: headers,
              wikiRunId,
            });
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === 'INVALID_VIDEO_PRECHECK'
            ) {
              // process.exitCode = 1 set in prepareVideoOverview is unreliable
              // under Bun when the throw is caught and the function returns
              // normally. Use process.exit(1) to guarantee a non-zero exit.
              process.exit(1);
              return; // unreachable; keeps TypeScript happy
            }
            throw error;
          }
        }

        const payload: CreateWikiRunRequest = {
          repoUrl,
          commitHash: gitMetadata.commitHash,
          branch: gitMetadata.branch,
          hasLocalChanges: gitMetadata.hasLocalChanges,
          hasNonRemoteCommits: gitMetadata.hasNonRemoteCommits,
          droolVersion: process.env.CLI_VERSION,
          pages,
          pageTree,
          ...(sessionId !== undefined && { sessionId }),
          ...(images !== undefined && images.length > 0 && { images }),
          ...(videoResult !== undefined && {
            wikiRunId,
            videoOverview: videoResult.videoOverview,
          }),
        };

        const url = `${baseUrl}/api/v0/wiki`;

        writeStdout(t('commands:wikiUpload.uploading', { url }));

        const response = await fetchBackend('/api/v0/wiki', {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => 'Unknown error');
          if (response.status === 401 || response.status === 403) {
            writeStderr(
              t('commands:wikiUpload.errorPrefix', {
                message: t('commands:wikiUpload.authFailed', {
                  status: response.status,
                  body: errorBody,
                }),
              })
            );
          } else {
            writeStderr(
              t('commands:wikiUpload.errorPrefix', {
                message: t('commands:wikiUpload.uploadFailed', {
                  status: response.status,
                  body: errorBody,
                }),
              })
            );
          }
          process.exitCode = 1;
          return;
        }

        const result = (await response.json()) as { wikiRunId: string };
        writeStdout(
          t('commands:wikiUpload.uploadSuccess', { id: result.wikiRunId })
        );

        const wikiUrl = `${appUrl}/wiki/${result.wikiRunId}`;
        writeStdout(t('commands:wikiUpload.viewWiki', { url: wikiUrl }));
      }
    }

    // Sync to GitHub wiki
    if (uploadTargets.has('github')) {
      await handleGitHubWikiSync({
        repoUrl,
        wikiDir,
        pageTree,
      });
    }

    // Cleanup on success if requested
    if (cleanup) {
      try {
        rmSync(wikiDir, { recursive: true, force: true });
        writeStdout(t('commands:wikiUpload.cleanedUp', { path: wikiDir }));
      } catch (cleanupError) {
        writeStderr(
          t('commands:wikiUpload.cleanupFailed', {
            message: String(cleanupError),
          })
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNetworkErrorMessage(message)) {
      writeStderr(
        t('commands:wikiUpload.errorPrefix', {
          message: t('commands:wikiUpload.networkError', { message }),
        })
      );
    } else {
      writeStderr(
        t('commands:wikiUpload.errorPrefix', {
          message: t('commands:wikiUpload.genericUploadError', { message }),
        })
      );
    }
    process.exitCode = 1;
  }
}

/**
 * Checks whether wiki cloud sync is enabled for the organization.
 * Fetches managed settings from the API and checks the wikiCloudSync field.
 * Prints 'enabled' or 'disabled' to stdout and sets process.exitCode accordingly.
 */
export async function checkWikiCloudSync(): Promise<void> {
  let headers: Record<string, string>;
  try {
    headers = await getAuthHeadersOrThrow();
  } catch {
    writeStderr(getAuthErrorMessage());
    process.exitCode = 1;
    return;
  }

  try {
    const response = await fetchBackend('/api/organization/managed-settings', {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      writeStderr(
        `Failed to fetch managed settings: ${response.status} ${response.statusText}`
      );
      process.exitCode = 1;
      return;
    }

    const body = (await response.json()) as {
      success: boolean;
      settings?: { wikiCloudSync?: boolean } | null;
    };

    if (!body.success) {
      writeStderr('Failed to retrieve managed settings');
      process.exitCode = 1;
      return;
    }

    const isDisabled = body.settings?.wikiCloudSync === false;

    if (isDisabled) {
      writeStdout('disabled');
      process.exitCode = 1;
    } else {
      writeStdout('enabled');
      process.exitCode = 0;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`Failed to check wiki cloud sync status: ${message}`);
    process.exitCode = 1;
  }
}
