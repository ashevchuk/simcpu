/**
 * Soft ZX Spectrum ULA: port 0xFE border + keyboard matrix.
 * Half-rows: bit0 of high address selects which of 8 rows to read (active-low keys).
 */

/** Spectrum ink/paper/border palette (classic). */
export const SPECTRUM_COLORS: readonly [number, number, number][] = [
  [0x00, 0x00, 0x00], // 0 black
  [0x00, 0x00, 0xd7], // 1 blue
  [0xd7, 0x00, 0x00], // 2 red
  [0xd7, 0x00, 0xd7], // 3 magenta
  [0x00, 0xd7, 0x00], // 4 green
  [0x00, 0xd7, 0xd7], // 5 cyan
  [0xd7, 0xd7, 0x00], // 6 yellow
  [0xd7, 0xd7, 0xd7], // 7 white
];

export const SPECTRUM_BRIGHT: readonly [number, number, number][] = [
  [0x00, 0x00, 0x00],
  [0x00, 0x00, 0xff],
  [0xff, 0x00, 0x00],
  [0xff, 0x00, 0xff],
  [0x00, 0xff, 0x00],
  [0x00, 0xff, 0xff],
  [0xff, 0xff, 0x00],
  [0xff, 0xff, 0xff],
];

/**
 * Half-row layout (bits 0–4), active-low when pressed.
 * Index = which A8–A15 line is low (0 = A8, … 7 = A15).
 */
export const SPECTRUM_KEY_ROWS: readonly (readonly string[])[] = [
  ['Shift', 'Z', 'X', 'C', 'V'], // A8
  ['A', 'S', 'D', 'F', 'G'], // A9
  ['Q', 'W', 'E', 'R', 'T'], // A10
  ['1', '2', '3', '4', '5'], // A11
  ['0', '9', '8', '7', '6'], // A12
  ['P', 'O', 'I', 'U', 'Y'], // A13
  ['Enter', 'L', 'K', 'J', 'H'], // A14
  ['Space', 'Sym', 'M', 'N', 'B'], // A15
];

export class SpectrumUla {
  /** Border colour 0–7. */
  border = 7;
  /** 8 half-rows; bits 0–4 = keys (1 = up, 0 = pressed). Bits 5–7 unused high. */
  readonly rows = new Uint8Array(8).fill(0x1f);
  /** Kempston joystick bits: 0 R, 1 L, 2 D, 3 U, 4 fire. */
  kempston = 0;
  /** Frame IRQ pending until CPU accepts IM1. */
  irqPending = false;
  /** Last EAR bit for soft beeper. */
  earBit = false;
  /** Progress within current audio frame (0..1) for beeper edge timing. */
  beeperProgress = 0;
  /** EAR at frame start + transitions for square-wave beeper mix. */
  private earAtFrameStart = false;
  readonly earTransitions: { frac: number; bit: boolean }[] = [];

  reset(): void {
    this.border = 7;
    this.rows.fill(0x1f);
    this.kempston = 0;
    this.irqPending = false;
    this.earBit = false;
    this.beeperProgress = 0;
    this.earAtFrameStart = false;
    this.earTransitions.length = 0;
  }

  /** Called at start of each soft audio frame. */
  beginBeeperFrame(): void {
    this.earAtFrameStart = this.earBit;
    this.earTransitions.length = 0;
    this.beeperProgress = 0;
  }

  setBeeperProgress(frac: number): void {
    this.beeperProgress = Math.min(1, Math.max(0, frac));
  }

  /** Beeper waveform segments for Web Audio (start + edges sorted by frac). */
  beeperSegments(): { startEar: boolean; transitions: readonly { frac: number; bit: boolean }[] } {
    return { startEar: this.earAtFrameStart, transitions: this.earTransitions };
  }

  pulseFrameIrq(): void {
    this.irqPending = true;
  }

  clearIrq(): void {
    this.irqPending = false;
  }

  /** Release all keys. */
  clearKeys(): void {
    this.rows.fill(0x1f);
    this.kempston = 0;
  }

  /**
   * Set/clear a matrix key by label (case-insensitive).
   * Labels: letters, digits, Enter, Space, Shift (Caps), Sym (Symbol Shift).
   */
  setKey(label: string, down: boolean): void {
    const name = normalizeKeyLabel(label);
    for (let r = 0; r < 8; r++) {
      const row = SPECTRUM_KEY_ROWS[r]!;
      for (let b = 0; b < 5; b++) {
        if (row[b]!.toLowerCase() === name) {
          if (down) this.rows[r]! &= ~(1 << b);
          else this.rows[r]! |= 1 << b;
          return;
        }
      }
    }
  }

  /** Kempston bit: 0=right 1=left 2=down 3=up 4=fire. */
  setKempston(bit: 0 | 1 | 2 | 3 | 4, down: boolean): void {
    if (down) this.kempston |= 1 << bit;
    else this.kempston &= ~(1 << bit);
  }

  portOut(port: number, val: number): void {
    if ((port & 0xff) !== 0xfe) return;
    this.border = val & 7;
    const newEar = (val & 0x10) !== 0;
    if (newEar !== this.earBit) {
      this.earTransitions.push({ frac: this.beeperProgress, bit: newEar });
      this.earBit = newEar;
    }
  }

  portIn(port: number): number {
    const lo = port & 0xff;
    // Kempston joystick at 0x1F (common games / redefine menus)
    if (lo === 0x1f) return this.kempston & 0x1f;
    // Keyboard responds when A0 of low byte is 0 (port xxxFE)
    if ((port & 0x01) !== 0) return 0xff;
    let result = 0x1f;
    const hi = (port >> 8) & 0xff;
    for (let r = 0; r < 8; r++) {
      if (((hi >> r) & 1) === 0) result &= this.rows[r]!;
    }
    // bit5 = 1 (EAR high / no tape), bits 6–7 high
    return 0xe0 | (result & 0x1f);
  }
}

function normalizeKeyLabel(label: string): string {
  const t = label.trim().toLowerCase();
  if (t === 'caps' || t === 'capsshift' || t === 'caps shift') return 'shift';
  if (t === 'symbol' || t === 'symbolshift' || t === 'symbol shift' || t === 'ss') return 'sym';
  if (t === 'return') return 'enter';
  return t;
}

/**
 * Map a browser key to one or more Spectrum matrix labels.
 * Prefer `code` for letters/digits so Shift+5 stays "5" (Caps+5 = cursor left),
 * not "%" from `key`.
 * Backspace/Delete → Caps Shift + 0 (DELETE).
 * Arrows → Caps + 5/6/7/8 (cursor).
 */
export function mapBrowserKeyToSpectrum(key: string, code: string): string | string[] | null {
  if (key === 'Enter' || code === 'Enter' || code === 'NumpadEnter') return 'Enter';
  if (key === ' ' || code === 'Space') return 'Space';
  if (key === 'Shift' || code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
  if (key === 'Backspace' || key === 'Delete' || code === 'Backspace' || code === 'Delete') {
    return ['Shift', '0'];
  }
  if (code === 'ControlLeft' || code === 'ControlRight' || key === 'Control') return 'Sym';
  if (key === 'ArrowLeft' || code === 'ArrowLeft') return ['Shift', '5'];
  if (key === 'ArrowDown' || code === 'ArrowDown') return ['Shift', '6'];
  if (key === 'ArrowUp' || code === 'ArrowUp') return ['Shift', '7'];
  if (key === 'ArrowRight' || code === 'ArrowRight') return ['Shift', '8'];

  // Digit0–9 / KeyA–Z — stable under Shift / Caps Lock
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  if (code.startsWith('Numpad') && code.length === 7 && code[6]! >= '0' && code[6]! <= '9') {
    return code.slice(6);
  }
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);

  if (key.length === 1) {
    const c = key.toUpperCase();
    if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
  }
  return null;
}
