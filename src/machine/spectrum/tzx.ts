/**
 * ZX Spectrum .TZX tape: extract flash-loadable TAP-style blocks.
 * Supports: ID 10 (standard speed data), ID 11 (turbo — treat payload as TAP block),
 * ID 30/32 text (skip), ID 20/21/22 pause/group (skip), ID 2A stop48 (skip).
 */

import { type TapBlock, SpectrumTape } from './tap.js';

function u16le(b: Uint8Array, i: number): number {
  return (b[i]! | (b[i + 1]! << 8)) & 0xffff;
}

function u24le(b: Uint8Array, i: number): number {
  return (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)) >>> 0;
}

/** Convert a flag+data+checksum chunk (TAP body without length prefix) into a TapBlock. */
function chunkToTapBlock(chunk: Uint8Array): TapBlock {
  if (chunk.length < 2) throw new Error('TZX data block too short');
  const flag = chunk[0]!;
  const data = chunk.subarray(1, chunk.length - 1);
  return { flag, data: data.slice() };
}

/**
 * Parse .TZX into TAP-compatible blocks for LD-BYTES flash-load.
 * Optional `warnings` collects skipped / timing-ignored block notes.
 */
export function parseTzxToTapBlocks(bytes: Uint8Array, warnings?: string[]): TapBlock[] {
  if (bytes.length < 10) throw new Error('TZX too short');
  const magic = String.fromCharCode(...bytes.subarray(0, 7));
  if (magic !== 'ZXTape!') throw new Error('Not a TZX file (missing ZXTape! signature)');
  if (bytes[7] !== 0x1a) throw new Error('TZX bad signature terminator');

  const out: TapBlock[] = [];
  let i = 10; // after header (sig 8 + major/minor 2)

  while (i < bytes.length) {
    const id = bytes[i++]!;
    switch (id) {
      case 0x10: {
        // Standard speed data: pause(2) + len(2) + data
        if (i + 4 > bytes.length) throw new Error('TZX ID10 truncated');
        i += 2; // pause
        const len = u16le(bytes, i);
        i += 2;
        if (i + len > bytes.length) throw new Error('TZX ID10 data truncated');
        out.push(chunkToTapBlock(bytes.subarray(i, i + len)));
        i += len;
        break;
      }
      case 0x11: {
        // Turbo: 15 word params + pause + len24 + data — we only need the payload
        if (i + 19 > bytes.length) throw new Error('TZX ID11 truncated header');
        i += 15; // pulse timings
        i += 2; // pause
        const len = u24le(bytes, i);
        i += 3;
        if (i + len > bytes.length) throw new Error('TZX ID11 data truncated');
        out.push(chunkToTapBlock(bytes.subarray(i, i + len)));
        i += len;
        warnings?.push('TZX ID 0x11 turbo: payload flash-loaded (timings ignored)');
        break;
      }
      case 0x12: // pure tone
        i += 4;
        break;
      case 0x13: {
        // pulse sequence
        if (i >= bytes.length) throw new Error('TZX ID13 truncated');
        const n = bytes[i++]!;
        i += n * 2;
        break;
      }
      case 0x14: {
        // Pure data block (similar usable payload)
        if (i + 10 > bytes.length) throw new Error('TZX ID14 truncated');
        i += 7; // zero/one pulse + used bits + pause
        const len = u24le(bytes, i);
        i += 3;
        if (i + len > bytes.length) throw new Error('TZX ID14 data truncated');
        out.push(chunkToTapBlock(bytes.subarray(i, i + len)));
        i += len;
        break;
      }
      case 0x15: {
        // Direct recording — skip (not flash-loadable)
        if (i + 6 > bytes.length) throw new Error('TZX ID15 truncated');
        i += 2; // pause
        i += 1; // used bits
        const len = u24le(bytes, i);
        i += 3 + len;
        warnings?.push('Skipped TZX ID 0x15 (direct recording — not flash-loadable)');
        break;
      }
      case 0x18:
      case 0x19: {
        // CSW / generalized — skip whole block by length prefix
        if (i + 4 > bytes.length) throw new Error(`TZX ID${id.toString(16)} truncated`);
        const len = (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0;
        i += 4 + len;
        warnings?.push(
          `Skipped TZX ID 0x${id.toString(16)} (${id === 0x18 ? 'CSW' : 'generalized'} — not flash-loadable)`,
        );
        break;
      }
      case 0x20: // pause / stop tape
        i += 2;
        break;
      case 0x21: {
        // group start
        if (i >= bytes.length) throw new Error('TZX ID21 truncated');
        const n = bytes[i++]!;
        i += n;
        break;
      }
      case 0x22: // group end
        break;
      case 0x23: // jump
        i += 2;
        break;
      case 0x24: // loop start
        i += 2;
        break;
      case 0x25: // loop end
        break;
      case 0x26: {
        // call sequence
        if (i + 2 > bytes.length) throw new Error('TZX ID26 truncated');
        const n = u16le(bytes, i);
        i += 2 + n * 2;
        break;
      }
      case 0x27: // return
        break;
      case 0x28: {
        // select block
        if (i + 2 > bytes.length) throw new Error('TZX ID28 truncated');
        const len = u16le(bytes, i);
        i += 2 + len;
        break;
      }
      case 0x2a: // stop if 48K
        i += 4;
        break;
      case 0x2b: // set signal level
        i += 5;
        break;
      case 0x30: {
        if (i >= bytes.length) throw new Error('TZX ID30 truncated');
        const n = bytes[i++]!;
        i += n;
        break;
      }
      case 0x31: {
        if (i + 1 >= bytes.length) throw new Error('TZX ID31 truncated');
        i += 1; // time
        const n = bytes[i++]!;
        i += n;
        break;
      }
      case 0x32: {
        if (i + 2 > bytes.length) throw new Error('TZX ID32 truncated');
        const len = u16le(bytes, i);
        i += 2 + len;
        break;
      }
      case 0x33: {
        if (i >= bytes.length) throw new Error('TZX ID33 truncated');
        const n = bytes[i++]!;
        i += n * 3;
        break;
      }
      case 0x35: {
        // custom info
        i += 10;
        if (i + 4 > bytes.length) throw new Error('TZX ID35 truncated');
        const len = (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0;
        i += 4 + len;
        break;
      }
      case 0x5a: // glue / "XTape!"
        i += 9;
        break;
      default:
        throw new Error(`Unsupported TZX block ID 0x${id.toString(16)} at offset ${i - 1}`);
    }
  }

  return out;
}

export function SpectrumTapeFromTzx(bytes: Uint8Array, warnings?: string[]): SpectrumTape {
  const blocks = parseTzxToTapBlocks(bytes, warnings);
  if (blocks.length === 0) throw new Error('TZX contains no loadable data blocks');
  return new SpectrumTape(blocks);
}

/** Minimal TZX (v1.20) wrapping one standard-speed TAP-style chunk for tests. */
export function buildMinimalTzx(tapChunkBody: Uint8Array, pauseMs = 1000): Uint8Array {
  const header = new Uint8Array(10);
  header.set(new TextEncoder().encode('ZXTape!'));
  header[7] = 0x1a;
  header[8] = 1;
  header[9] = 20;
  const block = new Uint8Array(1 + 2 + 2 + tapChunkBody.length);
  block[0] = 0x10;
  block[1] = pauseMs & 0xff;
  block[2] = (pauseMs >> 8) & 0xff;
  block[3] = tapChunkBody.length & 0xff;
  block[4] = (tapChunkBody.length >> 8) & 0xff;
  block.set(tapChunkBody, 5);
  const out = new Uint8Array(header.length + block.length);
  out.set(header);
  out.set(block, header.length);
  return out;
}
