import { describe, expect, it } from 'vitest';
import { createSoftDevices } from '../src/machine/softDevices.js';
import {
  LED_BLINK_ROM_BYTES,
  LED_BLINK_ROM_SOURCE,
  ledBlinkRomHexPrompt,
  loadLedBlinkRom,
} from '../src/machine/ledBlinkRom.js';
import { assemble } from '../src/machine/assembler.js';
import { PORT_LAB_LED } from '../src/machine/memoryMap.js';
import { createSoftZ80, softStep } from '../src/machine/softZ80.js';
import type { SoftMemHooks } from '../src/machine/softZ80.js';
import { makeLed } from '../src/sim/library.js';
import { Circuit } from '../src/sim/Circuit.js';
import { MachineRunner } from '../src/machine/MachineRunner.js';

describe('LED blink ROM', () => {
  it('assembles and starts with LD SP / OUT to PORT_LAB_LED', () => {
    const r = assemble(LED_BLINK_ROM_SOURCE, 0);
    expect(r.errors).toEqual([]);
    expect(r.bytes).toEqual(LED_BLINK_ROM_BYTES);
    expect(LED_BLINK_ROM_BYTES[0]).toBe(0x31); // LD SP,nn
    expect(ledBlinkRomHexPrompt().startsWith('31,')).toBe(true);
    const hasOut = [...LED_BLINK_ROM_BYTES.keys()].some(
      (i) => LED_BLINK_ROM_BYTES[i] === 0xd3 && LED_BLINK_ROM_BYTES[i + 1] === PORT_LAB_LED,
    );
    expect(hasOut).toBe(true);

    const ram = new Uint8Array(4096);
    loadLedBlinkRom(ram);
    expect(ram.subarray(0, LED_BLINK_ROM_BYTES.length)).toEqual(LED_BLINK_ROM_BYTES);
  });

  it('soft OUT toggles SoftDevices.labLed and LED forceOn', () => {
    const devices = createSoftDevices();
    const ram = new Uint8Array(4096);
    loadLedBlinkRom(ram);
    const cpu = createSoftZ80();
    const hooks: SoftMemHooks = {
      portIn: (port) => devices.portIn(ram, port),
      portOut: (port, val) => devices.portOut(ram, port, val),
    };

    // LD SP ; LD A,1 ; OUT (0x40),A
    for (let i = 0; i < 8; i++) softStep(cpu, ram, hooks);
    expect(devices.labLed).toBe(1);
    expect(devices.portIn(ram, PORT_LAB_LED)).toBe(1);

    devices.portOut(ram, PORT_LAB_LED, 0);
    expect(devices.labLed).toBe(0);

    const circuit = new Circuit();
    const led = makeLed(circuit, { x: 0, y: 0 }, 'LAB_LED');
    const runner = new MachineRunner();
    runner.softDevices.labLed = 1;
    runner.bindLabLed(led);
    expect(led.forceOn).toBe(true);
    runner.softDevices.labLed = 0;
    expect(runner.syncLabLed()).toBe(true);
    expect(led.forceOn).toBe(false);
  });
});
