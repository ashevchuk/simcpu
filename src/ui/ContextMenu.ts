/**
 * Lightweight right-click menu. Mounted on document.body above float-wins
 * but under modal dialogs (z-index 5200).
 */

export interface ContextMenuItem {
  label: string;
  kbd?: string;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
}

let root: HTMLDivElement | null = null;

function ensureRoot(): HTMLDivElement {
  if (root) return root;
  const style = document.createElement('style');
  style.textContent = `
    .z80-ctx {
      position: fixed;
      z-index: 5200;
      min-width: 180px;
      max-width: 280px;
      padding: 4px 0;
      background: #171a22;
      border: 1px solid #303646;
      border-radius: 8px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.55);
      font: 12.5px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: #e7e9ef;
    }
    .z80-ctx button {
      display: flex;
      width: 100%;
      align-items: baseline;
      gap: 10px;
      background: none;
      border: none;
      color: inherit;
      padding: 7px 12px;
      text-align: left;
      cursor: pointer;
      font: inherit;
    }
    .z80-ctx button:hover:not(:disabled) { background: #252b3a; }
    .z80-ctx button:disabled { opacity: 0.4; cursor: default; }
    .z80-ctx button.danger { color: #ff8a8a; }
    .z80-ctx .kbd {
      margin-left: auto;
      color: #6b7285;
      font: 11px ui-monospace, monospace;
    }
    .z80-ctx .sep {
      height: 1px;
      background: #2a3040;
      margin: 4px 8px;
    }
  `;
  document.head.appendChild(style);
  root = document.createElement('div');
  root.className = 'z80-ctx';
  root.hidden = true;
  document.body.appendChild(root);
  return root;
}

export function hideContextMenu(): void {
  if (root) root.hidden = true;
}

export function showContextMenu(clientX: number, clientY: number, items: (ContextMenuItem | 'sep')[]): void {
  const el = ensureRoot();
  el.replaceChildren();
  for (const item of items) {
    if (item === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'sep';
      el.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.disabled = !!item.disabled;
    if (item.danger) btn.classList.add('danger');
    btn.textContent = item.label;
    if (item.kbd) {
      const k = document.createElement('span');
      k.className = 'kbd';
      k.textContent = item.kbd;
      btn.appendChild(k);
    }
    btn.addEventListener('click', () => {
      hideContextMenu();
      item.run();
    });
    el.appendChild(btn);
  }
  el.hidden = false;
  const pad = 8;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = clientX;
  let top = clientY;
  if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
  if (top + h > window.innerHeight - pad) top = window.innerHeight - h - pad;
  el.style.left = `${Math.max(pad, left)}px`;
  el.style.top = `${Math.max(pad, top)}px`;
}

export function contextMenuOpen(): boolean {
  return !!root && !root.hidden;
}
