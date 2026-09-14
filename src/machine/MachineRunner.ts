import type { ChipLibrary } from '../sim/ChipLibrary.js';
import type { Circuit } from '../sim/Circuit.js';
import type { Z80Cpu } from '../sim/blocks.js';
import { makeInput, wire } from '../sim/library.js';
import type { InputComponent, Pin } from '../sim/types.js';

type TickFn = () => void;

/**
 * Soft auto-clock for a placed Z80CPU: wires Input drivers (like the test
 * harness) and pulses them. Not a transistor oscillator.
 *
 * `tick` must flatten+step the shared top-level sim so canvas colors stay
 * consistent with main.ts's frame loop.
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

  get attached(): boolean {
    return this.circuit !== null && this.cpu !== null;
  }

  /**
   * Wire clocks/reset/FSM seed/register zero-seeds beside the CPU.
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
      // Park off-canvas above the CPU so the editor view stays usable.
      const inp = makeInput(circuit, value, { x: base.x + (row % 8) * 50, y: base.y + Math.floor(row / 8) * 36 });
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

    seedReg(cpu.rB);
    seedReg(cpu.rC);
    seedReg(cpu.rD);
    seedReg(cpu.rE);
    seedReg(cpu.rH);
    seedReg(cpu.rL);
    seedReg(cpu.rIXH);
    seedReg(cpu.rIXL);
    seedReg(cpu.rIYH);
    seedReg(cpu.rIYL);
    seedReg(cpu.sp, cpu.sp.d.length);
    seedReg(cpu.aP);
    seedReg(cpu.fP);
    seedReg(cpu.bP);
    seedReg(cpu.cP);
    seedReg(cpu.dP);
    seedReg(cpu.eP);
    seedReg(cpu.hP);
    seedReg(cpu.lP);

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

    tick(); // settle clocks low
    pulse(this.phaseClk); // FSM -> phase 0
    this.fsmLoad.value = 0;
    pulse(this.dataClk); // PC/A reset + register seeds
    this.reset.value = 0;
    this.aReset.value = 0;
    for (const we of this.seedWes) we.value = 0;
    pulse(this.dataClk); // first fetch
    this.booted = true;
  }

  private pulse(sig: InputComponent): void {
    if (!this.tick) return;
    sig.value = 1;
    this.tick();
    sig.value = 0;
    this.tick();
  }

  /** One FSM phase: phaseClk edge then dataClk edge. */
  stepPhase(): void {
    if (!this.booted) this.boot();
    this.pulse(this.phaseClk);
    this.pulse(this.dataClk);
  }

  /** Full 10-phase instruction ring. */
  stepInstruction(): void {
    for (let i = 0; i < 10; i++) this.stepPhase();
  }

  /** Continuous-run budget: advance up to `n` phases (default 2 per frame). */
  tickBudget(n = 2): void {
    if (!this.running || !this.booted) return;
    for (let i = 0; i < n; i++) this.stepPhase();
  }

  setRunning(on: boolean): void {
    if (!this.attached) return;
    if (on && !this.booted) this.boot();
    this.running = on;
  }
}
