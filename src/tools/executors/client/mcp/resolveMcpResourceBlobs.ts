import { isUtf8 } from 'buffer';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { DEFAULT_OUTPUT_TRUNCATION_THRESHOLD } from '@industry/drool-core/tools/utils/constants';
import { logWarn } from '@industry/logging';

import { getArtifactsDir } from '@/utils/getArtifactsDir';

const MCP_RESOURCE_SUBDIRECTORY = 'mcp-resources';
const MAX_MCP_RESOURCE_BLOBS_PER_RESULT = 64;
const MAX_MCP_RESOURCE_BYTES_PER_RESULT = 10 * 1024 * 1024;
const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/ndjson',
  'application/x-ndjson',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
]);
const MIME_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  'application/json': 'json',
  'application/ndjson': 'ndjson',
  'application/x-ndjson': 'ndjson',
  'application/xml': 'xml',
  'application/yaml': 'yaml',
  'application/x-yaml': 'yaml',
  'application/pdf': 'pdf',
};

type ResolveMcpResourceBlobsContext = {
  serverName: string;
  sessionId: string;
  toolName: string;
};

function resourceLimitExceededBlock(): CallToolResult['content'][number] {
  return {
    type: 'text',
    text: '[Embedded resource omitted because this tool result exceeded the resource limit.]',
  };
}

function sanitizeSegment(segment: string): string {
  const safe = segment.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 200);
  return safe.length > 0 && safe !== '.' && safe !== '..' ? safe : 'unknown';
}

function normalizedMimeType(mimeType: string | undefined): string {
  return mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function isTextLikeMimeType(mimeType: string | undefined): boolean {
  const normalized = normalizedMimeType(mimeType);
  return (
    normalized.startsWith('text/') ||
    TEXT_MIME_TYPES.has(normalized) ||
    normalized.endsWith('+json') ||
    normalized.endsWith('+xml')
  );
}

function isUtf8CompatibleMimeType(mimeType: string | undefined): boolean {
  const charsetParameter = mimeType
    ?.split(';')
    .slice(1)
    .map((parameter) => parameter.trim())
    .find((parameter) => /^charset\s*=/i.test(parameter));
  if (!charsetParameter) {
    return true;
  }
  const charset = charsetParameter
    .replace(/^charset\s*=\s*/i, '')
    .replace(/^"(.*)"$/, '$1')
    .toLowerCase();
  return charset === 'utf-8' || charset === 'utf8';
}

type EncodedBlob = {
  decodedSize: number;
  value: string;
};

function isBase64Character(characterCode: number): boolean {
  return (
    (characterCode >= 65 && characterCode <= 90) ||
    (characterCode >= 97 && characterCode <= 122) ||
    (characterCode >= 48 && characterCode <= 57) ||
    characterCode === 43 ||
    characterCode === 47
  );
}

function parseEncodedBlob(blob: string): EncodedBlob | undefined {
  const normalized = blob.replace(/\s/g, '');
  if (normalized.length % 4 !== 0) {
    return undefined;
  }
  const paddingLength = normalized.endsWith('==')
    ? 2
    : normalized.endsWith('=')
      ? 1
      : 0;
  const dataLength = normalized.length - paddingLength;
  for (let index = 0; index < dataLength; index += 1) {
    if (!isBase64Character(normalized.charCodeAt(index))) {
      return undefined;
    }
  }
  for (let index = dataLength; index < normalized.length; index += 1) {
    if (normalized[index] !== '=') {
      return undefined;
    }
  }
  return {
    decodedSize: (normalized.length / 4) * 3 - paddingLength,
    value: normalized,
  };
}

function decodeInlineText(
  bytes: Buffer,
  mimeType: string | undefined
): string | undefined {
  if (
    !isTextLikeMimeType(mimeType) ||
    !isUtf8CompatibleMimeType(mimeType) ||
    !isUtf8(bytes) ||
    bytes.length > DEFAULT_OUTPUT_TRUNCATION_THRESHOLD
  ) {
    return undefined;
  }
  return bytes.toString('utf8');
}

function getResourceName(uri: string, mimeType: string | undefined): string {
  let basename = '';
  try {
    const parsedUri = new URL(uri);
    basename =
      path.basename(decodeURIComponent(parsedUri.pathname)) ||
      path.basename(parsedUri.hostname);
  } catch {
    basename = path.basename(uri.split(/[?#]/, 1)[0] ?? '');
  }

  if (basename) {
    return sanitizeSegment(basename);
  }

  const extension = MIME_TYPE_EXTENSIONS[normalizedMimeType(mimeType)] ?? 'bin';
  return `resource.${extension}`;
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'EEXIST'
  );
}

async function ensureSecureDirectory(directory: string): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(directory, 0o700);
}

async function writeArtifactIfAvailable(
  filePath: string,
  bytes: Buffer
): Promise<boolean> {
  try {
    await fs.promises.writeFile(filePath, bytes, {
      flag: 'wx',
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    const existingStats = await fs.promises.lstat(filePath);
    if (!existingStats.isFile()) {
      return false;
    }
    const existingBytes = await fs.promises.readFile(filePath);
    return existingBytes.equals(bytes);
  }
}

async function persistBlob(
  bytes: Buffer,
  uri: string,
  mimeType: string | undefined,
  sessionId: string
): Promise<string | undefined> {
  const baseDirectory = getArtifactsDir();
  const resourcesDirectory = path.join(
    baseDirectory,
    MCP_RESOURCE_SUBDIRECTORY
  );
  const sessionDirectory = path.join(
    resourcesDirectory,
    sanitizeSegment(sessionId)
  );
  await ensureSecureDirectory(baseDirectory);
  await ensureSecureDirectory(resourcesDirectory);
  await ensureSecureDirectory(sessionDirectory);

  const hash = createHash('sha1').update(bytes).digest('hex');
  const resourceName = getResourceName(uri, mimeType);
  let filePath = path.join(
    sessionDirectory,
    `${hash.slice(0, 8)}-${resourceName}`
  );

  if (!(await writeArtifactIfAvailable(filePath, bytes))) {
    filePath = path.join(sessionDirectory, `${hash}-${resourceName}`);
    if (!(await writeArtifactIfAvailable(filePath, bytes))) {
      return undefined;
    }
  }

  await fs.promises.chmod(filePath, 0o600);
  return filePath;
}

export async function resolveMcpResourceBlobs(
  result: CallToolResult,
  context: ResolveMcpResourceBlobsContext
): Promise<CallToolResult> {
  if (!result.content || result.content.length === 0) {
    return result;
  }

  const content: CallToolResult['content'] = [];
  let blobCount = 0;
  let decodedBytes = 0;
  for (const block of result.content) {
    if (block.type !== 'resource' || !('blob' in block.resource)) {
      content.push(block);
      continue;
    }

    if (blobCount >= MAX_MCP_RESOURCE_BLOBS_PER_RESULT) {
      content.push(resourceLimitExceededBlock());
      continue;
    }
    blobCount += 1;

    const encodedBlob = parseEncodedBlob(block.resource.blob);
    const mimeType = block.resource.mimeType ?? 'unknown type';
    if (!encodedBlob) {
      logWarn('[MCP] Ignoring invalid embedded resource blob', {
        serviceName: context.serverName,
        toolName: context.toolName,
        reason: 'invalid_embedded_resource_blob',
      });
      content.push(block);
      continue;
    }

    if (
      encodedBlob.decodedSize >
      MAX_MCP_RESOURCE_BYTES_PER_RESULT - decodedBytes
    ) {
      content.push(resourceLimitExceededBlock());
      continue;
    }
    decodedBytes += encodedBlob.decodedSize;
    const bytes = Buffer.from(encodedBlob.value, 'base64');

    const inlineText = decodeInlineText(bytes, block.resource.mimeType);
    if (inlineText !== undefined) {
      content.push({
        type: 'text',
        text: inlineText,
      });
      continue;
    }

    try {
      const filePath = await persistBlob(
        bytes,
        block.resource.uri,
        block.resource.mimeType,
        context.sessionId
      );
      if (!filePath) {
        content.push(block);
        continue;
      }
      content.push({
        type: 'text',
        text: `[Embedded resource (${mimeType}, ${bytes.length} bytes) saved to ${filePath}. Read it with the Read tool.]`,
      });
    } catch {
      logWarn('[MCP] Failed to persist embedded resource blob', {
        serviceName: context.serverName,
        toolName: context.toolName,
        reason: 'embedded_resource_persistence_failed',
      });
      content.push(block);
    }
  }

  return {
    ...result,
    content,
  };
}
