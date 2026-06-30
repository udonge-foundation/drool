/**
 * Kitty / Ghostty OSC 5522 terminal clipboard protocol.
 *
 * Minimal on-demand reader for the OSC 5522 clipboard protocol. The protocol
 * relays clipboard MIME types and binary data through stdin/stdout, so a
 * supporting terminal can expose image data even over SSH.
 *
 * Protocol summary (only the subset we use):
 *
 *   Client -> terminal (write request on stdout):
 *     ESC ] 5522 ; <metadata> ; <payload> ST
 *     metadata = colon-separated key=value pairs. Keys we set:
 *       type=read
 *     payload = base64-encoded "." to list MIME types, or a MIME type to read
 *
 *   Terminal -> client (response on stdin):
 *     ESC ] 5522 ; <metadata> ; <payload> BEL  (or ST)
 *     metadata carries status=OK/DATA/DONE or an error code. DATA packets
 *     base64-encode their payload; MIME metadata is also base64-encoded.
 *
 * References:
 *   https://sw.kovidgoyal.net/kitty/clipboard/
 *   https://ghostty.org/docs/vt/osc
 *
 * This module is self-contained (no React/ink). Callers must feed stdin OSC
 * 5522 packets in via `processTerminalClipboardPacket` (KeypressProvider wires
 * that up via `extractTerminalClipboardPackets`).
 */

import { MetaError } from '@industry/logging';

const OSC_5522_PREFIX_STR = '\x1b]5522;';
const OSC_BEL = '\x07';
const OSC_ST_PREFIX = '\x1b\\';

// Hard cap on a single clipboard read. The real attachment limit is enforced
// upstream by ImageStorageService; this only guards against runaway terminals.
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 1500;
const DEFAULT_DATA_TIMEOUT_MS = 8000;
const MAX_INCOMPLETE_PACKET_CHARS =
  Math.ceil((DEFAULT_MAX_RESPONSE_BYTES * 4) / 3) + 4096;

type TerminalClipboardStatus = 'OK' | 'DATA' | 'DONE' | 'ERROR';

type TerminalClipboardPacket = {
  readonly metadata: Record<string, string>;
  readonly payload: Buffer;
};

type TerminalClipboardRequestOptions = {
  readonly stdoutWrite?: (chunk: string) => void;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
};

type PendingRequest = {
  readonly kind: 'mime-list' | 'data';
  readonly requestedMimeType?: string;
  readonly resolve: (value: Buffer) => void;
  readonly reject: (err: Error) => void;
  readonly maxResponseBytes: number;
  readonly chunks: Buffer[];
  byteLength: number;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
};

let pendingRequest: PendingRequest | null = null;

function defaultStdoutWrite(chunk: string): void {
  try {
    if (process.stdout.isTTY) process.stdout.write(chunk);
  } catch {
    // A closed/pipe stdout should not crash clipboard reads.
  }
}

function encodeMetadataValue(key: string, value: string): string {
  return key === 'mime' ? Buffer.from(value, 'utf8').toString('base64') : value;
}

/**
 * Build the OSC 5522 request byte sequence that should be written to the
 * terminal.
 */
export function buildTerminalClipboardRequest(
  metadata: Record<string, string>,
  payload: Buffer = Buffer.alloc(0)
): string {
  const metaString = Object.entries(metadata)
    .map(([key, value]) => `${key}=${encodeMetadataValue(key, value)}`)
    .join(':');
  const encodedPayload = payload.length > 0 ? payload.toString('base64') : '';
  return `${OSC_5522_PREFIX_STR}${metaString};${encodedPayload}${OSC_ST_PREFIX}`;
}

function decodeMetadataValue(key: string, value: string): string {
  if (key !== 'mime') return value;
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return value;
  }
}

function parseMetadata(metaString: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  if (!metaString) return metadata;
  for (const pair of metaString.split(':')) {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      const trimmed = pair.trim();
      if (trimmed && !metadata.status) metadata.status = trimmed;
      continue;
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) metadata[key] = decodeMetadataValue(key, value);
  }
  return metadata;
}

function decodePayload(payload: string): Buffer {
  if (payload.length === 0) return Buffer.alloc(0);
  const encodedPayload = payload.replace(/\s+/g, '');
  if (Math.ceil(encodedPayload.length * 0.75) > DEFAULT_MAX_RESPONSE_BYTES) {
    throw new MetaError('terminal clipboard payload exceeded size limit', {
      limit: DEFAULT_MAX_RESPONSE_BYTES,
    });
  }
  return Buffer.from(encodedPayload, 'base64');
}

/**
 * Parse the body of an OSC 5522 packet (everything between `ESC]5522;` and
 * the terminator).
 */
export function parseTerminalClipboardBody(
  body: string
): TerminalClipboardPacket {
  const semi = body.indexOf(';');
  if (semi === -1) {
    return { metadata: parseMetadata(body), payload: Buffer.alloc(0) };
  }
  const metadata = parseMetadata(body.slice(0, semi));
  try {
    return {
      metadata,
      payload: decodePayload(body.slice(semi + 1)),
    };
  } catch (error) {
    return {
      metadata: {
        ...metadata,
        status: 'ERROR',
        error:
          error instanceof Error
            ? error.message
            : 'terminal clipboard payload decode failed',
      },
      payload: Buffer.alloc(0),
    };
  }
}

function deriveStatus(
  metadata: Record<string, string>
): TerminalClipboardStatus {
  const raw = (
    metadata.status ||
    metadata.op ||
    metadata.result ||
    ''
  ).toUpperCase();
  if (raw === 'OK' || raw === 'DATA' || raw === 'DONE') {
    return raw;
  }
  return 'ERROR';
}

// Buffer and Error are disjoint (Buffer extends Uint8Array), so we can
// discriminate with a single instanceof check instead of a tagged union.
function finalizePending(
  request: PendingRequest,
  outcome: Buffer | Error
): void {
  if (request.timeoutHandle) {
    clearTimeout(request.timeoutHandle);
    request.timeoutHandle = null;
  }
  if (pendingRequest === request) pendingRequest = null;
  if (outcome instanceof Error) request.reject(outcome);
  else request.resolve(outcome);
}

/**
 * Dispatch a parsed OSC 5522 packet to any matching pending request.
 * Returns `true` when the packet was consumed by a pending request.
 */
export function processTerminalClipboardPacket(
  packet: TerminalClipboardPacket
): boolean {
  const request = pendingRequest;
  if (!request) return false;

  const status = deriveStatus(packet.metadata);
  if (status === 'ERROR') {
    const detail =
      packet.metadata.status ||
      packet.metadata.error ||
      packet.metadata.errno ||
      'unspecified';
    finalizePending(
      request,
      new MetaError(`terminal clipboard error (${detail})`, {
        mimeType: request.requestedMimeType,
      })
    );
    return true;
  }

  if (status === 'DATA' && packet.payload.length > 0) {
    if (
      request.kind === 'data' &&
      packet.metadata.mime &&
      packet.metadata.mime !== request.requestedMimeType
    ) {
      return true;
    }
    request.chunks.push(packet.payload);
    request.byteLength += packet.payload.length;
    if (request.byteLength > request.maxResponseBytes) {
      finalizePending(
        request,
        new MetaError('terminal clipboard response exceeded size limit', {
          mimeType: request.requestedMimeType,
          limit: request.maxResponseBytes,
        })
      );
      return true;
    }
  }

  if (status === 'DONE') {
    finalizePending(request, Buffer.concat(request.chunks, request.byteLength));
  }
  return true;
}

function registerRequest(
  kind: PendingRequest['kind'],
  requestedMimeType: string | undefined,
  timeoutMs: number,
  maxResponseBytes: number
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    if (pendingRequest) {
      finalizePending(
        pendingRequest,
        new MetaError('terminal clipboard request superseded')
      );
    }
    const entry: PendingRequest = {
      kind,
      requestedMimeType,
      resolve,
      reject,
      maxResponseBytes,
      chunks: [],
      byteLength: 0,
      timeoutHandle: null,
    };
    pendingRequest = entry;

    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      entry.timeoutHandle = setTimeout(() => {
        finalizePending(
          entry,
          new MetaError('terminal clipboard request timed out', {
            timeout: timeoutMs,
            mimeType: requestedMimeType,
          })
        );
      }, timeoutMs);
      entry.timeoutHandle.unref?.();
    }
  });
}

/**
 * Ask the terminal for the list of MIME types currently available on the
 * clipboard. Resolves with `[]` when the terminal does not support the
 * protocol (request times out) so callers treat the fallback as "no data".
 */
export async function requestTerminalClipboardMimeList(
  options: TerminalClipboardRequestOptions = {}
): Promise<string[]> {
  if (!process.stdout.isTTY) return [];
  const promise = registerRequest(
    'mime-list',
    undefined,
    options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  );
  (options.stdoutWrite ?? defaultStdoutWrite)(
    buildTerminalClipboardRequest({ type: 'read' }, Buffer.from('.'))
  );
  try {
    const buffer = await promise;
    return buffer
      .toString('utf8')
      .split(/\s+/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Ask the terminal for the bytes of a specific clipboard MIME type. Returns
 * `null` when the terminal does not support the protocol, the user denied
 * the read, or the request timed out.
 */
export async function requestTerminalClipboardData(
  mimeType: string,
  options: TerminalClipboardRequestOptions = {}
): Promise<Buffer | null> {
  if (!process.stdout.isTTY) return null;
  const promise = registerRequest(
    'data',
    mimeType,
    options.timeoutMs ?? DEFAULT_DATA_TIMEOUT_MS,
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  );
  (options.stdoutWrite ?? defaultStdoutWrite)(
    buildTerminalClipboardRequest({ type: 'read' }, Buffer.from(mimeType))
  );
  try {
    return await promise;
  } catch {
    return null;
  }
}

// Per-process buffer for incomplete OSC 5522 packets across stdin chunks.
let streamBuffer = '';

/**
 * Reset the streaming extractor buffer. Used by tests and by KeypressProvider
 * teardown so a stale partial packet from a previous mount does not leak.
 */
export function resetTerminalClipboardExtractorState(): void {
  streamBuffer = '';
}

/**
 * Reject every pending terminal clipboard request. Used during teardown to
 * avoid leaking unresolved promises when the TUI closes mid-flight.
 */
export function rejectPendingTerminalClipboardRequests(reason: string): void {
  if (pendingRequest) finalizePending(pendingRequest, new Error(reason));
}

function findOscTerminator(
  data: string,
  start: number
): { index: number; length: number } | null {
  for (let i = start; i < data.length; i++) {
    if (data[i] === OSC_BEL) return { index: i, length: 1 };
    if (data[i] === '\x1b' && data[i + 1] === '\\') {
      return { index: i, length: OSC_ST_PREFIX.length };
    }
  }
  return null;
}

function findTrailingOsc5522PrefixFragment(data: string): string {
  const maxLength = Math.min(data.length, OSC_5522_PREFIX_STR.length - 1);
  for (let length = maxLength; length > 1; length--) {
    const fragment = data.slice(-length);
    if (OSC_5522_PREFIX_STR.startsWith(fragment)) return fragment;
  }
  return '';
}

function bufferIncompletePacket(packet: string): void {
  if (packet.length > MAX_INCOMPLETE_PACKET_CHARS) {
    streamBuffer = '';
    return;
  }
  streamBuffer = packet;
}

/**
 * Streaming extractor: given a raw stdin chunk, returns the same data with
 * complete OSC 5522 packets removed and dispatched to pending requests.
 * Incomplete packets are buffered across calls via module-local state.
 */
export function extractTerminalClipboardPackets(data: string): {
  cleaned: string;
  dispatched: number;
} {
  let combined = streamBuffer + data;
  streamBuffer = '';
  let cleaned = '';
  let dispatched = 0;

  while (combined.length > 0) {
    const prefix = combined.indexOf(OSC_5522_PREFIX_STR);
    if (prefix === -1) {
      const trailingPrefixFragment =
        findTrailingOsc5522PrefixFragment(combined);
      if (trailingPrefixFragment.length > 0) {
        cleaned += combined.slice(0, -trailingPrefixFragment.length);
        streamBuffer = trailingPrefixFragment;
      } else {
        cleaned += combined;
      }
      break;
    }
    if (prefix > 0) cleaned += combined.slice(0, prefix);

    const bodyStart = prefix + OSC_5522_PREFIX_STR.length;
    const terminator = findOscTerminator(combined, bodyStart);
    if (!terminator) {
      // Incomplete packet — buffer the rest for the next chunk.
      bufferIncompletePacket(combined.slice(prefix));
      return { cleaned, dispatched };
    }

    processTerminalClipboardPacket(
      parseTerminalClipboardBody(combined.slice(bodyStart, terminator.index))
    );
    dispatched++;
    combined = combined.slice(terminator.index + terminator.length);
  }

  return { cleaned, dispatched };
}
