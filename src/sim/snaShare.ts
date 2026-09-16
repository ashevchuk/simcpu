/**
 * `#sna=…` share links for Spectrum snapshots (deflate + base64url).
 */

import { isSna128 } from '../machine/spectrum/sna.js';

const MAX_RAW = Math.floor(1.5 * 1024 * 1024);

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deflateBytes(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const stream = new Blob([ab]).stream().pipeThrough(new CompressionStream('deflate'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

async function inflateBytes(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const stream = new Blob([ab]).stream().pipeThrough(new DecompressionStream('deflate'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

export type SnaShareEncode =
  | { ok: true; hash: string }
  | { ok: false; reason: 'too-large'; size: number };

/** Build `#sna=z…` (deflate) or `#sna=b…` (raw). */
export async function encodeSnaHash(sna: Uint8Array): Promise<SnaShareEncode> {
  if (sna.length > MAX_RAW) return { ok: false, reason: 'too-large', size: sna.length };
  const compressed = await deflateBytes(sna);
  if (compressed && compressed.length < sna.length) {
    return { ok: true, hash: `#sna=z${bytesToBase64Url(compressed)}` };
  }
  return { ok: true, hash: `#sna=b${bytesToBase64Url(sna)}` };
}

/** Parse `#sna=…` into snapshot bytes, or null. */
export async function decodeSnaHash(hash: string): Promise<Uint8Array | null> {
  if (!hash.startsWith('#sna=')) return null;
  const payload = hash.slice(5);
  if (payload.length < 2) return null;
  const kind = payload[0];
  const body = payload.slice(1);
  try {
    let bytes = base64UrlToBytes(body);
    if (kind === 'z') {
      const inflated = await inflateBytes(bytes);
      if (!inflated) return null;
      bytes = inflated;
    } else if (kind !== 'b') {
      bytes = base64UrlToBytes(payload);
    }
    if (bytes.length < 27) return null;
    // Accept 48K or 128K SNA sizes loosely
    void isSna128(bytes);
    return bytes;
  } catch {
    return null;
  }
}
