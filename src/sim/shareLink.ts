/**
 * Share-link encode/decode for `#p=…` hashes.
 * Prefer CompressionStream (deflate); fall back to base64url JSON.
 * No new dependencies.
 */

import type { SerializedProject } from '../sim/serialize.js';

const MAX_RAW_CHARS = Math.floor(1.5 * 1024 * 1024);

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

function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export type ShareEncodeResult =
  | { ok: true; hash: string }
  | { ok: false; reason: 'too-large'; size: number };

/** Build `#p=z…` (deflate) or `#p=b…` (raw base64url JSON). */
export async function encodeShareHash(project: SerializedProject): Promise<ShareEncodeResult> {
  const json = JSON.stringify(project);
  if (json.length > MAX_RAW_CHARS) {
    return { ok: false, reason: 'too-large', size: json.length };
  }
  const raw = utf8Encode(json);
  const compressed = await deflateBytes(raw);
  if (compressed && compressed.length < raw.length) {
    return { ok: true, hash: `#p=z${bytesToBase64Url(compressed)}` };
  }
  return { ok: true, hash: `#p=b${bytesToBase64Url(raw)}` };
}

/** Parse location.hash `#p=…` into a project, or null. */
export async function decodeShareHash(hash: string): Promise<SerializedProject | null> {
  if (!hash.startsWith('#p=')) return null;
  const payload = hash.slice(3);
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
      // Legacy: entire payload is base64url JSON (no kind prefix).
      bytes = base64UrlToBytes(payload);
    }
    const data = JSON.parse(utf8Decode(bytes)) as SerializedProject;
    if (data?.format !== 'z80-sim-project') return null;
    return data;
  } catch {
    return null;
  }
}
