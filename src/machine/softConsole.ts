import { FB_BASE, FB_END, MACHINE_RAM_SIZE } from './memoryMap.js';
import { loadMonitor } from './monitor.js';

/** Result of a soft console command (JS-side machine helpers). */
export interface SoftCommandResult {
  ok: boolean;
  message: string;
  /** When true, caller should MachineRunner.reboot() so PC fetches the patched JP. */
  reboot?: boolean;
}

/**
 * Parse a one-line soft monitor command (panel / tests — not Z80).
 *
 *   H              help
 *   M aaaa [nn]    dump nn bytes (default 16) from hex address
 *   W aaaa bb...   write bytes at address
 *   G aaaa         patch JP aaaa at 0x000 (sets reboot flag)
 *   R              reload echo-monitor image at 0x000
 */
export function runSoftCommand(ram: Uint8Array, line: string): SoftCommandResult {
  const trimmed = line.trim();
  if (!trimmed) return { ok: true, message: '' };

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0]!.toUpperCase();

  if (cmd === 'H' || cmd === '?' || cmd === 'HELP') {
    return {
      ok: true,
      message:
        'H help | M addr [len] dump | W addr bb.. write | G addr JP@0 + reboot | R reload monitor',
    };
  }

  if (cmd === 'R' || cmd === 'RELOAD') {
    loadMonitor(ram);
    return { ok: true, message: 'monitor reloaded at 0000' };
  }

  if (cmd === 'M' || cmd === 'DUMP') {
    if (parts.length < 2) return { ok: false, message: 'M addr [len]' };
    const addr = parseHex(parts[1]!);
    if (addr === null) return { ok: false, message: 'bad addr' };
    const len = parts[2] !== undefined ? parseHex(parts[2]!) : 16;
    if (len === null || len < 1) return { ok: false, message: 'bad len' };
    if (addr < 0 || addr >= ram.length) return { ok: false, message: 'addr out of range' };
    const n = Math.min(len, 64, ram.length - addr);
    const bytes = [...ram.subarray(addr, addr + n)].map((b) => b.toString(16).padStart(2, '0'));
    return { ok: true, message: `${fmtAddr(addr)}: ${bytes.join(' ')}` };
  }

  if (cmd === 'W' || cmd === 'POKE') {
    if (parts.length < 3) return { ok: false, message: 'W addr bb [bb...]' };
    const addr = parseHex(parts[1]!);
    if (addr === null) return { ok: false, message: 'bad addr' };
    const values: number[] = [];
    for (let i = 2; i < parts.length; i++) {
      const b = parseHex(parts[i]!);
      if (b === null || b > 0xff) return { ok: false, message: `bad byte ${parts[i]}` };
      values.push(b);
    }
    if (addr < 0 || addr + values.length > ram.length) return { ok: false, message: 'write past RAM' };
    for (let i = 0; i < values.length; i++) ram[addr + i] = values[i]!;
    return { ok: true, message: `wrote ${values.length} byte(s) at ${fmtAddr(addr)}` };
  }

  if (cmd === 'G' || cmd === 'GO') {
    if (parts.length < 2) return { ok: false, message: 'G addr' };
    const addr = parseHex(parts[1]!);
    if (addr === null) return { ok: false, message: 'bad addr' };
    if (addr < 0 || addr >= ram.length) return { ok: false, message: 'addr out of range' };
    ram[0] = 0xc3;
    ram[1] = addr & 0xff;
    ram[2] = (addr >> 8) & 0xff;
    return { ok: true, message: `JP ${fmtAddr(addr)} at 0000 — rebooting`, reboot: true };
  }

  return { ok: false, message: `unknown: ${cmd} (H for help)` };
}

/** Parse "aa,bb,cc" or whitespace hex dump into bytes. */
export function parseHexBlob(text: string): number[] | null {
  const cleaned = text.replace(/0x/gi, ' ').replace(/[,:;|]/g, ' ').trim();
  if (!cleaned) return null;
  const parts = cleaned.split(/\s+/).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const n = parseHex(p);
    if (n === null || n > 0xff) return null;
    out.push(n);
  }
  return out.length ? out : null;
}

/** Write a blob into RAM at addr; refuses KEY/reserved (@F00+) unless allowIo. */
export function loadHexAt(
  ram: Uint8Array,
  addr: number,
  bytes: number[],
  opts?: { allowIo?: boolean },
): SoftCommandResult {
  if (addr < 0 || addr >= ram.length) return { ok: false, message: 'addr out of range' };
  if (addr + bytes.length > ram.length) return { ok: false, message: 'blob past RAM end' };
  if (!opts?.allowIo) {
    for (let i = 0; i < bytes.length; i++) {
      if (addr + i >= 0xf00) return { ok: false, message: 'refuses KEY/reserved @ F00+' };
    }
  }
  for (let i = 0; i < bytes.length; i++) ram[addr + i] = bytes[i]!;
  return { ok: true, message: `loaded ${bytes.length} byte(s) at ${fmtAddr(addr)}` };
}

export function parseHex(s: string): number | null {
  const t = s.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(t)) return null;
  const n = parseInt(t, 16);
  return Number.isFinite(n) ? n : null;
}

function fmtAddr(addr: number): string {
  return addr.toString(16).padStart(addr > 0xfff ? 4 : 3, '0');
}

export function clampMachineAddr(addr: number): number {
  return ((addr % MACHINE_RAM_SIZE) + MACHINE_RAM_SIZE) % MACHINE_RAM_SIZE;
}

export function isFramebufferAddr(addr: number): boolean {
  return addr >= FB_BASE && addr < FB_END;
}
