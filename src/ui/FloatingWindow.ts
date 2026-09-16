/**
 * Draggable floating instrument window — replaces the old side-panel chrome.
 * Instruments (memory, analyzer, TTY) mount their UI into `body`.
 */

let stylesInjected = false;

function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .float-win {
      position: fixed;
      z-index: 50; /* stack stays below #chrome (5000) so menus stay on top */
      min-width: 280px;
      max-width: min(92vw, 640px);
      max-height: min(88vh, 720px);
      display: flex;
      flex-direction: column;
      background: #171a22;
      border: 1px solid #303646;
      border-radius: 10px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.04);
      color: #e7e9ef;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      overflow: hidden;
    }
    .float-win.memory-editor {
      max-width: min(96vw, 720px);
      width: min(96vw, 640px);
      height: min(70vh, 480px);
      min-height: 280px;
      max-height: min(92vh, 900px);
      resize: vertical;
    }
    .float-win.machine-panel {
      width: min(96vw, 860px);
      height: min(92vh, 820px);
      min-width: 420px;
      min-height: 320px;
      max-width: min(98vw, 1100px);
      max-height: min(96vh, 960px);
      resize: both;
    }
    .float-win.memory-editor .float-win-body,
    .float-win.machine-panel .float-win-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 0;
      overflow: hidden;
      flex: 1 1 auto;
    }
    .float-win.machine-panel .machine-panel-canvas-wrap {
      flex: 1 1 auto;
      min-height: 140px;
      overflow: auto;
      border: 1px solid #2a3040;
      border-radius: 6px;
      background: #0a0c10;
    }
    .float-win.machine-panel .machine-panel-pane {
      min-height: 0;
      flex: 1 1 auto;
    }
    .float-win.machine-panel .machine-panel-canvas {
      display: block;
      border: none;
      border-radius: 0;
    }
    .float-win[hidden] { display: none !important; }
    .float-win-titlebar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: #12141a;
      border-bottom: 1px solid #2a3040;
      cursor: grab;
      user-select: none;
      flex: 0 0 auto;
    }
    .float-win-titlebar:active { cursor: grabbing; }
    .float-win-title {
      font: 600 12.5px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: #e7e9ef;
    }
    .float-win-meta {
      margin-left: 4px;
      font: 11px ui-monospace, monospace;
      color: #9aa1b3;
    }
    .float-win-close {
      margin-left: auto;
      background: transparent;
      border: none;
      color: #9aa1b3;
      font: 16px/1 sans-serif;
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
    }
    .float-win-close:hover { background: #252b3a; color: #e7e9ef; }
    .float-win-body {
      padding: 10px 12px 12px;
      overflow: auto;
      flex: 1 1 auto;
      min-height: 0;
    }
  `;
  document.head.appendChild(style);
}

let cascade = 0;
/** Rising z-index so the last focused float-win stacks above the others — capped below menubar. */
const FLOAT_Z_MIN = 50;
const FLOAT_Z_MAX = 400;
let stackZ = FLOAT_Z_MIN;

export class FloatingWindow {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly metaEl: HTMLElement;
  private drag: { ox: number; oy: number; left: number; top: number } | null = null;

  constructor(title: string, className = '') {
    ensureStyles();
    this.root = document.createElement('div');
    this.root.className = `float-win${className ? ` ${className}` : ''}`;
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="float-win-titlebar">
        <span class="float-win-title"></span>
        <span class="float-win-meta"></span>
        <button type="button" class="float-win-close" title="Close">×</button>
      </div>
      <div class="float-win-body"></div>
    `;
    this.titleEl = this.root.querySelector('.float-win-title')!;
    this.metaEl = this.root.querySelector('.float-win-meta')!;
    this.body = this.root.querySelector('.float-win-body')!;
    this.titleEl.textContent = title;

    // Capture so a click anywhere in the window (hex grid, inspector fields)
    // raises it before child handlers run.
    this.root.addEventListener('pointerdown', () => this.bringToFront(), true);

    const bar = this.root.querySelector('.float-win-titlebar')!;
    bar.addEventListener('pointerdown', (ev: Event) => {
      const e = ev as PointerEvent;
      if ((e.target as HTMLElement).closest('button')) return;
      this.bringToFront();
      const rect = this.root.getBoundingClientRect();
      this.drag = { ox: e.clientX, oy: e.clientY, left: rect.left, top: rect.top };
      (bar as HTMLElement).setPointerCapture(e.pointerId);
    });
    bar.addEventListener('pointermove', (ev: Event) => {
      if (!this.drag) return;
      const e = ev as PointerEvent;
      const left = this.drag.left + (e.clientX - this.drag.ox);
      const top = this.drag.top + (e.clientY - this.drag.oy);
      this.root.style.left = `${Math.max(8, left)}px`;
      this.root.style.top = `${Math.max(8, top)}px`;
      this.root.style.right = 'auto';
      this.root.style.bottom = 'auto';
    });
    bar.addEventListener('pointerup', () => {
      this.drag = null;
    });
    this.root.querySelector('.float-win-close')!.addEventListener('click', () => this.setVisible(false));

    document.body.appendChild(this.root);
  }

  /** Raise this window above sibling float-wins (never above the menubar). */
  bringToFront(): void {
    stackZ += 1;
    if (stackZ > FLOAT_Z_MAX) stackZ = FLOAT_Z_MIN + 1;
    this.root.style.zIndex = String(stackZ);
  }

  setTitle(title: string, meta = ''): void {
    this.titleEl.textContent = title;
    this.metaEl.textContent = meta;
  }

  setVisible(show: boolean): void {
    if (show && this.root.hidden) {
      cascade = (cascade + 1) % 8;
      const left = 48 + cascade * 28;
      const top = 56 + cascade * 24;
      if (!this.root.style.left) {
        this.root.style.left = `${left}px`;
        this.root.style.top = `${top}px`;
      }
      this.bringToFront();
    } else if (show) {
      this.bringToFront();
    }
    this.root.hidden = !show;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }
}
