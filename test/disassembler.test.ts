import { describe, expect, it } from 'vitest';
import {
  disassembleOne,
  formatDisassembly,
  formatDisasmLine,
} from '../src/machine/disassembler.js';
import { LED_BLINK_ROM_BYTES } from '../src/machine/ledBlinkRom.js';
import { PORT_LAB_LED } from '../src/machine/memoryMap.js';

describe('disassembler', () => {
  it('decodes LD A,n / OUT (n),A', () => {
    const bytes = Uint8Array.of(0x3e, 0x01, 0xd3, PORT_LAB_LED);
    const a = disassembleOne(bytes, 0);
    expect(a.text).toBe('LD A,01h');
    expect(a.size).toBe(2);
    const b = disassembleOne(bytes, 2);
    expect(b.text).toBe(`OUT (${PORT_LAB_LED.toString(16).padStart(2, '0')}h),A`);
    expect(formatDisasmLine(b)).toContain('d3');
  });

  it('disassembles the LED blink ROM from 0000', () => {
    const listing = formatDisassembly(LED_BLINK_ROM_BYTES, 0, { count: 16 });
    expect(listing).toContain('LD SP,');
    expect(listing).toContain('LD A,01h');
    expect(listing).toMatch(/OUT \(40h\),A/i);
    expect(listing).toContain('CALL ');
    expect(listing).toContain('XOR A');
    expect(listing).toContain('JR ');
    expect(listing).toContain('LD BC,');
    expect(listing).toContain('RET');
    expect(listing).toContain('0dffh');
  });

  it('falls back to DB for truncated CB', () => {
    const bytes = Uint8Array.of(0xcb);
    expect(disassembleOne(bytes, 0).text).toMatch(/^DB /);
  });
});
