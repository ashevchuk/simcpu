import type { ChipLibrary } from '../sim/ChipLibrary.js';
import type { Circuit } from '../sim/Circuit.js';
import type { Z80Cpu } from '../sim/blocks.js';
import { makeInput, wire } from '../sim/library.js';
import type { InputComponent, Pin } from '../sim/types.js';

type TickFn = () => void;

export type RunSpeed = 'slow' | 'normal' | 'turbo';

/** FSM phases advanced per animation frame while running. */
export const PHASES_PER_FRAME: Record<RunSpeed, number> = {
  slow: 2,
  normal: 10,
  turbo: 40,
};

/**
 * Soft auto-clock for a placed Z80CPU: wires Input drivers (like the test
 * harness) and pulses them. Not a transistor oscillator.
 *
 * Seeds only B–L + SP (enough for the echo monitor). IX/IY/shadows stay
 * uninitialized until a program writes them — keeps the Input clutter down.
 */
export class MachineRunner {
  private circuit: Circuit | null = null;
  private cpu: Z80Cpu | null = null;
  private tick: TickFn | null = null;
  private inputIds: string[] = [];
  private reset!: InputComponent;
  private aReset!: InputComponent;
  private dataClk!: InputComponent;
  private phaseClk!: InputComponent;
  private fsmLoad!: InputComponent;
  private seedWes: InputComponent[] = [];
  private booted = false;
  running = false;
  speed: RunSpeed = 'normal';

  get attached(): boolean {
    return this.circuit !== null && this.cpu !== null;
  }

  get phasesPerFrame(): number {
    return PHASES_PER_FRAME[this.speed];
  }

  setSpeed(speed: RunSpeed): void {
    this.speed = speed;
  }

  /**
   * Wire clocks/reset/FSM seed/lean register zero-seeds beside the CPU.
   * Call `boot()` once afterward before Run/Step.
   */
  attach(circuit: Circuit, _library: ChipLibrary, cpu: Z80Cpu, tick: TickFn): void {
    this.detach();
    this.circuit = circuit;
    this.cpu = cpu;
    this.tick = tick;

    const base = { x: cpu.ram.pos.x - 200, y: cpu.ram.pos.y - 12000 };
    let row = 0;
    const place = (value: 0 | 1): InputComponent => {
      const inp = makeInput(circuit, value, {
        x: base.x + (row % 8) * 50,
        y: base.y + Math.floor(row / 8) * 36,
      });
      row++;
      this.inputIds.push(inp.id);
      return inp;
    };

    this.reset = place(1);
    wire(circuit, this.reset.pins.out, cpu.reset);
    this.aReset = place(1);
    wire(circuit, this.aReset.pins.out, cpu.aReset);
    this.dataClk = place(0);
    wire(circuit, this.dataClk.pins.out, cpu.clk);
    this.phaseClk = place(0);
    wire(circuit, this.phaseClk.pins.out, cpu.phaseClk);
    this.fsmLoad = place(1);
    wire(circuit, this.fsmLoad.pins.out, cpu.fsmLoad);
    for (let i = 0; i < cpu.fsmD.length; i++) {
      const d = place(i === 0 ? 1 : 0);
      wire(circuit, d.pins.out, cpu.fsmD[i]!);
    }

    this.seedWes = [];
    const seedReg = (reg: { we: Pin; d: Pin[] }, width = 8) => {
      const we = place(1);
      wire(circuit, we.pins.out, reg.we);
      this.seedWes.push(we);
      for (let i = 0; i < width; i++) {
        const bit = place(0);
        wire(circuit, bit.pins.out, reg.d[i]!);
      }
    };

    // Lean set — echo monitor needs HL/A/B; SP for any stack use.
    seedReg(cpu.rB);
    seedReg(cpu.rC);
    seedReg(cpu.rD);
    seedReg(cpu.rE);
    seedReg(cpu.rH);
    seedReg(cpu.rL);
    seedReg(cpu.sp, cpu.sp.d.length);

    this.booted = false;
    this.running = false;
  }

  detach(): void {
    this.running = false;
    this.booted = false;
    if (this.circuit) {
      for (const id of this.inputIds) this.circuit.removeComponent(id);
    }
    this.inputIds = [];
    this.seedWes = [];
    this.circuit = null;
    this.cpu = null;
    this.tick = null;
  }

  /** Mirror test/z80Harness boot: FSM seed, reset/seed registers, first fetch. */
  boot(): void {
    if (!this.tick || !this.cpu || this.booted) return;
    const tick = this.tick;
    const pulse = (sig: InputComponent) => {
      sig.value = 1;
      tick();
      sig.value = 0;
      tick();
    };

    tick();
    pulse(this.phaseClk);
    this.fsmLoad.value = 0;
    pulse(this.dataClk);
    this.reset.value = 0;
    this.aReset.value = 0;
    for (const we of this.seedWes) we.value = 0;
    pulse(this.dataClk);
    this.booted = true;
  }

  /**
   * Force PC back through reset + re-seed + first fetch.
   * Used after soft `G addr` patches JP at 0000.
   */
  reboot(): void {
    if (!this.tick || !this.cpu) return;
    const wasRunning = this.running;
    this.running = false;
    this.booted = false;
    this.reset.value = 1;
    this.aReset.value = 1;
    this.fsmLoad.value = 1;
    for (const we of this.seedWes) we.value = 1;
    this.dataClk.value = 0;
    this.phaseClk.value = 0;
    this.boot();
    if (wasRunning) this.running = true;
  }

  private pulse(sig: InputComponent): void {
    if (!this.tick) return;
    sig.value = 1;
    this.tick();
    sig.value = 0;
    this.tick();
  }

  stepPhase(): void {
    if (!this.booted) this.boot();
    this.pulse(this.phaseClk);
    this.pulse(this.dataClk);
  }

  stepInstruction(): void {
    for (let i = 0; i < 10; i++) this.stepPhase();
  }

  tickBudget(n = this.phasesPerFrame): void {
    if (!this.running || !this.booted) return;
    for (let i = 0; i < n; i++) this.stepPhase();
  }

  setRunning(on: boolean): void {
    if (!this.attached) return;
    if (on && !this.booted) this.boot();
    this.running = on;
  }
}
