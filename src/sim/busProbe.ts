/**
 * Decode a bus-probe pin stack into an unsigned value + display string.
 * Bit `b0` is LSB. Any floating/contended bit makes the value undefined.
 */

import type { Level } from './types.js';

export interface BusProbeDecode {
  /** Unsigned value when every bit is driven 0/1; else null. */
  value: number | null;
  /** Per-bit chars '0'/'1'/'Z'/'X' (X = contended), MSB … LSB left→right. */
  bitsMsbFirst: string;
  /** Formatted for the chosen radix (`??` / mixed when incomplete). */
  text: string;
}

export function decodeBusProbe(
  levels: Array<{ level: Level; contended: boolean }>,
  radix: 'hex' | 'dec' | 'bin',
): BusProbeDecode {
  const n = levels.length;
  let value = 0;
  let ok = true;
  const bitChars: string[] = [];
  for (let i = 0; i < n; i++) {
    const { level, contended } = levels[i]!;
    let ch: string;
    if (contended) {
      ch = 'X';
      ok = false;
    } else if (level === 1) {
      ch = '1';
      value |= 1 << i;
    } else if (level === 0) {
      ch = '0';
    } else {
      ch = 'Z';
      ok = false;
    }
    bitChars.push(ch);
  }
  const bitsMsbFirst = bitChars.reverse().join('');
  let text: string;
  if (!ok) {
    if (radix === 'bin') text = bitsMsbFirst;
    else text = '?'.repeat(radix === 'hex' ? Math.max(1, Math.ceil(n / 4)) : 1);
  } else if (radix === 'hex') {
    const digits = Math.max(1, Math.ceil(n / 4));
    text = value.toString(16).toUpperCase().padStart(digits, '0');
  } else if (radix === 'dec') {
    text = String(value);
  } else {
    text = value.toString(2).padStart(n, '0');
  }
  return { value: ok ? value : null, bitsMsbFirst, text };
}
