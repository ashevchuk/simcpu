/**
 * Soft CP/M-80 BIOS + host BDOS/CCP for soft Z80 (64K map).
 *
 * Jump table at CPM_BIOS_BASE (0xFE00), 3-byte JP entries:
 *   +00 BOOT   +03 WBOOT  +06 CONST  +09 CONIN  +0C CONOUT
 *   +0F LIST   +12 PUNCH  +15 READER +18 HOME   +1B SELDSK
 *   +1E SETTRK +21 SETSEC +24 SETDMA +27 READ   +2A WRITE
 *
 * Console: soft ports. Disk: PORT_DISK_OP + SoftDisk.
 * BDOS/CCP: host SoftCpm traps at CPM_BDOS_BASE / CPM_CCP_BASE.
 *
 * Vectors:
 *   0x0000  JP WBOOT
 *   0x0005  JP BDOS
 */

import { PORT_DISK_OP } from '../memoryMap.js';
import {
  CPM_BDOS_BASE,
  CPM_BIOS_BASE,
  CPM_CCP_BASE,
  PORT_KEY_DATA,
  PORT_KEY_STATUS,
  PORT_TTY_OUT,
} from '../memoryMap.js';
import { BIOS_DMA, BIOS_SECTOR, BIOS_TRACK, SoftDisk } from './softDisk.js';
import { SoftCpm, createSoftCpm } from './host.js';

export { BIOS_DMA, BIOS_SECTOR, BIOS_TRACK, BIOS_WORK } from './softDisk.js';
export { SoftCpm, createSoftCpm } from './host.js';
export {
  CpmFileSystem,
  formatAndSeedDisk,
  buildHelloCom,
  buildReadmeTxt,
} from './fs.js';

function emitJp(buf: number[], target: number): void {
  buf.push(0xc3, target & 0xff, (target >> 8) & 0xff);
}

/** Assemble BIOS code into `ram` at CPM_BIOS_BASE; return entry points. */
export function installSoftBios(ram: Uint8Array): { biosBase: number; wboot: number; boot: number } {
  if (ram.length < 0x10000) throw new Error('soft BIOS needs 64K RAM');

  const base = CPM_BIOS_BASE;
  const code = base + 0x40;

  const constAddr = code;
  const constBytes = [
    0xdb, PORT_KEY_STATUS,
    0xb7,
    0x28, 0x03,
    0x3e, 0xff,
    0xc9,
    0xaf,
    0xc9,
  ];

  const coninAddr = constAddr + constBytes.length;
  const coninBytes = [
    0xdb, PORT_KEY_STATUS,
    0xb7,
    0x28, 0xfb,
    0xdb, PORT_KEY_DATA,
    0xc9,
  ];

  const conoutAddr = coninAddr + coninBytes.length;
  const conoutBytes = [0x79, 0xd3, PORT_TTY_OUT, 0xc9];

  const homeAddr = conoutAddr + conoutBytes.length;
  const homeBytes = [
    0x3e, 0x00,
    0x32, BIOS_TRACK & 0xff, (BIOS_TRACK >> 8) & 0xff,
    0xc9,
  ];

  const seldskAddr = homeAddr + homeBytes.length;
  const seldskBytes = [0x21, 0x00, 0x00, 0xc9];

  const settrkAddr = seldskAddr + seldskBytes.length;
  const settrkBytes = [
    0x79,
    0x32, BIOS_TRACK & 0xff, (BIOS_TRACK >> 8) & 0xff,
    0xc9,
  ];

  const setsecAddr = settrkAddr + settrkBytes.length;
  const setsecBytes = [
    0x79,
    0x32, BIOS_SECTOR & 0xff, (BIOS_SECTOR >> 8) & 0xff,
    0xc9,
  ];

  const setdmaAddr = setsecAddr + setsecBytes.length;
  const setdmaBytes = [
    0xed, 0x43, BIOS_DMA & 0xff, (BIOS_DMA >> 8) & 0xff,
    0xc9,
  ];

  const readAddr = setdmaAddr + setdmaBytes.length;
  const readBytes = [0x3e, 0x00, 0xd3, PORT_DISK_OP, 0xdb, PORT_DISK_OP, 0xc9];
  const writeAddr = readAddr + readBytes.length;
  const writeBytes = [0x3e, 0x01, 0xd3, PORT_DISK_OP, 0xdb, PORT_DISK_OP, 0xc9];

  const listAddr = writeAddr + writeBytes.length;
  const listBytes = [0xc9];
  const punchAddr = listAddr + listBytes.length;
  const punchBytes = [0xc9];
  const readerAddr = punchAddr + punchBytes.length;
  const readerBytes = [0xc3, coninAddr & 0xff, (coninAddr >> 8) & 0xff];

  const bootMsgAddr = readerAddr + readerBytes.length;
  const msg = '64K CP/M 2.2 (soft)\r\n';
  const msgBytes = [...msg].map((c) => c.charCodeAt(0) & 0xff).concat([0]);

  const bootAddr = bootMsgAddr + msgBytes.length;
  const bootBytes: number[] = [
    0x21, bootMsgAddr & 0xff, (bootMsgAddr >> 8) & 0xff,
    0x7e,
    0xb7,
    0x28, 0x07,
    0x4f,
    0xcd, conoutAddr & 0xff, (conoutAddr >> 8) & 0xff,
    0x23,
    0x18, 0xf5,
    0xc3, CPM_CCP_BASE & 0xff, (CPM_CCP_BASE >> 8) & 0xff,
  ];

  const wbootAddr = bootAddr;

  const blobs: { addr: number; bytes: number[] }[] = [
    { addr: constAddr, bytes: constBytes },
    { addr: coninAddr, bytes: coninBytes },
    { addr: conoutAddr, bytes: conoutBytes },
    { addr: homeAddr, bytes: homeBytes },
    { addr: seldskAddr, bytes: seldskBytes },
    { addr: settrkAddr, bytes: settrkBytes },
    { addr: setsecAddr, bytes: setsecBytes },
    { addr: setdmaAddr, bytes: setdmaBytes },
    { addr: readAddr, bytes: readBytes },
    { addr: writeAddr, bytes: writeBytes },
    { addr: listAddr, bytes: listBytes },
    { addr: punchAddr, bytes: punchBytes },
    { addr: readerAddr, bytes: readerBytes },
    { addr: bootMsgAddr, bytes: msgBytes },
    { addr: bootAddr, bytes: bootBytes },
  ];
  for (const { addr, bytes } of blobs) {
    for (let i = 0; i < bytes.length; i++) ram[addr + i] = bytes[i]!;
  }

  const table: number[] = [];
  for (const t of [
    bootAddr,
    wbootAddr,
    constAddr,
    coninAddr,
    conoutAddr,
    listAddr,
    punchAddr,
    readerAddr,
    homeAddr,
    seldskAddr,
    settrkAddr,
    setsecAddr,
    setdmaAddr,
    readAddr,
    writeAddr,
  ]) {
    emitJp(table, t);
  }
  for (let i = 0; i < table.length; i++) ram[base + i] = table[i]!;

  ram[BIOS_DMA] = 0x80;
  ram[BIOS_DMA + 1] = 0x00;
  ram[BIOS_TRACK] = 0;
  ram[BIOS_SECTOR] = 1;

  void CPM_BDOS_BASE;
  return { biosBase: base, wboot: wbootAddr, boot: bootAddr };
}

/** @deprecated BDOS is host SoftCpm — stub kept for tests that poke RAM. */
export function installSoftBdos(ram: Uint8Array): void {
  ram[CPM_BDOS_BASE] = 0x00;
  ram[CPM_BDOS_BASE + 1] = 0x18;
  ram[CPM_BDOS_BASE + 2] = 0xfe;
}

/** @deprecated CCP is host SoftCpm. */
export function installSoftCcp(ram: Uint8Array): void {
  ram[CPM_CCP_BASE] = 0x00;
  ram[CPM_CCP_BASE + 1] = 0x18;
  ram[CPM_CCP_BASE + 2] = 0xfe;
}

/**
 * Install BIOS + host CP/M (format/seed disk unless disk already seeded).
 * Returns SoftCpm for softZ80 hostTrap wiring.
 */
export function bootCpmSoft(ram: Uint8Array, disk?: SoftDisk, opts?: { seed?: boolean }): SoftCpm {
  if (ram.length < 0x10000) throw new Error('CP/M boot needs 64K RAM (addrBits=16)');
  if (!disk) throw new Error('CP/M boot needs SoftDisk');
  const { wboot } = installSoftBios(ram);
  const cpm = createSoftCpm(disk, opts?.seed !== false);
  cpm.installVectors(ram, wboot);
  return cpm;
}

/**
 * Boot **real** CP/M 2.2 from the embedded z80pack `cpm22-1.dsk` image.
 *
 * Loads the boot sector to 0000 and leaves SoftDisk as the image. Soft Z80
 * then runs the on-disk cold boot loader → CBIOS @ FA00 → CCP @ E400.
 * Requires z80pack FDC ports (0x0A–0x10) and CONSTA/CONDAT (0/1) in SoftDevices.
 * Disables host SoftCpm traps (caller should set devices.cpm = null, realCpm = true).
 */
export function bootRealCpm(ram: Uint8Array, disk: SoftDisk, image: Uint8Array): void {
  if (ram.length < 0x10000) throw new Error('real CP/M needs 64K RAM (addrBits=16)');
  if (image.length < 256256) throw new Error('CP/M disk image too small (need 256256-byte .dsk)');
  disk.image.set(image.subarray(0, disk.image.length));
  // Clear low memory then copy boot sector (track 0, sector 1) to 0000.
  ram.fill(0, 0, 0x100);
  disk.readSector(ram, 0, 1, 0);
  // Soft CPU starts at PC=0 → cold boot loader.
}

/**
 * Mount a second floppy image as B: (drive 1) for real CP/M (e.g. rogue.dsk).
 * Does not alter A: or cold-boot RAM — call after bootRealCpm / with SoftDevices.setDrive.
 */
export function mountCpmDriveB(devices: { setDrive: (d: number, disk: SoftDisk) => void }, image: Uint8Array): SoftDisk {
  if (image.length < 256256) throw new Error('B: disk image too small (need 256256-byte .dsk)');
  const disk = new SoftDisk(image);
  devices.setDrive(1, disk);
  return disk;
}
