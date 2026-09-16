/**
 * On-screen Kempston / Cursor / Sinclair joystick pad for soft Spectrum games.
 */

export type JoyMode = 'kempston' | 'cursor' | 'sinclair';

export type SpectrumJoystickHandlers = {
  kempston: (bit: 0 | 1 | 2 | 3 | 4, down: boolean) => void;
  /** Matrix key label press/release (Cursor / Sinclair). */
  cursorKey: (label: string, down: boolean) => void;
};

const CURSOR_KEYS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: '8', // right
  1: '5', // left
  2: '6', // down
  3: '7', // up
  4: '0', // fire
};

/** Sinclair Interface 2 (right) / common redefine: 6L 7D 8U 9R 0F */
const SINCLAIR_KEYS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: '9', // right
  1: '6', // left
  2: '7', // down
  3: '8', // up
  4: '0', // fire
};

const MODE_CYCLE: JoyMode[] = ['kempston', 'cursor', 'sinclair'];
const MODE_LABEL: Record<JoyMode, string> = {
  kempston: 'Kempston',
  cursor: 'Cursor',
  sinclair: 'Sinclair',
};

export class SpectrumJoystick {
  readonly root: HTMLElement;
  private pressed = new Set<0 | 1 | 2 | 3 | 4>();
  private handlers: SpectrumJoystickHandlers;
  mode: JoyMode = 'kempston';

  constructor(handlers: SpectrumJoystickHandlers) {
    this.handlers = handlers;
    this.root = document.createElement('div');
    this.root.className = 'spec-joy';
    this.root.innerHTML = `
      <div class="spec-joy-title">
        <button type="button" data-act="mode" class="spec-joy-mode" title="Cycle Kempston / Cursor / Sinclair">Kempston</button>
      </div>
      <div class="spec-joy-pad">
        <button type="button" data-bit="3" class="spec-joy-btn spec-joy-up" title="Up">▲</button>
        <button type="button" data-bit="1" class="spec-joy-btn spec-joy-left" title="Left">◀</button>
        <button type="button" data-bit="4" class="spec-joy-btn spec-joy-fire" title="Fire">FIRE</button>
        <button type="button" data-bit="0" class="spec-joy-btn spec-joy-right" title="Right">▶</button>
        <button type="button" data-bit="2" class="spec-joy-btn spec-joy-down" title="Down">▼</button>
      </div>
      <div class="spec-joy-hint">Arrows + Space/Z · cycle mode above</div>
    `;
    this.root.addEventListener('mousedown', (e) => e.preventDefault());
    this.root.querySelector('[data-act="mode"]')!.addEventListener('click', (e) => {
      e.preventDefault();
      this.clear();
      const i = MODE_CYCLE.indexOf(this.mode);
      this.mode = MODE_CYCLE[(i + 1) % MODE_CYCLE.length]!;
      (e.currentTarget as HTMLButtonElement).textContent = MODE_LABEL[this.mode];
    });
    for (const btn of Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-bit]'))) {
      const bit = Number(btn.dataset.bit) as 0 | 1 | 2 | 3 | 4;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.setPointerCapture?.(e.pointerId);
        this.down(bit);
      });
      btn.addEventListener('pointerup', () => this.up(bit));
      btn.addEventListener('pointercancel', () => this.up(bit));
      btn.addEventListener('pointerleave', (e) => {
        if (e.buttons === 0) this.up(bit);
      });
    }
  }

  private apply(bit: 0 | 1 | 2 | 3 | 4, down: boolean): void {
    if (this.mode === 'kempston') this.handlers.kempston(bit, down);
    else if (this.mode === 'cursor') this.handlers.cursorKey(CURSOR_KEYS[bit]!, down);
    else this.handlers.cursorKey(SINCLAIR_KEYS[bit]!, down);
  }

  private down(bit: 0 | 1 | 2 | 3 | 4): void {
    if (this.pressed.has(bit)) return;
    this.pressed.add(bit);
    this.apply(bit, true);
    this.root.querySelector(`[data-bit="${bit}"]`)?.classList.add('is-down');
  }

  private up(bit: 0 | 1 | 2 | 3 | 4): void {
    if (!this.pressed.has(bit)) return;
    this.pressed.delete(bit);
    this.apply(bit, false);
    this.root.querySelector(`[data-bit="${bit}"]`)?.classList.remove('is-down');
  }

  clear(): void {
    for (const bit of [...this.pressed]) this.up(bit);
  }
}
