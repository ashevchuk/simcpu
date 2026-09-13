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
      z-index: 1000;
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
