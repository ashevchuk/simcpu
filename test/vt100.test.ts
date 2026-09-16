import { describe, expect, it } from 'vitest';
import { Vt100Terminal } from '../src/machine/vt100.js';

function writeStr(t: Vt100Terminal, s: string): void {
  for (const ch of s) t.write(ch.charCodeAt(0));
}

function cell(t: Vt100Terminal, col: number, row: number): string {
  return String.fromCharCode(t.cells[row * t.cols + col]!);
}

describe('Vt100Terminal', () => {
  it('writes printable text and CRLF', () => {
    const t = new Vt100Terminal(80, 25);
    writeStr(t, 'Hi\r\nYo');
    expect(cell(t, 0, 0)).toBe('H');
    expect(cell(t, 1, 0)).toBe('i');
    expect(cell(t, 0, 1)).toBe('Y');
  });

  it('handles CUP and clear screen', () => {
    const t = new Vt100Terminal(80, 25);
    writeStr(t, 'XXXX');
    writeStr(t, '\x1b[2J\x1b[H');
    expect(t.cells.every((c) => c === 0x20)).toBe(true);
    expect(t.row).toBe(0);
    expect(t.col).toBe(0);
    writeStr(t, '\x1b[3;5HAB');
    expect(t.row).toBe(2);
    expect(t.col).toBe(6);
    expect(cell(t, 4, 2)).toBe('A');
    expect(cell(t, 5, 2)).toBe('B');
  });

  it('clears to end of line', () => {
    const t = new Vt100Terminal(80, 25);
    writeStr(t, 'ABCDEF');
    writeStr(t, '\x1b[3G\x1b[K');
    // CUB/CHA: ESC [ 3 G is horizontal absolute — we may not implement G
    // Use CUP instead
    t.clear();
    writeStr(t, 'ABCDEF');
    writeStr(t, '\x1b[1;3H\x1b[K');
    expect(cell(t, 0, 0)).toBe('A');
    expect(cell(t, 1, 0)).toBe('B');
    expect(cell(t, 2, 0)).toBe(' ');
    expect(cell(t, 5, 0)).toBe(' ');
  });
});
