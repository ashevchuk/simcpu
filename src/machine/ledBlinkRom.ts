/**
 * Soft-machine demo ROM: blink a lab LED via OUT (PORT_LAB_LED).
 *
 * Bit0 of port 0x40 drives SoftDevices.labLed → canvas LED (forceOn).
 * Soft Run does not resolve FET nets each frame, so the LED uses the host
 * bridge rather than a transistor wire alone.
 */

import { assemble } from './assembler.js';
import { PORT_LAB_LED } from './memoryMap.js';

export const LED_BLINK_STACK = 0xdff;

/**
 * Delay loop sized for Soft (~8k ops/frame): BC≈0x6000 × ~4 ops ≈ ~12 frames
 * per half-period (~0.4s on / off at 60 Hz).
 */
export const LED_BLINK_ROM_SOURCE = `
; LED blink demo — origin 0; OUT (${PORT_LAB_LED.toString(16)}h),A bit0
PORT_LED: EQU ${PORT_LAB_LED}
cold:
  LD SP,${LED_BLINK_STACK}
loop:
  LD A,1
  OUT (PORT_LED),A
  CALL delay
  XOR A
  OUT (PORT_LED),A
  CALL delay
  JR loop

delay:
  LD BC,0x6000
d1:
  DEC BC
  LD A,B
  OR C
  JR NZ,d1
  RET
`;

function buildLedBlinkRom(): Uint8Array {
  const r = assemble(LED_BLINK_ROM_SOURCE, 0);
  if (!r.ok) {
    throw new Error(`LED blink ROM assemble failed:\n${r.errors.join('\n')}`);
  }
  if (r.bytes.length === 0) throw new Error('LED blink ROM empty');
  return r.bytes;
}

export const LED_BLINK_ROM_BYTES = buildLedBlinkRom();

export function ledBlinkRomHexPrompt(): string {
  return [...LED_BLINK_ROM_BYTES].map((b) => b.toString(16).padStart(2, '0')).join(',');
}

export function loadLedBlinkRom(bytes: Uint8Array): void {
  if (bytes.length < LED_BLINK_ROM_BYTES.length) {
    throw new RangeError(
      `RAM too small for LED blink ROM (${bytes.length} < ${LED_BLINK_ROM_BYTES.length})`,
    );
  }
  bytes.set(LED_BLINK_ROM_BYTES, 0);
}
