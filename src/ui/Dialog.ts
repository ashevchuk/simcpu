/**
 * In-app replacements for window.prompt()/confirm()/alert().
 *
 * Native dialogs are synchronous and *block the page's own event loop* —
 * fine for a human, fatal for anything driving the browser programmatically
 * (a headless test harness, an extension-based automation tool): the tab
 * stops responding to any further command until a human physically clicks
 * the dialog, which a script has no way to do. They're also visibly not
 * part of this app — a plain OS-chrome box dropped on top of a deliberately
 * styled dark canvas. Both problems have the same fix: real DOM, so it's
 * just another element the page's own JS (and anything driving the page)
 * can see and click like any button.
 *
 * Each function returns a Promise instead of blocking — `await` it exactly
 * like the `window.*` call it replaces, same null-for-cancel /
 * string-for-confirmed contract `showPrompt` mirrors from `window.prompt`.
 */

let stylesInjected = false;

/** Injected once, lazily — avoids a `<link>` main.ts would need to remember, and keeps this module a single self-contained file. */
function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .z80-dialog-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }
    .z80-dialog {
      min-width: 320px;
      max-width: 520px;
      background: var(--panel, #14161d);
      border: 1px solid var(--border, #262b36);
      border-radius: 10px;
      padding: 18px 20px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
      color: var(--text, #e7e9ef);
    }
    .z80-dialog p {
      margin: 0 0 14px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .z80-dialog input {
      width: 100%;
      background: var(--panel-2, #191c25);
      color: var(--text, #e7e9ef);
      border: 1px solid var(--border, #262b36);
      border-radius: 6px;
      padding: 7px 9px;
      font: 13px ui-monospace, 'SF Mono', monospace;
      margin-bottom: 16px;
    }
    .z80-dialog input:focus {
      outline: none;
      border-color: var(--accent, #f5c518);
    }
    .z80-dialog .z80-dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .z80-dialog button {
      background: var(--panel-2, #191c25);
      color: var(--text, #e7e9ef);
      border: 1px solid var(--border, #262b36);
      border-radius: 6px;
      padding: 6px 14px;
      cursor: pointer;
      font: 12px ui-monospace, 'SF Mono', monospace;
    }
    .z80-dialog button:hover { background: #20242f; border-color: #333a48; }
    .z80-dialog button.z80-dialog-primary {
      background: var(--accent, #f5c518);
      color: var(--accent-ink, #14161d);
      border-color: var(--accent, #f5c518);
      font-weight: 600;
    }
    .z80-dialog button.z80-dialog-primary:hover { filter: brightness(1.08); }
    .z80-dialog .z80-dialog-choices {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 16px;
      max-height: min(50vh, 320px);
      overflow: auto;
    }
    .z80-dialog .z80-dialog-choice-row {
      display: flex;
      gap: 6px;
      align-items: stretch;
    }
    .z80-dialog .z80-dialog-choice {
      flex: 1;
      text-align: left;
      padding: 8px 12px;
      background: var(--panel-2, #191c25);
      color: var(--text, #e7e9ef);
      border: 1px solid var(--border, #262b36);
      border-radius: 6px;
      cursor: pointer;
      font: 13px ui-monospace, 'SF Mono', monospace;
    }
    .z80-dialog .z80-dialog-choice:hover { background: #20242f; border-color: #333a48; }
    .z80-dialog .z80-dialog-choice:focus {
      outline: none;
      border-color: var(--accent, #f5c518);
    }
    .z80-dialog .z80-dialog-choice.is-current {
      border-color: var(--accent, #f5c518);
      box-shadow: inset 3px 0 0 var(--accent, #f5c518);
    }
    .z80-dialog .z80-dialog-choice-meta {
      display: block;
      margin-top: 2px;
      font-size: 11px;
      color: var(--text-dim, #9aa1b3);
    }
    .z80-dialog .z80-dialog-choice-delete {
      flex-shrink: 0;
      width: 36px;
      background: var(--panel-2, #191c25);
      color: var(--text-dim, #9aa1b3);
      border: 1px solid var(--border, #262b36);
      border-radius: 6px;
      cursor: pointer;
      font: 14px ui-monospace, 'SF Mono', monospace;
    }
    .z80-dialog .z80-dialog-choice-delete:hover {
      color: #ff6b6b;
      border-color: #ff6b6b;
      background: #2a1c22;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Shared plumbing every dialog kind below builds on: overlay, panel,
 * message text, an optional input, and a row of buttons — each button
 * resolves the returned Promise with whatever value it's configured to
 * produce. Escape always resolves with `cancelValue` (matching every
 * native dialog's own Escape behavior); there's no click-outside-to-close,
 * also matching native dialogs, so a stray canvas click behind the modal
 * can't dismiss it by accident.
 */
function openDialog<T>(opts: {
  message: string;
  input?: { defaultValue: string };
  // A button's value can depend on the live input field (OK reading back
  // whatever was typed) rather than being fixed up front — so it's a
  // thunk, called at click/Enter time, not a plain value.
  buttons: { label: string; primary?: boolean; value: (inputValue: string | null) => T }[];
  cancelValue: T;
}): Promise<T> {
  ensureStyles();
  return new Promise<T>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'z80-dialog-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'z80-dialog';
    overlay.appendChild(dialog);

    const p = document.createElement('p');
    p.textContent = opts.message;
    dialog.appendChild(p);

    let inputEl: HTMLInputElement | null = null;
    if (opts.input) {
      inputEl = document.createElement('input');
      inputEl.value = opts.input.defaultValue;
      dialog.appendChild(inputEl);
    }

    const actions = document.createElement('div');
    actions.className = 'z80-dialog-actions';
    dialog.appendChild(actions);

    function close(value: T): void {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve(value);
    }

    function onKeydown(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        close(opts.cancelValue);
      } else if (ev.key === 'Enter' && document.activeElement !== null && dialog.contains(document.activeElement)) {
        // Enter submits the primary button regardless of which field has
        // focus — same as a native dialog's default-button behavior.
        const primary = opts.buttons.find((b) => b.primary) ?? opts.buttons[opts.buttons.length - 1];
        if (primary) {
          ev.preventDefault();
          close(primary.value(inputEl ? inputEl.value : null));
        }
      }
    }

    for (const btn of opts.buttons) {
      const el = document.createElement('button');
      el.textContent = btn.label;
      if (btn.primary) el.className = 'z80-dialog-primary';
      el.addEventListener('click', () => close(btn.value(inputEl ? inputEl.value : null)));
      actions.appendChild(el);
    }

    document.addEventListener('keydown', onKeydown);
    document.body.appendChild(overlay);
    if (inputEl) {
      inputEl.focus();
      inputEl.select();
    } else {
      (dialog.querySelector('button.z80-dialog-primary') as HTMLButtonElement | null)?.focus();
    }
  });
}

/** Drop-in replacement for `window.alert()` — resolves once OK is clicked, Enter, or Escape pressed. */
export function showAlert(message: string): Promise<void> {
  return openDialog<void>({
    message,
    buttons: [{ label: 'OK', primary: true, value: () => undefined }],
    cancelValue: undefined,
  });
}

/** Drop-in replacement for `window.confirm()` — `true` for OK/Enter, `false` for Cancel/Escape. */
export function showConfirm(message: string): Promise<boolean> {
  return openDialog<boolean>({
    message,
    buttons: [
      { label: 'Cancel', value: () => false },
      { label: 'OK', primary: true, value: () => true },
    ],
    cancelValue: false,
  });
}

/** Drop-in replacement for `window.prompt()` — the entered string for OK/Enter, `null` for Cancel/Escape, same as the native call's own contract. */
export function showPrompt(message: string, defaultValue = ''): Promise<string | null> {
  return openDialog<string | null>({
    message,
    input: { defaultValue },
    buttons: [
      { label: 'Cancel', value: () => null },
      { label: 'OK', primary: true, value: (v) => v },
    ],
    cancelValue: null,
  });
}

export interface ChoiceOption<T extends string = string> {
  value: T;
  label: string;
  /** Secondary line under the label (e.g. "current"). */
  detail?: string;
  /** Visually mark as the active/current item. */
  current?: boolean;
  /** Show a Delete control on this row (e.g. session picker). */
  deletable?: boolean;
}

export type ChoiceResult<T extends string = string> =
  | { action: 'choose'; value: T }
  | { action: 'delete'; value: T }
  | null;

/**
 * Pick one option from a clickable list. ↑/↓ move focus, Enter chooses,
 * Escape cancels. Optional per-row Delete when `deletable` is set.
 */
export function showChoice<T extends string>(
  message: string,
  options: ChoiceOption<T>[],
): Promise<ChoiceResult<T>> {
  ensureStyles();
  return new Promise<ChoiceResult<T>>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'z80-dialog-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'z80-dialog';
    overlay.appendChild(dialog);

    const p = document.createElement('p');
    p.textContent = message;
    dialog.appendChild(p);

    const list = document.createElement('div');
    list.className = 'z80-dialog-choices';
    dialog.appendChild(list);

    const rowButtons: HTMLButtonElement[] = [];
    let focusIdx = Math.max(
      0,
      options.findIndex((o) => o.current),
    );

    function close(value: ChoiceResult<T>): void {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve(value);
    }

    function focusRow(i: number): void {
      if (rowButtons.length === 0) return;
      focusIdx = ((i % rowButtons.length) + rowButtons.length) % rowButtons.length;
      rowButtons[focusIdx]!.focus();
    }

    function onKeydown(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        close(null);
        return;
      }
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        focusRow(focusIdx + 1);
        return;
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        focusRow(focusIdx - 1);
        return;
      }
      if (ev.key === 'Enter') {
        const opt = options[focusIdx];
        if (opt) {
          ev.preventDefault();
          close({ action: 'choose', value: opt.value });
        }
      }
    }

    for (const opt of options) {
      const row = document.createElement('div');
      row.className = 'z80-dialog-choice-row';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'z80-dialog-choice' + (opt.current ? ' is-current' : '');
      btn.appendChild(document.createTextNode(opt.label));
      if (opt.detail) {
        const meta = document.createElement('span');
        meta.className = 'z80-dialog-choice-meta';
        meta.textContent = opt.detail;
        btn.appendChild(meta);
      }
      btn.addEventListener('click', () => close({ action: 'choose', value: opt.value }));
      btn.addEventListener('focus', () => {
        focusIdx = rowButtons.indexOf(btn);
      });
      row.appendChild(btn);
      rowButtons.push(btn);

      if (opt.deletable) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'z80-dialog-choice-delete';
        del.title = 'Delete session';
        del.textContent = '✕';
        del.addEventListener('click', (ev) => {
          ev.stopPropagation();
          close({ action: 'delete', value: opt.value });
        });
        row.appendChild(del);
      }

      list.appendChild(row);
    }

    const actions = document.createElement('div');
    actions.className = 'z80-dialog-actions';
    dialog.appendChild(actions);
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => close(null));
    actions.appendChild(cancel);

    document.addEventListener('keydown', onKeydown);
    document.body.appendChild(overlay);
    focusRow(focusIdx);
  });
}
