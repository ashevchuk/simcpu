/**
 * In-canvas first-run tutorial: place button → LED → wire → toggle.
 * Advances by detecting circuit state; latch example remains a separate Help entry.
 */

import type { Circuit } from '../sim/Circuit.js';

export type TutorialHint = 'place-button' | 'place-led' | 'wire' | 'toggle' | null;

const STEPS: { hint: TutorialHint; title: string; body: string }[] = [
  {
    hint: 'place-button',
    title: '1 · Place a button',
    body: 'Place → Button (or press B), then click the canvas.',
  },
  {
    hint: 'place-led',
    title: '2 · Place an LED',
    body: 'Place → LED (or press E), then click near the button.',
  },
  {
    hint: 'wire',
    title: '3 · Wire them',
    body: 'Switch to Wire (3). Click the button OUT pin, then the LED IN pin.',
  },
  {
    hint: 'toggle',
    title: '4 · Toggle',
    body: 'Select tool (1), then click the button to flip it. Watch the LED.',
  },
];

let stylesInjected = false;

function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .sim-tutorial {
      position: absolute;
      left: 12px;
      right: 12px;
      bottom: 12px;
      z-index: 40;
      display: flex;
      align-items: flex-end;
      pointer-events: none;
    }
    .sim-tutorial[hidden] { display: none !important; }
    .sim-tutorial-card {
      pointer-events: auto;
      max-width: min(420px, 92vw);
      background: #171a22ee;
      border: 1px solid #303646;
      border-radius: 10px;
      padding: 12px 14px;
      color: #e7e9ef;
      box-shadow: 0 10px 28px rgba(0,0,0,0.45);
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }
    .sim-tutorial-card h3 {
      margin: 0 0 4px;
      font: 600 14px/1.2 inherit;
      color: var(--accent, #f5c518);
    }
    .sim-tutorial-card p { margin: 0 0 10px; color: #c5cad6; }
    .sim-tutorial-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .sim-tutorial-actions button {
      background: #191c25;
      color: #e7e9ef;
      border: 1px solid #262b36;
      border-radius: 6px;
      padding: 5px 12px;
      cursor: pointer;
      font: 12px ui-monospace, monospace;
    }
    .sim-tutorial-actions button.primary {
      background: var(--accent, #f5c518);
      color: #14161d;
      border-color: var(--accent, #f5c518);
      font-weight: 600;
    }
    .sim-tutorial-actions button:hover { filter: brightness(1.06); }
  `;
  document.head.appendChild(style);
}

export class Tutorial {
  private root: HTMLDivElement;
  private titleEl: HTMLHeadingElement;
  private bodyEl: HTMLParagraphElement;
  private step = -1;
  private buttonSnapshot = new Map<string, number>();
  onHintChange: ((hint: TutorialHint) => void) | null = null;
  onDone: (() => void) | null = null;

  constructor(host: HTMLElement) {
    ensureStyles();
    this.root = document.createElement('div');
    this.root.className = 'sim-tutorial';
    this.root.hidden = true;
    const card = document.createElement('div');
    card.className = 'sim-tutorial-card';
    this.titleEl = document.createElement('h3');
    this.bodyEl = document.createElement('p');
    const actions = document.createElement('div');
    actions.className = 'sim-tutorial-actions';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.textContent = 'Skip';
    skip.addEventListener('click', () => this.stop());
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'primary';
    next.textContent = 'Next';
    next.addEventListener('click', () => this.advance());
    actions.append(skip, next);
    card.append(this.titleEl, this.bodyEl, actions);
    this.root.appendChild(card);
    host.appendChild(this.root);
  }

  get active(): boolean {
    return this.step >= 0;
  }

  get hint(): TutorialHint {
    return this.step >= 0 && this.step < STEPS.length ? STEPS[this.step]!.hint : null;
  }

  start(): void {
    this.step = 0;
    this.buttonSnapshot.clear();
    this.root.hidden = false;
    this.renderStep();
  }

  stop(): void {
    this.step = -1;
    this.root.hidden = true;
    this.onHintChange?.(null);
    this.onDone?.();
  }

  /** Call each frame (or on structure change) to auto-advance. */
  tick(circuit: Circuit): void {
    if (this.step < 0 || this.step >= STEPS.length) return;
    const comps = [...circuit.components.values()];
    const buttons = comps.filter((c) => c.kind === 'button');
    const leds = comps.filter((c) => c.kind === 'led');

    if (this.step === 0 && buttons.length > 0) {
      this.advance(circuit);
      return;
    }
    if (this.step === 1 && leds.length > 0) {
      this.advance(circuit);
      return;
    }
    if (this.step === 2 && buttons.length > 0 && leds.length > 0) {
      const btnPins = new Set(buttons.flatMap((b) => Object.values(b.pins).map((p) => p.id)));
      const ledPins = new Set(leds.flatMap((l) => Object.values(l.pins).map((p) => p.id)));
      for (const w of circuit.wires.values()) {
        const aBtn = btnPins.has(w.a);
        const bBtn = btnPins.has(w.b);
        const aLed = ledPins.has(w.a);
        const bLed = ledPins.has(w.b);
        if ((aBtn && bLed) || (bBtn && aLed)) {
          this.advance(circuit);
          return;
        }
      }
    }
    if (this.step === 3) {
      if (this.buttonSnapshot.size === 0) this.captureButtonValues(circuit);
      for (const c of buttons) {
        if (c.kind !== 'button') continue;
        const prev = this.buttonSnapshot.get(c.id);
        if (prev !== undefined && prev !== c.value) {
          this.advance(circuit);
          return;
        }
      }
    }
  }

  private captureButtonValues(circuit: Circuit): void {
    this.buttonSnapshot.clear();
    for (const c of circuit.components.values()) {
      if (c.kind === 'button') this.buttonSnapshot.set(c.id, c.value);
    }
  }

  private advance(circuit?: Circuit): void {
    if (this.step < 0) return;
    this.step += 1;
    if (this.step >= STEPS.length) {
      this.titleEl.textContent = 'Done';
      this.bodyEl.textContent = 'You built a live loop. Press ? for shortcuts, or try Help → Tutorial (latch).';
      this.onHintChange?.(null);
      setTimeout(() => this.stop(), 2800);
      return;
    }
    if (this.step === 3 && circuit) this.captureButtonValues(circuit);
    this.renderStep();
  }

  private renderStep(): void {
    const s = STEPS[this.step];
    if (!s) return;
    this.titleEl.textContent = s.title;
    this.bodyEl.textContent = s.body;
    this.onHintChange?.(s.hint);
  }
}
