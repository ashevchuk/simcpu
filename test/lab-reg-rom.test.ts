import { describe, expect, it } from 'vitest';
import { createSoftDevices, PORT_LAB_COUNTER, PORT_LAB_REG } from '../src/machine/softDevices.js';
import { LAB_REG_ROM_BYTES, LAB_REG_ROM_SOURCE } from '../src/machine/labRegRom.js';
import { assemble } from '../src/machine/assembler.js';
import { createSoftZ80, softStep, type SoftMemHooks } from '../src/machine/softZ80.js';

describe('Lab REG ROM', () => {
  it('assembles OUT to REG and COUNTER ports', () => {
    const r = assemble(LAB_REG_ROM_SOURCE, 0);
    expect(r.errors).toEqual([]);
    expect(r.bytes).toEqual(LAB_REG_ROM_BYTES);
    expect(
      [...LAB_REG_ROM_BYTES].some(
        (b, i) => b === 0xd3 && LAB_REG_ROM_BYTES[i + 1] === PORT_LAB_REG,
      ),
    ).toBe(true);
    expect(
      [...LAB_REG_ROM_BYTES].some(
        (b, i) => b === 0xd3 && LAB_REG_ROM_BYTES[i + 1] === PORT_LAB_COUNTER,
      ),
    ).toBe(true);
  });

  it('soft OUT updates SoftDevices labReg and labCounter', () => {
    const ram = new Uint8Array(0x1000);
    ram.set(LAB_REG_ROM_BYTES);
    const devices = createSoftDevices();
    const cpu = createSoftZ80();
    const hooks: SoftMemHooks = {
      portIn: (p) => devices.portIn(ram, p),
      portOut: (p, v) => devices.portOut(ram, p, v),
    };
    for (let i = 0; i < 80; i++) softStep(cpu, ram, hooks);
    expect(devices.labReg).toBe(0xa5);
    expect(devices.labCounter & 0x0f).toBeGreaterThan(0);
  });
});
