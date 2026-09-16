/**
 * Host-side soft CP/M BDOS + CCP.
 *
 * softZ80 intercepts PC === CPM_BDOS_BASE (CALL 5 → JP BDOS) and PC ===
 * CPM_CCP_BASE (warm/cold boot). File ops use CpmFileSystem on SoftDisk;
 * console goes through SoftDevices ports (same as BIOS).
 */

import {
  CPM_BDOS_BASE,
  CPM_BIOS_BASE,
  CPM_CCP_BASE,
  CPM_TPA,
  PORT_KEY_DATA,
  PORT_KEY_STATUS,
  PORT_TTY_OUT,
} from '../memoryMap.js';
import type { SoftDevices } from '../softDevices.js';
import type { SoftZ80State } from '../softZ80.js';
import {
  CpmFileSystem,
  formatAndSeedDisk,
  formatFilename,
  parseFilename,
} from './fs.js';
import type { SoftDisk } from './softDisk.js';

const FCB = 0x5c; // default FCB in low memory
const DMA_DEFAULT = 0x80;

export class SoftCpm {
  fs: CpmFileSystem;
  dma = DMA_DEFAULT;
  user = 0;
  /** CCP line buffer */
  private line = '';
  private needPrompt = true;
  /** Search-first continuation for BDOS 17/18 */
  private searchPat: { name: string; ext: string } | null = null;
  private searchIdx = 0;

  constructor(disk: SoftDisk, seed = true) {
    this.fs = seed ? formatAndSeedDisk(disk) : new CpmFileSystem(disk);
  }

  /** Install low-memory vectors + BDOS/CCP trap stubs + BIOS (caller). */
  installVectors(ram: Uint8Array, wboot: number): void {
    ram[0] = 0xc3;
    ram[1] = wboot & 0xff;
    ram[2] = (wboot >> 8) & 0xff;
    // 0005: JP BDOS
    ram[5] = 0xc3;
    ram[6] = CPM_BDOS_BASE & 0xff;
    ram[7] = (CPM_BDOS_BASE >> 8) & 0xff;
    // Trap stubs: softStep intercepts these PCs (NOP; JR $ keeps PC stable if missed)
    ram[CPM_BDOS_BASE] = 0x00;
    ram[CPM_BDOS_BASE + 1] = 0x18;
    ram[CPM_BDOS_BASE + 2] = 0xfe; // JR -2
    ram[CPM_CCP_BASE] = 0x00;
    ram[CPM_CCP_BASE + 1] = 0x18;
    ram[CPM_CCP_BASE + 2] = 0xfe;
    // Default DMA + empty FCB
    this.dma = DMA_DEFAULT;
    ram[0x0003] = 0x00; // IOBYTE
    ram[0x0004] = 0x00; // drive/user
  }

  /**
   * Soft hook: if PC is BDOS or CCP entry, handle and return true.
   * Console I/O uses SoftDevices (same ports as BIOS).
   */
  handleTrap(cpu: SoftZ80State, ram: Uint8Array, devices: SoftDevices): boolean {
    if (cpu.pc === CPM_BDOS_BASE) {
      this.bdosCall(cpu, ram, devices);
      return true;
    }
    if (cpu.pc === CPM_CCP_BASE) {
      this.ccpStep(cpu, ram, devices);
      return true;
    }
    return false;
  }

  private conout(devices: SoftDevices, ram: Uint8Array, ch: number): void {
    devices.portOut(ram, PORT_TTY_OUT, ch & 0xff);
  }

  private constReady(devices: SoftDevices, ram: Uint8Array): boolean {
    return (devices.portIn(ram, PORT_KEY_STATUS) & 0xff) !== 0;
  }

  private conin(devices: SoftDevices, ram: Uint8Array): number {
    while (!this.constReady(devices, ram)) {
      /* busy — caller should only call when ready for CCP; BDOS #1 spins in host */
      break;
    }
    if (!this.constReady(devices, ram)) return -1;
    return devices.portIn(ram, PORT_KEY_DATA) & 0xff;
  }

  private print(devices: SoftDevices, ram: Uint8Array, s: string): void {
    for (let i = 0; i < s.length; i++) this.conout(devices, ram, s.charCodeAt(i));
  }

  private printDollar(devices: SoftDevices, ram: Uint8Array, addr: number): void {
    for (let i = 0; i < 256; i++) {
      const c = ram[(addr + i) & 0xffff]!;
      if (c === 0x24) break; // '$'
      this.conout(devices, ram, c);
    }
  }

  /** Simulate RET from BDOS (pop return address). */
  private bdosReturn(cpu: SoftZ80State, ram: Uint8Array, a: number, hl?: number): void {
    cpu.a = a & 0xff;
    if (hl !== undefined) {
      cpu.l = hl & 0xff;
      cpu.h = (hl >> 8) & 0xff;
    }
    // Soft CALL pushed return with pushReturn — pop like RET
    const sp = cpu.sp;
    const lo = ram[sp & 0xffff]!;
    const hi = ram[(sp + 1) & 0xffff]!;
    cpu.sp = (sp + 2) & 0xffff;
    cpu.pc = (lo | (hi << 8)) & 0xffff;
  }

  private readFcbName(ram: Uint8Array, fcb: number): { user: number; name: string; ext: string } {
    const user = ram[fcb]!;
    let name = '';
    let ext = '';
    for (let i = 0; i < 8; i++) name += String.fromCharCode(ram[fcb + 1 + i]! & 0x7f);
    for (let i = 0; i < 3; i++) ext += String.fromCharCode(ram[fcb + 9 + i]! & 0x7f);
    return { user: user === 0 ? this.user : user, name, ext };
  }

  private writeFcbName(ram: Uint8Array, fcb: number, name: string, ext: string): void {
    for (let i = 0; i < 8; i++) ram[fcb + 1 + i] = (name.charCodeAt(i) || 0x20) & 0x7f;
    for (let i = 0; i < 3; i++) ram[fcb + 9 + i] = (ext.charCodeAt(i) || 0x20) & 0x7f;
  }

  bdosCall(cpu: SoftZ80State, ram: Uint8Array, devices: SoftDevices): void {
    const fn = cpu.c & 0xff;
    const de = (cpu.e | (cpu.d << 8)) & 0xffff;

    switch (fn) {
      case 0: // system reset
        cpu.pc = 0;
        return;
      case 1: {
        // CONIN — wait for key
        let ch = this.conin(devices, ram);
        if (ch < 0) {
          // stay in BDOS until key available: don't RET
          return;
        }
        if (ch >= 0x20 && ch < 0x7f) this.conout(devices, ram, ch); // echo
        this.bdosReturn(cpu, ram, ch);
        return;
      }
      case 2: // CONOUT
        this.conout(devices, ram, cpu.e & 0xff);
        this.bdosReturn(cpu, ram, 0);
        return;
      case 6: {
        // Direct console I/O: E=0xFF status/input, else output
        if ((cpu.e & 0xff) === 0xff) {
          if (this.constReady(devices, ram)) {
            this.bdosReturn(cpu, ram, devices.portIn(ram, PORT_KEY_DATA));
          } else {
            this.bdosReturn(cpu, ram, 0);
          }
        } else {
          this.conout(devices, ram, cpu.e & 0xff);
          this.bdosReturn(cpu, ram, 0);
        }
        return;
      }
      case 9: // print string
        this.printDollar(devices, ram, de);
        this.bdosReturn(cpu, ram, 0);
        return;
      case 10: {
        // read console buffer: DE → max, count, chars
        const max = ram[de]!;
        let n = 0;
        while (n < max) {
          const ch = this.conin(devices, ram);
          if (ch < 0) return; // wait
          if (ch === 0x0d) break;
          if (ch === 0x08 || ch === 0x7f) {
            if (n > 0) {
              n--;
              this.print(devices, ram, '\b \b');
            }
            continue;
          }
          if (ch < 0x20) continue;
          ram[(de + 2 + n) & 0xffff] = ch;
          this.conout(devices, ram, ch);
          n++;
        }
        ram[(de + 1) & 0xffff] = n;
        this.conout(devices, ram, 0x0d);
        this.conout(devices, ram, 0x0a);
        this.bdosReturn(cpu, ram, n);
        return;
      }
      case 11: // CONST
        this.bdosReturn(cpu, ram, this.constReady(devices, ram) ? 0xff : 0);
        return;
      case 12: // version
        this.bdosReturn(cpu, ram, 0x22, 0x0022); // CP/M 2.2
        return;
      case 13: // reset disk system
        this.dma = DMA_DEFAULT;
        this.bdosReturn(cpu, ram, 0);
        return;
      case 14: // select disk
        this.bdosReturn(cpu, ram, 0);
        return;
      case 15: {
        // open file
        const f = this.readFcbName(ram, de);
        const path = formatFilename(f.name, f.ext);
        if (!this.fs.fileExists(path, this.user)) {
          this.bdosReturn(cpu, ram, 0xff);
          return;
        }
        ram[(de + 12) & 0xffff] = 0; // extent
        ram[(de + 15) & 0xffff] = 0; // rc placeholder
        ram[(de + 32) & 0xffff] = 0; // cr current record
        this.bdosReturn(cpu, ram, 0);
        return;
      }
      case 16: // close
        this.bdosReturn(cpu, ram, 0);
        return;
      case 17: {
        // search first
        const f = this.readFcbName(ram, de);
        this.searchPat = { name: f.name, ext: f.ext };
        this.searchIdx = 0;
        const code = this.searchNext(ram);
        this.bdosReturn(cpu, ram, code);
        return;
      }
      case 18: {
        const code = this.searchNext(ram);
        this.bdosReturn(cpu, ram, code);
        return;
      }
      case 19: {
        // delete
        const f = this.readFcbName(ram, de);
        const ok = this.fs.deleteFile(formatFilename(f.name, f.ext), this.user);
        this.bdosReturn(cpu, ram, ok ? 0 : 0xff);
        return;
      }
      case 20: {
        // read sequential
        const f = this.readFcbName(ram, de);
        const path = formatFilename(f.name, f.ext);
        const data = this.fs.readFile(path, this.user);
        if (!data) {
          this.bdosReturn(cpu, ram, 1);
          return;
        }
        const cr = ram[(de + 32) & 0xffff]!;
        const off = cr * 128;
        if (off >= data.length) {
          this.bdosReturn(cpu, ram, 1); // EOF
          return;
        }
        for (let i = 0; i < 128; i++) {
          ram[(this.dma + i) & 0xffff] = off + i < data.length ? data[off + i]! : 0x1a;
        }
        ram[(de + 32) & 0xffff] = (cr + 1) & 0xff;
        this.bdosReturn(cpu, ram, 0);
        return;
      }
      case 21: {
        // write sequential — append 128 bytes from DMA
        const f = this.readFcbName(ram, de);
        const path = formatFilename(f.name, f.ext);
        const prev = this.fs.readFile(path, this.user) ?? new Uint8Array(0);
        const cr = ram[(de + 32) & 0xffff]!;
        const next = new Uint8Array(Math.max(prev.length, (cr + 1) * 128));
        next.set(prev);
        for (let i = 0; i < 128; i++) next[cr * 128 + i] = ram[(this.dma + i) & 0xffff]!;
        try {
          this.fs.writeFile(path, next, this.user);
          ram[(de + 32) & 0xffff] = (cr + 1) & 0xff;
          this.bdosReturn(cpu, ram, 0);
        } catch {
          this.bdosReturn(cpu, ram, 1);
        }
        return;
      }
      case 22: {
        // make file
        const f = this.readFcbName(ram, de);
        const path = formatFilename(f.name, f.ext);
        try {
          this.fs.writeFile(path, new Uint8Array(0), this.user);
          ram[(de + 32) & 0xffff] = 0;
          this.bdosReturn(cpu, ram, 0);
        } catch {
          this.bdosReturn(cpu, ram, 0xff);
        }
        return;
      }
      case 23: {
        // rename: FCB has old at +0, new at +16
        const oldF = this.readFcbName(ram, de);
        let newName = '';
        let newExt = '';
        for (let i = 0; i < 8; i++) newName += String.fromCharCode(ram[de + 17 + i]! & 0x7f);
        for (let i = 0; i < 3; i++) newExt += String.fromCharCode(ram[de + 25 + i]! & 0x7f);
        const ok = this.fs.renameFile(
          formatFilename(oldF.name, oldF.ext),
          formatFilename(newName, newExt),
          this.user,
        );
        this.bdosReturn(cpu, ram, ok ? 0 : 0xff);
        return;
      }
      case 25: // current disk
        this.bdosReturn(cpu, ram, 0);
        return;
      case 26: // set DMA
        this.dma = de & 0xffff;
        this.bdosReturn(cpu, ram, 0);
        return;
      case 32: // get/set user
        if ((cpu.e & 0xff) === 0xff) this.bdosReturn(cpu, ram, this.user);
        else {
          this.user = cpu.e & 0x1f;
          this.bdosReturn(cpu, ram, 0);
        }
        return;
      default:
        this.bdosReturn(cpu, ram, 0);
    }
  }

  private searchNext(ram: Uint8Array): number {
    if (!this.searchPat) return 0xff;
    const { name, ext } = this.searchPat;
    const namePat = name.includes('?') ? name : name;
    const extPat = ext.includes('?') ? ext : ext;
    const entries = this.fs.list(this.user, namePat, extPat);
    if (this.searchIdx >= entries.length) return 0xff;
    const e = entries[this.searchIdx++]!;
    // Write directory entry image into DMA (32 bytes)
    const buf = new Uint8Array(32);
    buf[0] = e.user;
    for (let i = 0; i < 8; i++) buf[1 + i] = e.name.charCodeAt(i) & 0x7f;
    for (let i = 0; i < 3; i++) buf[9 + i] = e.ext.charCodeAt(i) & 0x7f;
    buf[12] = e.extent;
    buf[15] = e.rc;
    for (let i = 0; i < 16; i++) buf[16 + i] = e.alloc[i] ?? 0;
    for (let i = 0; i < 32; i++) ram[(this.dma + i) & 0xffff] = buf[i]!;
    return 0; // success — dir code 0
  }

  /** One CCP quantum: prompt / collect line / run command. */
  ccpStep(cpu: SoftZ80State, ram: Uint8Array, devices: SoftDevices): void {
    if (this.needPrompt) {
      this.print(devices, ram, 'A>');
      this.line = '';
      this.needPrompt = false;
    }

    if (!this.constReady(devices, ram)) return; // wait for key
    const ch = devices.portIn(ram, PORT_KEY_DATA) & 0xff;

    if (ch === 0x0d) {
      this.conout(devices, ram, 0x0d);
      this.conout(devices, ram, 0x0a);
      this.runCommand(cpu, ram, devices, this.line.trim());
      this.line = '';
      return;
    }
    if (ch === 0x08 || ch === 0x7f) {
      if (this.line.length > 0) {
        this.line = this.line.slice(0, -1);
        this.print(devices, ram, '\b \b');
      }
      return;
    }
    if (ch >= 0x20 && ch < 0x7f && this.line.length < 128) {
      this.line += String.fromCharCode(ch);
      this.conout(devices, ram, ch);
    }
  }

  private runCommand(cpu: SoftZ80State, ram: Uint8Array, devices: SoftDevices, line: string): void {
    if (!line) {
      this.needPrompt = true;
      return;
    }
    const parts = line.split(/\s+/);
    const cmd = parts[0]!.toUpperCase();

    if (cmd === 'DIR') {
      const pat = parts[1] ?? '*.*';
      const w = wildParse(pat);
      const files = this.fs.list(this.user, w.name, w.ext);
      if (files.length === 0) this.print(devices, ram, 'NO FILE\r\n');
      else {
        for (const f of files) {
          this.print(devices, ram, `A: ${formatFilename(f.name, f.ext)}\r\n`);
        }
      }
      this.needPrompt = true;
      return;
    }

    if (cmd === 'TYPE') {
      const file = parts[1];
      if (!file) {
        this.print(devices, ram, '?\r\n');
        this.needPrompt = true;
        return;
      }
      const data = this.fs.readFile(file, this.user);
      if (!data) {
        this.print(devices, ram, 'NO FILE\r\n');
      } else {
        for (let i = 0; i < data.length; i++) {
          const c = data[i]!;
          if (c === 0x1a) break;
          this.conout(devices, ram, c);
        }
        if (data.length === 0 || data[data.length - 1] !== 0x0a) this.print(devices, ram, '\r\n');
      }
      this.needPrompt = true;
      return;
    }

    if (cmd === 'ERA' || cmd === 'ERASE') {
      const file = parts[1];
      if (!file) {
        this.print(devices, ram, '?\r\n');
      } else if (!this.fs.deleteFile(file, this.user)) {
        this.print(devices, ram, 'NO FILE\r\n');
      }
      this.needPrompt = true;
      return;
    }

    if (cmd === 'REN' || cmd === 'RENAME') {
      // REN NEW=OLD  or REN OLD NEW
      let oldN: string | undefined;
      let newN: string | undefined;
      if (parts[1]?.includes('=')) {
        const [a, b] = parts[1].split('=');
        newN = a;
        oldN = b;
      } else {
        oldN = parts[1];
        newN = parts[2];
      }
      if (!oldN || !newN) this.print(devices, ram, '?\r\n');
      else if (!this.fs.renameFile(oldN, newN, this.user)) this.print(devices, ram, 'NO FILE\r\n');
      this.needPrompt = true;
      return;
    }

    if (cmd === 'USER') {
      const n = parts[1] !== undefined ? parseInt(parts[1], 10) : NaN;
      if (!Number.isFinite(n) || n < 0 || n > 15) this.print(devices, ram, '?\r\n');
      else this.user = n;
      this.needPrompt = true;
      return;
    }

    // Transient: NAME or NAME.COM
    let com = cmd;
    if (!com.includes('.')) com += '.COM';
    else if (!com.toUpperCase().endsWith('.COM')) {
      this.print(devices, ram, `${cmd}?\r\n`);
      this.needPrompt = true;
      return;
    }
    const data = this.fs.readFile(com, this.user);
    if (!data) {
      this.print(devices, ram, `${cmd}?\r\n`);
      this.needPrompt = true;
      return;
    }
    // Load to TPA
    for (let i = 0; i < data.length; i++) ram[(CPM_TPA + i) & 0xffff] = data[i]!;
    // Default FCB from command tail
    ram[FCB] = 0;
    const arg = parts[1] ?? '';
    if (arg) {
      const p = parseFilename(arg);
      this.writeFcbName(ram, FCB, p.name, p.ext);
    } else {
      this.writeFcbName(ram, FCB, '        ', '   ');
    }
    ram[0x80] = 0; // command tail length
    this.dma = DMA_DEFAULT;
    cpu.pc = CPM_TPA;
    cpu.sp = 0xe3ff;
    // Push WBOOT as return for programs that RET
    const wboot = CPM_BIOS_BASE + 3;
    cpu.sp = (cpu.sp - 2) & 0xffff;
    ram[cpu.sp] = wboot & 0xff;
    ram[cpu.sp + 1] = (wboot >> 8) & 0xff;
    this.needPrompt = true; // after program returns via JP 0
  }
}

function wildParse(pat: string): { name: string; ext: string } {
  const t = pat.trim().toUpperCase().replace(/^\d+:/, '');
  if (t === '*.*' || t === '*') return { name: '????????', ext: '???' };
  const dot = t.indexOf('.');
  const expand2 = (s: string, len: number) => {
    let out = '';
    for (const c of s) {
      if (c === '*') {
        while (out.length < len) out += '?';
        return out.slice(0, len);
      }
      if (out.length >= len) break;
      if (c === '?' || /[A-Z0-9]/.test(c)) out += c;
    }
    while (out.length < len) out += ' ';
    return out;
  };
  if (dot < 0) return { name: expand2(t, 8), ext: '???' };
  return { name: expand2(t.slice(0, dot), 8), ext: expand2(t.slice(dot + 1), 3) };
}

export function createSoftCpm(disk: SoftDisk, seed = true): SoftCpm {
  return new SoftCpm(disk, seed);
}
