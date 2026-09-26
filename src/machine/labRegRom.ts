/**
 * Soft-machine demo ROM: exercise Soft Lab REG8 / COUNTER4 via ports.
 *
 * PORT_LAB_REG (0x41) → SoftDevices.labReg → bindLabReg paints REG8 q.
 * PORT_LAB_COUNTER (0x42) → SoftDevices.labCounter → bindLabCounter paints COUNTER4 q.
 */

import { assemble } from './assembler.js';
import { PORT_LAB_COUNTER, PORT_LAB_REG } from './memoryMap.js';

export const LAB_REG_STACK = 0xdff;

export const LAB_REG_ROM_SOURCE = `
; Lab REG/COUNTER demo — OUT (${PORT_LAB_REG.toString(16)}h) / OUT (${PORT_LAB_COUNTER.toString(16)}h)
PORT_REG: EQU ${PORT_LAB_REG}
PORT_CTR: EQU ${PORT_LAB_COUNTER}
cold:
  LD SP,${LAB_REG_STACK}
  XOR A
  OUT (PORT_CTR),A
loop:
  LD A,0xA5
  OUT (PORT_REG),A
  CALL bump
  LD A,0x5A
  OUT (PORT_REG),A
  CALL bump
  JR loop

bump:
  IN A,(PORT_CTR)
  AND 0x0f
  INC A
  AND 0x0f
  OUT (PORT_CTR),A
  LD BC,0x2000
d1:
  DEC BC
  LD A,B
  OR C
  JR NZ,d1
  RET
`;

function buildLabRegRom(): Uint8Array {
  const r = assemble(LAB_REG_ROM_SOURCE, 0);
  if (!r.ok) {
    throw new Error(`Lab REG ROM assemble failed:\n${r.errors.join('\n')}`);
  }
  if (r.bytes.length === 0) throw new Error('Lab REG ROM empty');
  return r.bytes;
}

export const LAB_REG_ROM_BYTES = buildLabRegRom();

export function labRegRomHexPrompt(): string {
  return [...LAB_REG_ROM_BYTES].map((b) => b.toString(16).padStart(2, '0')).join(',');
}
