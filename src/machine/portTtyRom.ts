/**
 * Soft-machine demo ROM: print a short string via OUT (PORT_TTY_OUT).
 *
 * Port 0x01 writes ASCII into SoftDevices VT100 console (same path as CP/M
 * CONOUT). Prefer this over MMIO FB_BASE for lab I/O demos.
 */

import { assemble } from './assembler.js';
import { PORT_TTY_OUT } from './memoryMap.js';

export const PORT_TTY_STACK = 0xdff;

export const PORT_TTY_ROM_SOURCE = `
; Port TTY demo — origin 0; OUT (${PORT_TTY_OUT.toString(16).padStart(2, '0')}h),A
PORT_TTY: EQU ${PORT_TTY_OUT}
cold:
  LD SP,${PORT_TTY_STACK}
  LD HL,msg
loop:
  LD A,(HL)
  OR A
  JR Z,done
  OUT (PORT_TTY),A
  INC HL
  JR loop
done:
  HALT
  JR done

msg:
  DEFB "Hello via OUT!",10,0
`;

function buildPortTtyRom(): Uint8Array {
  const r = assemble(PORT_TTY_ROM_SOURCE, 0);
  if (!r.ok) {
    throw new Error(`Port TTY ROM assemble failed:\n${r.errors.join('\n')}`);
  }
  if (r.bytes.length === 0) throw new Error('Port TTY ROM empty');
  return r.bytes;
}

export const PORT_TTY_ROM_BYTES = buildPortTtyRom();

export function portTtyRomHexPrompt(): string {
  return [...PORT_TTY_ROM_BYTES].map((b) => b.toString(16).padStart(2, '0')).join(',');
}

export function loadPortTtyRom(bytes: Uint8Array): void {
  if (bytes.length < PORT_TTY_ROM_BYTES.length) {
    throw new RangeError(
      `RAM too small for Port TTY ROM (${bytes.length} < ${PORT_TTY_ROM_BYTES.length})`,
    );
  }
  bytes.set(PORT_TTY_ROM_BYTES, 0);
}
