/**
 * Soft AY-3-8912 (Spectrum 128 ports FFFD/BFFD) + lightweight Web Audio output.
 * Tone/noise/envelope are approximate — good enough for games, not cycle-accurate.
 */

const AY_CLOCK = 1_773_400;
const SAMPLE_RATE_TARGET = 44100;

/** Log volume table (rough AY DAC). */
const VOL_TABLE = (() => {
  const t = new Float32Array(16);
  for (let i = 0; i < 16; i++) t[i] = i === 0 ? 0 : Math.pow(2, (i - 15) / 2) * 0.25;
  return t;
})();

export class Ay8912 {
  readonly regs = new Uint8Array(16);
  selected = 0;
  private tonePos = [0, 0, 0];
  private tonePeriod = [1, 1, 1];
  private toneOut = [0, 0, 0];
  private noisePos = 0;
  private noisePeriod = 1;
  private noiseOut = 0;
  private noiseLfsr = 1;
  private envPos = 0;
  private envPeriod = 1;
  private envOut = 0;
  private envHolding = false;
  private envAlternating = false;
  private envAttack = false;
  private envShape = 0;
  private envVol = 0;
  private ticks = 0;

  reset(): void {
    this.regs.fill(0);
    this.regs[7] = 0xff; // all muted
    this.selected = 0;
    this.tonePos = [0, 0, 0];
    this.toneOut = [0, 0, 0];
    this.noisePos = 0;
    this.noiseOut = 0;
    this.noiseLfsr = 1;
    this.envPos = 0;
    this.envHolding = false;
    this.envVol = 0;
    this.ticks = 0;
    this.recalc();
  }

  select(reg: number): void {
    this.selected = reg & 0x0f;
  }

  writeData(val: number): void {
    const r = this.selected;
    let v = val & 0xff;
    if (r === 1 || r === 3 || r === 5) v &= 0x0f;
    if (r === 6) v &= 0x1f;
    if (r === 8 || r === 9 || r === 10) v &= 0x1f;
    if (r === 13) v &= 0x0f;
    this.regs[r] = v;
    if (r <= 6 || r === 11 || r === 12) this.recalc();
    if (r === 13) this.resetEnvelope();
  }

  readData(): number {
    return this.regs[this.selected]!;
  }

  loadRegs(regs: Uint8Array, selected = 0): void {
    this.regs.set(regs.subarray(0, 16));
    this.selected = selected & 0x0f;
    this.recalc();
    this.resetEnvelope();
  }

  private recalc(): void {
    for (let c = 0; c < 3; c++) {
      const fine = this.regs[c * 2]!;
      const coarse = this.regs[c * 2 + 1]! & 0x0f;
      this.tonePeriod[c] = Math.max(1, fine | (coarse << 8));
    }
    this.noisePeriod = Math.max(1, this.regs[6]! & 0x1f);
    this.envPeriod = Math.max(1, this.regs[11]! | (this.regs[12]! << 8));
  }

  private resetEnvelope(): void {
    this.envShape = this.regs[13]! & 0x0f;
    this.envPos = 0;
    this.envHolding = false;
    this.envAttack = (this.envShape & 4) !== 0;
    this.envAlternating = (this.envShape & 2) !== 0;
    this.envVol = this.envAttack ? 0 : 15;
  }

  /** Advance chip by ~cpuTStates (Spectrum frame ~69888). Generate mono samples into out. */
  render(cpuTStates: number, out: Float32Array): void {
    const chipTicks = Math.max(1, Math.floor((cpuTStates * AY_CLOCK) / 3_500_000));
    const samples = out.length;
    const ticksPerSample = chipTicks / samples;
    let tickAcc = 0;
    let si = 0;
    for (let s = 0; s < samples; s++) {
      tickAcc += ticksPerSample;
      const steps = Math.floor(tickAcc);
      tickAcc -= steps;
      for (let i = 0; i < steps; i++) this.tick();
      out[s] = this.mix();
      si++;
    }
    void si;
  }

  private tick(): void {
    for (let c = 0; c < 3; c++) {
      if (++this.tonePos[c]! >= this.tonePeriod[c]!) {
        this.tonePos[c] = 0;
        this.toneOut[c] = this.toneOut[c]! ^ 1;
      }
    }
    if (++this.noisePos >= this.noisePeriod) {
      this.noisePos = 0;
      const bit0 = this.noiseLfsr & 1;
      const bit3 = (this.noiseLfsr >> 3) & 1;
      this.noiseLfsr = (this.noiseLfsr >> 1) | ((bit0 ^ bit3) << 16);
      this.noiseOut = this.noiseLfsr & 1;
    }
    if (!this.envHolding) {
      if (++this.envPos >= this.envPeriod * 2) {
        this.envPos = 0;
        if (this.envAttack) {
          if (this.envVol < 15) this.envVol++;
          else this.envEdge();
        } else {
          if (this.envVol > 0) this.envVol--;
          else this.envEdge();
        }
      }
    }
    this.ticks++;
  }

  private envEdge(): void {
    const cont = (this.envShape & 8) !== 0;
    if (!cont) {
      this.envHolding = true;
      this.envVol = 0;
      return;
    }
    if (this.envAlternating) this.envAttack = !this.envAttack;
    const hold = (this.envShape & 1) !== 0;
    if (hold) {
      this.envHolding = true;
      this.envVol = this.envAttack ? 15 : 0;
    } else {
      this.envVol = this.envAttack ? 0 : 15;
    }
  }

  private mix(): number {
    const mixer = this.regs[7]!;
    let sum = 0;
    for (let c = 0; c < 3; c++) {
      const toneDis = (mixer >> c) & 1;
      const noiseDis = (mixer >> (c + 3)) & 1;
      let on = 1;
      if (!toneDis) on &= this.toneOut[c]!;
      if (!noiseDis) on &= this.noiseOut;
      if (toneDis && noiseDis) on = 1;
      const volReg = this.regs[8 + c]!;
      const useEnv = (volReg & 0x10) !== 0;
      const level = useEnv ? this.envVol : volReg & 0x0f;
      if (on) sum += VOL_TABLE[level]!;
    }
    return Math.max(-1, Math.min(1, sum));
  }

  /** Port decode: select = FFFD (A1=1? Spectrum: OUT FFFD select, OUT BFFD data). */
  static isSelectPort(port: number): boolean {
    return (port & 0xc002) === 0xc000; // A15=1 A14=1 A1=0 → FFFD family
  }

  static isDataPort(port: number): boolean {
    return (port & 0xc002) === 0x8000; // A15=1 A14=0 A1=0 → BFFD family
  }
}

/**
 * Browser audio sink: ScriptProcessor/AudioWorklet-free pull via ScriptProcessor-like
 * AudioBufferSource scheduling each frame.
 */
export class AyAudio {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private muted = false;
  readonly chip = new Ay8912();

  async ensure(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC({ sampleRate: SAMPLE_RATE_TARGET });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.35;
    this.gain.connect(this.ctx.destination);
    this.chip.reset();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.gain) this.gain.gain.value = m ? 0 : 0.35;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Render one Spectrum frame (~20ms) of AY + optional ULA beeper (EAR edges). */
  playFrame(
    tStates = 69888,
    beeper?: { startEar: boolean; transitions: readonly { frac: number; bit: boolean }[] },
  ): void {
    if (!this.ctx || !this.gain || this.muted) return;
    const n = Math.max(64, Math.floor(this.ctx.sampleRate * (tStates / 3_500_000)));
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    this.chip.render(tStates, data);
    if (beeper) mixBeeperSquare(data, beeper.startEar, beeper.transitions);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start();
  }

  reset(): void {
    this.chip.reset();
  }
}

/** Mix ULA EAR square wave into mono buffer (transitions are 0..1 within frame). */
export function mixBeeperSquare(
  data: Float32Array,
  startEar: boolean,
  transitions: readonly { frac: number; bit: boolean }[],
  amp = 0.08,
): void {
  let ear = startEar;
  let ti = 0;
  const sorted = [...transitions].sort((a, b) => a.frac - b.frac);
  const len = data.length;
  for (let i = 0; i < len; i++) {
    const frac = i / len;
    while (ti < sorted.length && sorted[ti]!.frac <= frac) {
      ear = sorted[ti]!.bit;
      ti++;
    }
    if (ear) data[i]! += amp;
  }
}
