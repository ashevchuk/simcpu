import { describe, expect, it } from 'vitest';
import { createSoftZ80 } from '../src/machine/softZ80.js';
import { Ay8912 } from '../src/machine/spectrum/ay8912.js';
import { bootSpectrum } from '../src/machine/spectrum/boot.js';
import { SpectrumMmu } from '../src/machine/spectrum/mmu.js';
import { applySna, isSna48, saveSna, SNA_48K_SIZE } from '../src/machine/spectrum/sna.js';
import { SpectrumUla } from '../src/machine/spectrum/ula.js';
import { applyZ80, decompressZ80Block, peekZ80Model } from '../src/machine/spectrum/z80snap.js';

describe('ULA beeper segments', () => {
  it('records EAR transitions at soft-step progress', () => {
    const ula = new SpectrumUla();
    ula.beginBeeperFrame();
    ula.setBeeperProgress(0.1);
    ula.portOut(0xfe, 0x10); // ear on
    ula.setBeeperProgress(0.5);
    ula.portOut(0xfe, 0x00); // ear off
    const seg = ula.beeperSegments();
    expect(seg.startEar).toBe(false);
    expect(seg.transitions.length).toBe(2);
    expect(seg.transitions[0]!.bit).toBe(true);
    expect(seg.transitions[1]!.bit).toBe(false);
  });

  it('mixes square-wave beeper into audio buffer', async () => {
    const { mixBeeperSquare } = await import('../src/machine/spectrum/ay8912.js');
    const data = new Float32Array(100);
    mixBeeperSquare(data, false, [{ frac: 0.5, bit: true }]);
    let hi = 0;
    let lo = 0;
    for (let i = 0; i < 50; i++) if (data[i]! > 0) lo++;
    for (let i = 50; i < 100; i++) if (data[i]! > 0) hi++;
    expect(lo).toBe(0);
    expect(hi).toBe(50);
  });
});

describe('AY-3-8912 soft chip', () => {
  it('decodes FFFD/BFFD port families', () => {
    expect(Ay8912.isSelectPort(0xfffd)).toBe(true);
    expect(Ay8912.isDataPort(0xbffd)).toBe(true);
    expect(Ay8912.isSelectPort(0xbffd)).toBe(false);
    expect(Ay8912.isDataPort(0xfffd)).toBe(false);
  });

  it('renders audible tone when channel A enabled', () => {
    const ay = new Ay8912();
    ay.reset();
    ay.select(0);
    ay.writeData(0x40); // period fine
    ay.select(1);
    ay.writeData(0x00);
    ay.select(7);
    ay.writeData(0x3e); // enable tone A
    ay.select(8);
    ay.writeData(0x0f); // vol A max
    const out = new Float32Array(512);
    ay.render(69888, out);
    let peak = 0;
    for (const s of out) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeGreaterThan(0.01);
  });
});

describe('.Z80 snapshot', () => {
  it('decompresses ED ED runs', () => {
    const src = new Uint8Array([0xaa, 0xed, 0xed, 0x04, 0xbb, 0xcc]);
    const out = decompressZ80Block(src, 16);
    expect([...out]).toEqual([0xaa, 0xbb, 0xbb, 0xbb, 0xbb, 0xcc]);
  });

  it('loads minimal uncompressed v1 48K snapshot', () => {
    const data = new Uint8Array(30 + 0xc000);
    data[0] = 0x12; // A
    data[1] = 0x34; // F
    data[6] = 0x00;
    data[7] = 0x80; // PC = 8000
    data[8] = 0x00;
    data[9] = 0xff; // SP
    data[12] = 0x02; // border 1, uncompressed
    data[29] = 1; // IM1
    // fill bank image pattern
    data[30 + 0] = 0xde;
    data[30 + 0x4000] = 0xad;
    data[30 + 0x8000] = 0xbe;

    expect(peekZ80Model(data)).toBe('48');
    const mmu = new SpectrumMmu();
    const ula = new SpectrumUla();
    bootSpectrum(mmu, '48', ula);
    const cpu = createSoftZ80(0xffff);
    const r = applyZ80(mmu, cpu, ula, data);
    expect(r.version).toBe(1);
    expect(r.model).toBe('48');
    expect(r.pc).toBe(0x8000);
    expect(cpu.a).toBe(0x12);
    expect(mmu.banks[5]![0]).toBe(0xde);
    expect(mmu.banks[2]![0]).toBe(0xad);
    expect(mmu.banks[0]![0]).toBe(0xbe);
  });
});

describe('SNA save/load roundtrip', () => {
  it('roundtrips 48K SNA RAM banks + PC via stack', () => {
    const mmu = new SpectrumMmu();
    const ula = new SpectrumUla();
    bootSpectrum(mmu, '48', ula);
    const cpu = createSoftZ80(0xffff);
    cpu.pc = 0x1234;
    cpu.sp = 0xff00;
    cpu.a = 0xab;
    ula.border = 3;
    mmu.banks[5]![100] = 0x11;
    mmu.banks[2]![200] = 0x22;
    mmu.banks[0]![300] = 0x33;

    const sna = saveSna(mmu, cpu, ula);
    expect(isSna48(sna)).toBe(true);
    expect(sna.length).toBe(SNA_48K_SIZE);

    const mmu2 = new SpectrumMmu();
    const ula2 = new SpectrumUla();
    bootSpectrum(mmu2, '48', ula2);
    const cpu2 = createSoftZ80(0xffff);
    const r = applySna(mmu2, cpu2, ula2, sna);
    expect(r.model).toBe('48');
    expect(r.pc).toBe(0x1234);
    expect(cpu2.a).toBe(0xab);
    expect(ula2.border).toBe(3);
    expect(mmu2.banks[5]![100]).toBe(0x11);
    expect(mmu2.banks[2]![200]).toBe(0x22);
    expect(mmu2.banks[0]![300]).toBe(0x33);
  });
});

describe('TR-DOS flag stub', () => {
  it('preserves trdosPaged on 128K SNA save', () => {
    const mmu = new SpectrumMmu();
    const ula = new SpectrumUla();
    bootSpectrum(mmu, '128', ula);
    const cpu = createSoftZ80(0xffff);
    cpu.pc = 0x8000;
    mmu.trdosPaged = true;
    mmu.port7ffd = 0x10;
    // force unlocked write
    mmu.port7ffd = 0;
    mmu.out7ffd(0x10);
    mmu.trdosPaged = true;
    const sna = saveSna(mmu, cpu, ula);
    expect(sna[SNA_48K_SIZE + 3]).toBe(1);

    const mmu2 = new SpectrumMmu();
    const ula2 = new SpectrumUla();
    bootSpectrum(mmu2, '128', ula2);
    const cpu2 = createSoftZ80(0xffff);
    applySna(mmu2, cpu2, ula2, sna);
    expect(mmu2.trdosPaged).toBe(true);
  });
});

describe('bundled Spectrum demos', () => {
  it('embeds freeware TAP/SNA fixtures', async () => {
    const { SPECTRUM_GAMES, decodeSpectrumGame, findSpectrumGame } = await import(
      '../src/machine/spectrum/gamesData.js'
    );
    expect(SPECTRUM_GAMES.length).toBeGreaterThanOrEqual(5);
    const rainbow = findSpectrumGame('rainbow');
    expect(rainbow?.kind).toBe('sna');
    const sna = decodeSpectrumGame(rainbow!);
    expect(sna.length).toBe(SNA_48K_SIZE);
    expect(isSna48(sna)).toBe(true);
  });

  it('formats register watch text', async () => {
    const { formatSpectrumRegs } = await import('../src/ui/spectrumRegs.js');
    const mmu = new SpectrumMmu();
    const ula = new SpectrumUla();
    bootSpectrum(mmu, '48', ula);
    const cpu = createSoftZ80(0xffff);
    cpu.pc = 0x1234;
    cpu.a = 0xab;
    const text = formatSpectrumRegs(cpu, mmu, null);
    expect(text).toContain('PC=1234');
    expect(text).toContain('AF=ab');
    expect(text).toContain('7FFD=');
  });
});

describe('.Z80 save roundtrip', () => {
  it('roundtrips 48K regs and banks via v3 save', async () => {
    const { saveZ80, applyZ80, peekZ80Model } = await import('../src/machine/spectrum/z80snap.js');
    const { Ay8912 } = await import('../src/machine/spectrum/ay8912.js');
    const mmu = new SpectrumMmu();
    const ula = new SpectrumUla();
    bootSpectrum(mmu, '48', ula);
    const cpu = createSoftZ80(0xffff);
    cpu.pc = 0xabcd;
    cpu.sp = 0xf000;
    cpu.a = 0x11;
    cpu.f = 0x22;
    ula.border = 5;
    mmu.banks[5]![10] = 0x55;
    mmu.banks[2]![20] = 0x66;
    mmu.banks[0]![30] = 0x77;
    const ay = new Ay8912();
    ay.select(8);
    ay.writeData(0x0c);
    const z80 = saveZ80(mmu, cpu, ula, ay);
    expect(peekZ80Model(z80)).toBe('48');

    const mmu2 = new SpectrumMmu();
    const ula2 = new SpectrumUla();
    bootSpectrum(mmu2, '48', ula2);
    const cpu2 = createSoftZ80(0xffff);
    const ay2 = new Ay8912();
    const r = applyZ80(mmu2, cpu2, ula2, z80, ay2);
    expect(r.version).toBe(3);
    expect(r.pc).toBe(0xabcd);
    expect(cpu2.a).toBe(0x11);
    expect(ula2.border).toBe(5);
    expect(mmu2.banks[5]![10]).toBe(0x55);
    expect(mmu2.banks[2]![20]).toBe(0x66);
    expect(mmu2.banks[0]![30]).toBe(0x77);
    expect(ay2.regs[8]).toBe(0x0c);
  });
});

describe('TZX / SCR / NMI / stubs', () => {
  it('parses minimal TZX ID10 into TAP blocks', async () => {
    const { makeTapBlock } = await import('../src/machine/spectrum/tap.js');
    const { buildMinimalTzx, parseTzxToTapBlocks } = await import('../src/machine/spectrum/tzx.js');
    const tap = makeTapBlock(0xff, new Uint8Array([1, 2, 3, 4]));
    const tzx = buildMinimalTzx(tap.subarray(2));
    const blocks = parseTzxToTapBlocks(tzx);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.flag).toBe(0xff);
    expect([...blocks[0]!.data]).toEqual([1, 2, 3, 4]);
  });

  it('roundtrips SCR display file', async () => {
    const { saveScr, loadScr, SCR_SIZE } = await import('../src/machine/spectrum/scr.js');
    const mmu = new SpectrumMmu();
    const ula = new SpectrumUla();
    bootSpectrum(mmu, '48', ula);
    mmu.banks[5]![0] = 0xaa;
    mmu.banks[5]![0x1800] = 0x47;
    const scr = saveScr(mmu);
    expect(scr.length).toBe(SCR_SIZE);
    mmu.banks[5]!.fill(0);
    loadScr(mmu, scr);
    expect(mmu.banks[5]![0]).toBe(0xaa);
    expect(mmu.banks[5]![0x1800]).toBe(0x47);
  });

  it('soft NMI jumps to $0066', async () => {
    const { softNmi } = await import('../src/machine/softZ80.js');
    const cpu = createSoftZ80(0xffff);
    cpu.pc = 0x1234;
    cpu.sp = 0xff00;
    cpu.iff1 = true;
    cpu.iff2 = true;
    const ram = new Uint8Array(0x10000);
    softNmi(cpu, ram);
    expect(cpu.pc).toBe(0x0066);
    expect(cpu.iff1).toBe(false);
    expect(cpu.iff2).toBe(true);
  });

  it('softRun stops at breakpoint PC', async () => {
    const { softRun } = await import('../src/machine/softZ80.js');
    const cpu = createSoftZ80(0xffff);
    const ram = new Uint8Array(0x10000);
    ram[0x8000] = 0x00; // NOP
    ram[0x8001] = 0x00;
    cpu.pc = 0x8000;
    const n = softRun(cpu, ram, 100, undefined, 0x8001);
    expect(cpu.pc).toBe(0x8001);
    expect(n).toBe(1);
  });

  it('describes TAP header/data blocks', async () => {
    const { makeTapBlock, parseTap, describeTapBlock, SpectrumTape } = await import(
      '../src/machine/spectrum/tap.js'
    );
    const hdr = new Uint8Array(17);
    hdr[0] = 3;
    hdr.set(new TextEncoder().encode('TESTCODE  '), 1);
    const tap = new Uint8Array([
      ...makeTapBlock(0x00, hdr),
      ...makeTapBlock(0xff, new Uint8Array([9, 8, 7])),
    ]);
    const blocks = parseTap(tap);
    expect(describeTapBlock(blocks[0]!, 0)).toContain('CODE');
    expect(describeTapBlock(blocks[0]!, 0)).toContain('TESTCODE');
    const deck = new SpectrumTape(blocks);
    deck.next();
    expect(deck.pos).toBe(1);
    deck.reset();
    expect(deck.pos).toBe(0);
  });

  it('spectrumScreenLooksReady detects non-blank bank', async () => {
    const { spectrumScreenLooksReady } = await import('../src/machine/spectrum/ready.js');
    const mmu = new SpectrumMmu();
    const ula = new SpectrumUla();
    bootSpectrum(mmu, '48', ula);
    expect(spectrumScreenLooksReady(mmu)).toBe(false);
    mmu.banks[5]![100] = 0xff;
    expect(spectrumScreenLooksReady(mmu)).toBe(true);
  });

  it('parses TRD stub and counts contended / expansion latches', async () => {
    const {
      parseTrd,
      TRD_SIDE_SIZE,
      ContendedStub,
      ExpansionStub,
    } = await import('../src/machine/spectrum/expansions.js');
    const img = new Uint8Array(TRD_SIDE_SIZE);
    img[0x800] = 0x44; // 'D'
    img[0x801] = 0x45; // 'E'
    img[0x802] = 0x4d; // 'M'
    img[0x803] = 0x4f; // 'O'
    const trd = parseTrd(img);
    expect(trd.sides).toBe(1);
    expect(trd.label).toContain('DEMO');

    const cont = new ContendedStub();
    cont.noteAccess(0x4000);
    cont.noteAccess(0x8000);
    expect(cont.hits).toBe(1);
    expect(cont.waitUnits).toBeGreaterThan(0);
    expect(cont.applyToBudget(10_000, 1000)).toBeLessThan(10_000);

    const exp = new ExpansionStub();
    expect(ExpansionStub.isPort1ffd(0x1ffd)).toBe(true);
    exp.out1ffd(0x04);
    expect(exp.port1ffd).toBe(0x04);
    expect(exp.plusModel).toBe('+2A');
    exp.outDivmmc(0x80);
    expect(exp.divmmcPaged).toBe(true);
  });

  it('BetaDisk reads and writes TRD sectors', async () => {
    const { parseTrd, buildMinimalTrd, TRD_SECTOR_SIZE } = await import(
      '../src/machine/spectrum/expansions.js'
    );
    const { BetaDisk } = await import('../src/machine/spectrum/betaDisk.js');
    const disk = parseTrd(buildMinimalTrd('UNITTEST'));
    expect(disk.label).toMatch(/UNITTEST/);
    const beta = new BetaDisk();
    beta.mount(disk);
    beta.track = 0;
    beta.sector = 1;
    beta.outCommand(0x80); // read sector
    expect(beta.inStatus() & 0x02).toBe(0x02); // DRQ
    expect(beta.inData()).toBe(0xaa);
    beta.outCommand(0xa0);
    beta.outData(0x55);
    for (let i = 1; i < TRD_SECTOR_SIZE; i++) beta.outData(0);
    expect(disk.bytes[0]).toBe(0x55);
  });

  it('BetaDisk seek / read-address / multi-sector', async () => {
    const { buildMinimalTrd, parseTrd, TRD_SECTOR_SIZE } = await import(
      '../src/machine/spectrum/expansions.js'
    );
    const { BetaDisk, BetaStatus } = await import('../src/machine/spectrum/betaDisk.js');
    const disk = parseTrd(buildMinimalTrd('CATDISK'));
    // Put markers in consecutive sectors on track 0
    disk.bytes[0] = 0x11;
    disk.bytes[TRD_SECTOR_SIZE] = 0x22;
    const beta = new BetaDisk();
    beta.mount(disk);
    beta.data = 5;
    beta.outCommand(0x10); // seek
    expect(beta.track).toBe(5);
    expect(beta.inStatus() & BetaStatus.ST_TRACK0).toBe(0);
    beta.outCommand(0x00); // restore
    expect(beta.track).toBe(0);
    expect(beta.inStatus() & BetaStatus.ST_TRACK0).toBe(BetaStatus.ST_TRACK0);

    beta.sector = 1;
    beta.outCommand(0xc0); // read address
    expect(beta.inStatus() & BetaStatus.ST_DRQ).toBe(BetaStatus.ST_DRQ);
    expect(beta.inData()).toBe(0); // track
    expect(beta.inData()).toBe(0); // side
    expect(beta.inData()).toBe(1); // sector

    beta.sector = 1;
    beta.outCommand(0x84); // read sector + multiple
    expect(beta.inData()).toBe(0x11);
    for (let i = 1; i < TRD_SECTOR_SIZE; i++) beta.inData();
    // Continues into next sector
    expect(beta.inData()).toBe(0x22);
  });

  it('SpectrumEngine OUT FE produces beeper transitions', async () => {
    const { SpectrumEngine } = await import('../src/machine/spectrum/engine.js');
    const eng = new SpectrumEngine();
    eng.boot('48');
    eng.running = true;
    eng.ula.beginBeeperFrame();
    eng.ula.portOut(0x00fe, 0x10);
    eng.ula.setBeeperProgress(0.25);
    eng.ula.portOut(0x00fe, 0x00);
    eng.ula.setBeeperProgress(0.5);
    eng.ula.portOut(0x00fe, 0x10);
    const seg = eng.ula.beeperSegments();
    expect(seg.transitions.length).toBeGreaterThan(0);
  });

  it('AY tone enable yields non-silent render buffer', async () => {
    const { Ay8912 } = await import('../src/machine/spectrum/ay8912.js');
    const ay = new Ay8912();
    ay.reset();
    ay.select(0);
    ay.writeData(0x80);
    ay.select(1);
    ay.writeData(0x01);
    ay.select(7);
    ay.writeData(0x3e);
    ay.select(8);
    ay.writeData(0x0f);
    const out = new Float32Array(2048);
    ay.render(69888, out);
    let peak = 0;
    for (const s of out) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeGreaterThan(0.01);
  });

  it('stepOverTarget detects CALL nn', async () => {
    const { SpectrumMmu } = await import('../src/machine/spectrum/mmu.js');
    const { createSoftZ80 } = await import('../src/machine/softZ80.js');
    const { stepOverTarget } = await import('../src/machine/spectrum/engine.js');
    const { bootSpectrum } = await import('../src/machine/spectrum/boot.js');
    const mmu = new SpectrumMmu();
    bootSpectrum(mmu, '48');
    mmu.write(0x8000, 0xcd); // CALL
    mmu.write(0x8001, 0x00);
    mmu.write(0x8002, 0x90);
    const cpu = createSoftZ80(0xffff);
    cpu.pc = 0x8000;
    expect(stepOverTarget(mmu, cpu)).toBe(0x8003);
  });

  it('SpectrumEngine break-on-write freezes', async () => {
    const { SpectrumEngine } = await import('../src/machine/spectrum/engine.js');
    const eng = new SpectrumEngine();
    eng.boot('48');
    eng.setBreakWriteAddr(0x4000);
    eng.running = true;
    eng.poke = eng.poke.bind(eng);
    // Force a contended write via hooks
    eng.hooks().memWrite!(0x4000, 0x11);
    expect(eng.breakWriteHit).toBe(true);
    expect(eng.running).toBe(false);
  });

  it('encodes and decodes #sna= share', async () => {
    const { encodeSnaHash, decodeSnaHash } = await import('../src/sim/snaShare.js');
    const { SNA_48K_SIZE } = await import('../src/machine/spectrum/sna.js');
    const sna = new Uint8Array(SNA_48K_SIZE);
    sna[19] = 0x04;
    sna[25] = 1;
    const enc = await encodeSnaHash(sna);
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    expect(enc.hash.startsWith('#sna=')).toBe(true);
    const back = await decodeSnaHash(enc.hash);
    expect(back?.length).toBe(SNA_48K_SIZE);
  });
});

describe('Spectrum reboot', () => {
  it('MachineRunner.reboot after SNA returns PC to ROM entry', async () => {
    const { MachineRunner } = await import('../src/machine/MachineRunner.js');
    const { SpectrumWorkerHost } = await import('../src/machine/spectrum/SpectrumWorkerHost.js');
    const { decodeSpectrumGame, findSpectrumGame } = await import(
      '../src/machine/spectrum/gamesData.js'
    );
    const entry = findSpectrumGame('rainbow');
    expect(entry).toBeTruthy();
    const sna = decodeSpectrumGame(entry!);

    const host = new SpectrumWorkerHost();
    host.boot('48');
    const loaded = host.loadSna(sna);
    expect(loaded.pc).toBe(0x8000);
    expect(host.engine.cpu.pc).toBe(0x8000);

    const runner = new MachineRunner();
    runner.spectrumHost = host;
    runner.soft = host.engine.cpu;
    runner.spectrum = host.engine.ula;
    runner.spectrumMmu = host.engine.mmu;
    runner.spectrumTape = host.engine.tape;
    // Bypass setRunning (requires attach); reboot preserves wasRunning.
    (runner as unknown as { running: boolean }).running = true;

    runner.reboot();

    expect(runner.softCpu?.pc).toBe(0);
    expect(runner.spectrumTape).toBeNull();
    expect(runner.isSpectrum).toBe(true);
    expect(runner.spectrumModel).toBe('48');
    expect(runner.running).toBe(true);
  });
});
