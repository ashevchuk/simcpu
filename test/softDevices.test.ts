import { describe, expect, it } from 'vitest';
import {
  BMP_BYTES,
  PORT_BMP_ADDR_HI,
  PORT_BMP_ADDR_LO,
  PORT_BMP_DATA,
  PORT_KEY_DATA,
  PORT_KEY_STATUS,
  PORT_TTY_OUT,
  createSoftDevices,
} from '../src/machine/softDevices.js';
import { KEY_DATA, KEY_STATUS, MACHINE_ADDR_BITS } from '../src/machine/memoryMap.js';
import { injectKey } from '../src/machine/tty.js';

describe('softDevices', () => {
  it('TTY OUT paints host console and advances cursor', () => {
    const dev = createSoftDevices();
    const ram = new Uint8Array(1 << MACHINE_ADDR_BITS);
    dev.portOut(ram, PORT_TTY_OUT, 'A'.charCodeAt(0));
    expect(dev.consoleFb[0]).toBe(0x41);
    expect(dev.fbCursor).toBe(1);
    dev.portOut(ram, PORT_TTY_OUT, 'B'.charCodeAt(0));
    expect(dev.consoleFb[1]).toBe(0x42);
  });

  it('bitmap addr/data OUT/IN and clearBitmap', () => {
    const dev = createSoftDevices();
    const ram = new Uint8Array(16);
    expect(dev.bitmap.length).toBe(BMP_BYTES);
    dev.portOut(ram, PORT_BMP_ADDR_LO, 0x05);
    dev.portOut(ram, PORT_BMP_ADDR_HI, 0x00);
    dev.portOut(ram, PORT_BMP_DATA, 0xaa);
    expect(dev.bitmap[5]).toBe(0xaa);
    expect(dev.portIn(ram, PORT_BMP_DATA)).toBe(0xaa);
    dev.clearBitmap();
    expect(dev.bitmap[5]).toBe(0);
  });

  it('key ports read RAM and clear status on KEY_DATA IN', () => {
    const dev = createSoftDevices();
    const ram = new Uint8Array(1 << MACHINE_ADDR_BITS);
    injectKey(ram, 0x51);
    expect(dev.portIn(ram, PORT_KEY_STATUS)).toBe(1);
    expect(dev.portIn(ram, PORT_KEY_DATA)).toBe(0x51);
    expect(ram[KEY_STATUS]).toBe(0);
    expect(ram[KEY_DATA]).toBe(0x51);
  });
});
