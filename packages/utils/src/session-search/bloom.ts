import { createHash } from 'crypto';

import { BLOOM_BITS } from './constants';

import type { Bloom } from './types';

const BLOOM_WORDS = BLOOM_BITS / 32;

export function createBloom(): Bloom {
  return new Uint32Array(BLOOM_WORDS);
}

export function bloomFromBase64(base64: string): Bloom {
  const buf = Buffer.from(base64, 'base64');
  const arr = new Uint32Array(
    buf.buffer,
    buf.byteOffset,
    Math.floor(buf.byteLength / 4)
  );
  const out = createBloom();
  out.set(arr.subarray(0, out.length));
  return out;
}

export function bloomToBase64(bloom: Bloom): string {
  return Buffer.from(bloom.buffer, bloom.byteOffset, bloom.byteLength).toString(
    'base64'
  );
}

/**
 * Merge source bloom filter into target (OR operation).
 * This is useful for combining bloom filters from different sources.
 */
export function bloomMerge(target: Bloom, source: Bloom): void {
  for (let i = 0; i < target.length && i < source.length; i++) {
    // eslint-disable-next-line no-bitwise
    target[i] |= source[i];
  }
}

function setBit(bloom: Bloom, bit: number): void {
  // eslint-disable-next-line no-bitwise
  const idx = (bit / 32) | 0;
  // eslint-disable-next-line no-bitwise
  const off = bit & 31;
  // eslint-disable-next-line no-bitwise
  bloom[idx] |= 1 << off;
}

function hasBit(bloom: Bloom, bit: number): boolean {
  // eslint-disable-next-line no-bitwise
  const idx = (bit / 32) | 0;
  // eslint-disable-next-line no-bitwise
  const off = bit & 31;
  // eslint-disable-next-line no-bitwise
  return (bloom[idx] & (1 << off)) !== 0;
}

function hash32(str: string): number {
  // Stable 32-bit from sha1 (cheap enough for our scale, avoids bringing a hash dep)
  const h = createHash('sha1').update(str).digest();
  return h.readUInt32LE(0);
}

function bloomAddToken(bloom: Bloom, token: string): void {
  const h1 = hash32(token);
  // eslint-disable-next-line no-bitwise
  const h2 = (h1 ^ 0x9e3779b9) >>> 0;
  setBit(bloom, h1 % BLOOM_BITS);
  setBit(bloom, h2 % BLOOM_BITS);
}

function bloomHasToken(bloom: Bloom, token: string): boolean {
  const h1 = hash32(token);
  // eslint-disable-next-line no-bitwise
  const h2 = (h1 ^ 0x9e3779b9) >>> 0;
  return hasBit(bloom, h1 % BLOOM_BITS) && hasBit(bloom, h2 % BLOOM_BITS);
}

export function extractTrigrams(text: string): string[] {
  const t = text.toLowerCase();
  if (t.length < 3) return [];
  const out: string[] = [];
  for (let i = 0; i <= t.length - 3; i++) {
    out.push(t.slice(i, i + 3));
  }
  return out;
}

export function bloomAddText(bloom: Bloom, text: string): void {
  const t = text.toLowerCase();
  if (t.length < 3) return;
  for (let i = 0; i <= t.length - 3; i++) {
    bloomAddToken(bloom, t.slice(i, i + 3));
  }
}

export function bloomScoreForQuery(bloom: Bloom, query: string): number {
  const q = query.toLowerCase();
  if (q.length < 3) return 0;
  let hits = 0;
  let total = 0;
  for (let i = 0; i <= q.length - 3; i++) {
    total++;
    if (bloomHasToken(bloom, q.slice(i, i + 3))) hits++;
  }
  return total === 0 ? 0 : hits / total;
}
