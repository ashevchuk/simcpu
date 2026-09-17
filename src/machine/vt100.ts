/**
 * Minimal VT100/ANSI host terminal for soft CP/M console (80×25).
 * Enough for ROGUE-VT / Wanderer / CLS-style ANSI apps.
 */

import { CONSOLE_COLS, CONSOLE_ROWS } from './memoryMap.js';

type EscMode = 'ground' | 'esc' | 'csi' | 'ignore1';

export class Vt100Terminal {
  readonly cols: number;
  readonly rows: number;
  readonly cells: Uint8Array;
  col = 0;
  row = 0;
  private mode: EscMode = 'ground';
  private csi = '';
  private savedCol = 0;
  private savedRow = 0;

  constructor(cols = CONSOLE_COLS, rows = CONSOLE_ROWS) {
    this.cols = cols;
    this.rows = rows;
    this.cells = new Uint8Array(cols * rows).fill(0x20);
  }

  clear(): void {
    this.cells.fill(0x20);
    this.col = 0;
    this.row = 0;
    this.mode = 'ground';
    this.csi = '';
  }

  get cursorIndex(): number {
    return this.row * this.cols + this.col;
  }

  write(ch: number): void {
    const c = ch & 0xff;
    if (this.mode === 'ignore1') {
      this.mode = 'ground';
      return;
    }
    if (this.mode === 'esc') {
      this.handleEsc(c);
      return;
    }
    if (this.mode === 'csi') {
      this.handleCsi(c);
      return;
    }
    if (c === 0x1b) {
      this.mode = 'esc';
      return;
    }
    if (c === 0x07) return; // BEL
    if (c === 0x08 || c === 0x7f) {
      if (this.col > 0) this.col--;
      else if (this.row > 0) {
        this.row--;
        this.col = this.cols - 1;
      }
      this.cells[this.cursorIndex] = 0x20;
      return;
    }
    if (c === 0x0d) {
      this.col = 0;
      return;
    }
    if (c === 0x0a) {
      this.newline();
      return;
    }
    if (c === 0x09) {
      this.col = Math.min(this.cols - 1, (this.col + 8) & ~7);
      return;
    }
    if (c >= 0x20 && c < 0x7f) {
      this.cells[this.cursorIndex] = c;
      this.col++;
      if (this.col >= this.cols) this.newline();
    }
  }

  private handleEsc(c: number): void {
    if (c === 0x5b) {
      this.mode = 'csi';
      this.csi = '';
      return;
    }
    if (c === 0x37) {
      this.savedCol = this.col;
      this.savedRow = this.row;
      this.mode = 'ground';
      return;
    }
    if (c === 0x38) {
      this.col = this.savedCol;
      this.row = this.savedRow;
      this.mode = 'ground';
      return;
    }
    if (c === 0x44) {
      this.newline();
      this.mode = 'ground';
      return;
    }
    if (c === 0x4d) {
      if (this.row > 0) this.row--;
      else this.scrollDown();
      this.mode = 'ground';
      return;
    }
    if (c === 0x45) {
      this.newline();
      this.mode = 'ground';
      return;
    }
    if (c === 0x28 || c === 0x29) {
      this.mode = 'ignore1'; // charset designate + final
      return;
    }
    this.mode = 'ground';
  }

  private handleCsi(c: number): void {
    if ((c >= 0x30 && c <= 0x3f) || c === 0x3b) {
      this.csi += String.fromCharCode(c);
      if (this.csi.length > 32) {
        this.mode = 'ground';
        this.csi = '';
      }
      return;
    }
    // intermediate bytes 0x20–0x2f — ignore / append lightly
    if (c >= 0x20 && c <= 0x2f) {
      this.csi += String.fromCharCode(c);
      return;
    }
    this.dispatchCsi(c);
    this.mode = 'ground';
    this.csi = '';
  }

  private params(): number[] {
    const raw = this.csi.replace(/[^0-9;]/g, '');
    if (!raw) return [];
    return raw.split(';').map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
  }

  private dispatchCsi(final: number): void {
    const p = this.params();
    const n = (i: number, d = 1) => (p[i] && p[i]! > 0 ? p[i]! : d);

    switch (final) {
      case 0x41: // CUU
        this.row = Math.max(0, this.row - n(0));
        break;
      case 0x42: // CUD
        this.row = Math.min(this.rows - 1, this.row + n(0));
        break;
      case 0x43: // CUF
        this.col = Math.min(this.cols - 1, this.col + n(0));
        break;
      case 0x44: // CUB
        this.col = Math.max(0, this.col - n(0));
        break;
      case 0x48: // CUP
      case 0x66: {
        // HVP
        const row = Math.min(this.rows, Math.max(1, n(0, 1))) - 1;
        const col = Math.min(this.cols, Math.max(1, n(1, 1))) - 1;
        this.row = row;
        this.col = col;
        break;
      }
      case 0x4a: {
        // ED
        const mode = p[0] ?? 0;
        if (mode === 2 || mode === 3) this.cells.fill(0x20);
        else if (mode === 1) {
          const end = this.cursorIndex;
          this.cells.fill(0x20, 0, end + 1);
        } else {
          this.cells.fill(0x20, this.cursorIndex);
        }
        break;
      }
      case 0x4b: {
        // EL
        const mode = p[0] ?? 0;
        const rowStart = this.row * this.cols;
        if (mode === 2) this.cells.fill(0x20, rowStart, rowStart + this.cols);
        else if (mode === 1) this.cells.fill(0x20, rowStart, this.cursorIndex + 1);
        else this.cells.fill(0x20, this.cursorIndex, rowStart + this.cols);
        break;
      }
      case 0x6d: // SGR — ignore colors/attrs
        break;
      case 0x68: // SM
      case 0x6c: // RM — ignore cursor show/hide etc.
        break;
      default:
        break;
    }
  }

  private newline(): void {
    this.col = 0;
    this.row++;
    if (this.row >= this.rows) {
      this.scrollUp();
      this.row = this.rows - 1;
    }
  }

  private scrollUp(): void {
    this.cells.copyWithin(0, this.cols);
    this.cells.fill(0x20, this.cells.length - this.cols);
  }

  private scrollDown(): void {
    this.cells.copyWithin(this.cols, 0, this.cells.length - this.cols);
    this.cells.fill(0x20, 0, this.cols);
  }
}
