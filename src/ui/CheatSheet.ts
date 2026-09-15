/**
 * Keyboard cheat-sheet overlay (?). z-index above float-wins, below dialogs.
 */

let root: HTMLDivElement | null = null;

const SECTIONS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Tools',
    rows: [
      ['1 / 2 / 3', 'Select / Pan / Wire'],
      ['4–9, B, E, K, O', 'Place devices'],
      ['Space + drag', 'Pan'],
      ['Wheel', 'Zoom'],
      ['F / 0', 'Fit / 1:1'],
    ],
  },
  {
    title: 'Edit',
    rows: [
      ['R / Shift+R', 'Rotate CW / CCW'],
      ['M / Shift+M', 'Flip H / Flip V'],
      ['T', 'Tidy selected wires'],
      ['H', 'Highlight net'],
      ['Delete', 'Delete selection'],
      ['Ctrl+Z / Y', 'Undo / Redo'],
      ['Ctrl+C / V / D', 'Copy / Paste / Duplicate'],
      ['Arrows', 'Nudge 1 grid'],
      ['Alt+arrows', 'Align selection'],
    ],
  },
  {
    title: 'Hierarchy & nets',
    rows: [
      ['Ctrl+G / Shift+G', 'Fold / Unfold'],
      ['Ctrl+F', 'Find'],
      ['Ctrl+R', 'Rename net'],
      ['Dblclick chip', 'Dive in'],
      ['Esc', 'Cancel wire / dive out'],
      ['?', 'This cheat sheet'],
    ],
  },
];

function ensure(): HTMLDivElement {
  if (root) return root;
  const style = document.createElement('style');
  style.textContent = `
    .z80-cheat {
      position: fixed;
      inset: 0;
      z-index: 5300;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(8, 10, 14, 0.55);
      backdrop-filter: blur(4px);
    }
    .z80-cheat[hidden] { display: none !important; }
    .z80-cheat-panel {
      width: min(92vw, 520px);
      max-height: min(84vh, 640px);
      overflow: auto;
      background: #171a22;
      border: 1px solid #303646;
      border-radius: 12px;
      box-shadow: 0 20px 48px rgba(0,0,0,0.55);
      padding: 16px 18px 18px;
      color: #e7e9ef;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }
    .z80-cheat-panel h2 {
      margin: 0 0 12px;
      font: 600 15px/1.2 inherit;
    }
    .z80-cheat-sec { margin-top: 12px; }
    .z80-cheat-sec h3 {
      margin: 0 0 6px;
      font: 10px/1.2 ui-monospace, monospace;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #6b7285;
    }
    .z80-cheat-row {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 8px;
      padding: 3px 0;
      font-size: 12.5px;
    }
    .z80-cheat-row .k {
      font: 12px ui-monospace, monospace;
      color: #f5c518;
    }
    .z80-cheat-row .v { color: #9aa1b3; }
    .z80-cheat-close {
      float: right;
      background: #252b3a;
      border: none;
      color: #e7e9ef;
      border-radius: 6px;
      padding: 4px 10px;
      cursor: pointer;
      font: 12px inherit;
    }
  `;
  document.head.appendChild(style);
  root = document.createElement('div');
  root.className = 'z80-cheat';
  root.hidden = true;
  root.addEventListener('click', (ev) => {
    if (ev.target === root) hideCheatSheet();
  });
  document.body.appendChild(root);
  return root;
}

export function showCheatSheet(): void {
  const el = ensure();
  const panel = document.createElement('div');
  panel.className = 'z80-cheat-panel';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'z80-cheat-close';
  close.textContent = 'Close';
  close.addEventListener('click', hideCheatSheet);
  const h2 = document.createElement('h2');
  h2.textContent = 'Keyboard shortcuts';
  panel.append(close, h2);
  for (const sec of SECTIONS) {
    const wrap = document.createElement('div');
    wrap.className = 'z80-cheat-sec';
    const h3 = document.createElement('h3');
    h3.textContent = sec.title;
    wrap.appendChild(h3);
    for (const [k, v] of sec.rows) {
      const row = document.createElement('div');
      row.className = 'z80-cheat-row';
      row.innerHTML = `<span class="k">${k}</span><span class="v">${v}</span>`;
      wrap.appendChild(row);
    }
    panel.appendChild(wrap);
  }
  el.replaceChildren(panel);
  el.hidden = false;
}

export function hideCheatSheet(): void {
  if (root) root.hidden = true;
}

export function toggleCheatSheet(): void {
  const el = ensure();
  if (el.hidden) showCheatSheet();
  else hideCheatSheet();
}

export function cheatSheetOpen(): boolean {
  return !!root && !root.hidden;
}
