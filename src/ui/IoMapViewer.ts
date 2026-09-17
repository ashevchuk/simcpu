/**
 * Read-only soft machine I/O map summary (framebuffer / key ports / soft ports).
 */

import type { RamComponent } from '../sim/types.js';
import {
  FB_COLS,
  FB_ROWS,
  FB_SIZE,
  MACHINE_RAM_SIZE,
  PORT_BMP_ADDR_HI,
  PORT_BMP_ADDR_LO,
  PORT_BMP_DATA,
  PORT_DISK_OP,
  PORT_KEY_DATA,
  PORT_KEY_STATUS,
  PORT_TTY_OUT,
  requiresMachineMap,
  softIoLayoutForAddrBits,
} from '../machine/memoryMap.js';
import { FloatingWindow } from './FloatingWindow.js';

function hexAddr(n: number): string {
  const pad = n > 0xfff ? 4 : 3;
  return `0x${n.toString(16).toUpperCase().padStart(pad, '0')}`;
}

function hexByte(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

function peekAscii(bytes: Uint8Array, base: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const b = bytes[base + i] ?? 0;
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : b === 0 ? '·' : '.';
  }
  return s;
}

export class IoMapViewer {
  private readonly win: FloatingWindow;
  readonly root: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private ram: RamComponent | null = null;

  constructor() {
    this.win = new FloatingWindow('I/O Map', 'io-map-viewer');
    this.root = this.win.body;
    this.root.innerHTML = `
      <div class="io-map-body"></div>
      <div class="lab-panel-status">Attach a machine (TTY / Z80 ≥12-bit RAM) to inspect.</div>
    `;
    this.bodyEl = this.root.querySelector('.io-map-body')!;
  }

  attach(ram: RamComponent | null): void {
    this.ram = ram;
    this.draw();
  }

  setVisible(show: boolean): void {
    this.win.setVisible(show);
    if (show) this.draw();
  }

  get visible(): boolean {
    return this.win.visible;
  }

  draw(): void {
    const ram = this.ram;
    this.bodyEl.replaceChildren();

    if (!ram || !requiresMachineMap(ram.addrBits)) {
      const p = document.createElement('p');
      p.className = 'io-map-empty';
      p.textContent = ram
        ? `RAM addrBits=${ram.addrBits} — need ≥12 for the soft machine map.`
        : 'No machine RAM attached.';
      this.bodyEl.appendChild(p);
      this.win.setTitle('I/O Map', '');
      return;
    }

    this.win.setTitle('I/O Map', `${1 << ram.addrBits} B`);
    const bytes = ram.bytes;
    const L = softIoLayoutForAddrBits(ram.addrBits);

    const table = document.createElement('table');
    table.className = 'io-map-table';
    const add = (region: string, range: string, note: string) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${region}</td><td class="mono">${range}</td><td>${note}</td>`;
      table.appendChild(tr);
    };
    add('Program / RAM', `${hexAddr(0)}–${hexAddr(L.fbBase - 1)}`, 'code & data');
    add('Text FB', `${hexAddr(L.fbBase)}–${hexAddr(L.fbEnd - 1)}`, `${FB_COLS}×${FB_ROWS} ASCII`);
    add('KEY_STATUS', hexAddr(L.keyStatus), '0=empty, 1=waiting');
    add('KEY_DATA', hexAddr(L.keyData), 'last key (read clears)');
    add(
      'Reserved',
      `${hexAddr(L.keyData + 1)}–${hexAddr(L.ramSize - 1)}`,
      ram.addrBits >= 16 ? 'BIOS @ FE00' : '—',
    );
    this.bodyEl.appendChild(table);

    const ports = document.createElement('div');
    ports.className = 'io-map-section';
    ports.innerHTML = `
      <div class="io-map-h">Soft ports (IN/OUT)</div>
      <table class="io-map-table">
        <tr><td>PORT_TTY_OUT</td><td class="mono">${hexAddr(PORT_TTY_OUT)}</td><td>OUT → text FB</td></tr>
        <tr><td>PORT_KEY_STATUS</td><td class="mono">${hexAddr(PORT_KEY_STATUS)}</td><td>IN → KEY_STATUS</td></tr>
        <tr><td>PORT_KEY_DATA</td><td class="mono">${hexAddr(PORT_KEY_DATA)}</td><td>IN → KEY_DATA</td></tr>
        <tr><td>PORT_BMP_ADDR_LO/HI</td><td class="mono">${hexAddr(PORT_BMP_ADDR_LO)}/${hexAddr(PORT_BMP_ADDR_HI)}</td><td>bitmap index</td></tr>
        <tr><td>PORT_BMP_DATA</td><td class="mono">${hexAddr(PORT_BMP_DATA)}</td><td>bitmap R/W</td></tr>
        <tr><td>PORT_DISK_OP</td><td class="mono">${hexAddr(PORT_DISK_OP)}</td><td>CP/M disk R/W</td></tr>
      </table>
    `;
    this.bodyEl.appendChild(ports);

    const peek = document.createElement('div');
    peek.className = 'io-map-section';
    const keySt = bytes[L.keyStatus] ?? 0;
    const keyDt = bytes[L.keyData] ?? 0;
    peek.innerHTML = `
      <div class="io-map-h">Live peek</div>
      <div>KEY ${keySt ? 'ready' : 'empty'} data=${hexByte(keyDt)} · FB[0..15]=${peekAscii(bytes, L.fbBase, Math.min(16, FB_SIZE))}</div>
      <div class="muted">Default map is 4K (${MACHINE_RAM_SIZE}B). addrBits=16 moves FB for CP/M.</div>
    `;
    this.bodyEl.appendChild(peek);
  }
}
