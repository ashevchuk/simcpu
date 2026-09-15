import type { ChipLibrary } from '../sim/ChipLibrary.js';
import type { Circuit } from '../sim/Circuit.js';
import type { Z80Cpu } from '../sim/blocks.js';
import { makeInput, makeLabel, wire } from '../sim/library.js';
import type { InputComponent, Pin, RamComponent } from '../sim/types.js';
import { createSoftDevices, type SoftDevices } from './softDevices.js';
import { createSoftZ80, softRun, softStep, type SoftMemHooks, type SoftZ80State } from './softZ80.js';

type TickFn = () => void;

/**
 * Connect two pins via same-named local labels (short stubs) instead of a
 * drawn point-to-point wire — keeps the top-level canvas readable after
 * the Z80 folds into one chip while Inputs stay outside.
 */
function tieByLabel(circuit: Circuit, name: string, a: Pin, b: Pin): void {
  const la = makeLabel(circuit, name, { x: a.pos.x + 8, y: a.pos.y });
  wire(circuit, a, la.pins.net);
  const lb = makeLabel(circuit, name, { x: b.pos.x + 8, y: b.pos.y });
  wire(circuit, b, lb.pins.net);
}

/**
 * Run modes:
 * - soft: behavioral interpreter on ram.bytes (default — usable TTY)
 * - slow/normal/turbo/free: transistor MachineRunner with a per-frame time budget
 */
export type RunSpeed = 'soft' | 'slow' | 'normal' | 'turbo' | 'free';

/** Soft interpreter instructions per animation frame. */
export const SOFT_OPS_PER_FRAME = 8000;

/** Max wall-clock ms of gate-level phases per animation frame. */
export const GATE_BUDGET_MS = 12;

/** Wider wall-clock budget for free-running gate speed (one frame may burn more CPU). */
export const FREE_BUDGET_MS = 50;

/** Cap on FSM phases per frame when using gate speeds (time budget usually hits first). */
export const PHASES_PER_FRAME: Record<Exclude<RunSpeed, 'soft'>, number> = {
  slow: 2,
  normal: 10,
  turbo: 40,
  free: 400,
};

/**
 * Soft auto-clock / soft interpreter for a placed Z80CPU.
 * Gate path wires Input drivers like the test harness; soft path runs
 * softZ80 against the shared RamComponent.bytes.
 */
export class MachineRunner {
  private circuit: Circuit | null = null;
  private cpu: Z80Cpu | null = null;
  private ram: RamComponent | null = null;
  private tick: TickFn | null = null;
  private inputIds: string[] = [];
  private reset!: InputComponent;
  private aReset!: InputComponent;
  private dataClk!: InputComponent;
  private phaseClk!: InputComponent;
  private fsmLoad!: InputComponent;
  private seedWes: InputComponent[] = [];
  private booted = false;
  private soft: SoftZ80State | null = null;
  private devices: SoftDevices = createSoftDevices();
  /** Gate FSM seed deferred while Soft is the active speed. */
  private gateBootPending = false;
  /** True after soft Run has diverged from gate-level PC/regs. */
  softDesynced = false;
  /** Last soft interpreter error (cleared on reboot/boot). */
  softError: string | null = null;
  running = false;
  speed: RunSpeed = 'soft';
  /** Optional gate-level pin reader (from last settle) for halt detection. */
  private readPin: ((pin: Pin) => 0 | 1 | 'Z') | null = null;

  get attached(): boolean {
    return this.circuit !== null && this.cpu !== null;
  }

  get softCpu(): SoftZ80State | null {
    return this.soft;
  }

  get softDevices(): SoftDevices {
    return this.devices;
  }

  private softHooks(): SoftMemHooks {
    const ram = this.ram!;
    const dev = this.devices;
    return {
      clearOnReadKeys: true,
      portIn: (port) => dev.portIn(ram.bytes, port),
      portOut: (port, val) => dev.portOut(ram.bytes, port, val),
    };
  }

  get isSoft(): boolean {
    return this.speed === 'soft';
  }

  get phasesPerFrame(): number {
    if (this.speed === 'soft') return SOFT_OPS_PER_FRAME;
    return PHASES_PER_FRAME[this.speed];
  }

  setSpeed(speed: RunSpeed): void {
    const prev = this.speed;
    this.speed = speed;
    // Soft attach defers transistor boot — complete it the first time Gates is selected.
    if (prev === 'soft' && speed !== 'soft' && this.gateBootPending) {
      this.gateBootPending = false;
      this.booted = false;
      this.boot();
    }
  }

  /**
   * Wire clocks/reset/FSM seed/lean register zero-seeds beside the CPU.
   * Call `boot()` once afterward before Run/Step.
   *
   * Inputs sit in a compact grid next to RAM (not thousands of units away).
   * Connections use net labels so the post-fold top view does not grow a
   * "noodle" of Input→chip-port wires across the canvas.
   */
  attach(
    circuit: Circuit,
    _library: ChipLibrary,
    cpu: Z80Cpu,
    tick: TickFn,
    opts?: { readPin?: (pin: Pin) => 0 | 1 | 'Z' },
  ): void {
    this.detach();
    this.circuit = circuit;
    this.cpu = cpu;
    this.ram = cpu.ram;
    this.tick = tick;
    this.readPin = opts?.readPin ?? null;

    // Beside RAM / the eventual folded chip — old `y - 12000` parked seeds
    // far above the sprawling flat composite and became the visible spaghetti
    // once everything folded into one Z80CPU box.
    const base = { x: cpu.ram.pos.x - 360, y: cpu.ram.pos.y - 40 };
    let row = 0;
    const place = (value: 0 | 1): InputComponent => {
      const inp = makeInput(circuit, value, {
        x: base.x + (row % 6) * 44,
        y: base.y + Math.floor(row / 6) * 32,
      });
      row++;
      this.inputIds.push(inp.id);
      return inp;
    };
    let tieN = 0;
    const tie = (inp: InputComponent, pin: Pin, hint: string) => {
      tieByLabel(circuit, `RUN_${hint}_${tieN++}`, inp.pins.out, pin);
    };

    this.reset = place(1);
    tie(this.reset, cpu.reset, 'RESET');
    this.aReset = place(1);
    tie(this.aReset, cpu.aReset, 'ARESET');
    this.dataClk = place(0);
    tie(this.dataClk, cpu.clk, 'CLK');
    this.phaseClk = place(0);
    tie(this.phaseClk, cpu.phaseClk, 'PCLK');
    this.fsmLoad = place(1);
    tie(this.fsmLoad, cpu.fsmLoad, 'FSMLOAD');
    for (let i = 0; i < cpu.fsmD.length; i++) {
      const d = place(i === 0 ? 1 : 0);
      tie(d, cpu.fsmD[i]!, `FSMD${i}`);
    }

    this.seedWes = [];
    const seedReg = (reg: { we: Pin; d: Pin[] }, tag: string, width = 8) => {
      const we = place(1);
      tie(we, reg.we, `${tag}_WE`);
      this.seedWes.push(we);
      for (let i = 0; i < width; i++) {
        const bit = place(0);
        tie(bit, reg.d[i]!, `${tag}${i}`);
      }
    };

    seedReg(cpu.rB, 'B');
    seedReg(cpu.rC, 'C');
    seedReg(cpu.rD, 'D');
    seedReg(cpu.rE, 'E');
    seedReg(cpu.rH, 'H');
    seedReg(cpu.rL, 'L');
    seedReg(cpu.sp, 'SP', cpu.sp.d.length);

    this.booted = false;
    this.running = false;
    this.soft = null;
    this.devices = createSoftDevices();
    this.softDesynced = false;
    this.softError = null;
    this.gateBootPending = false;
  }

  detach(): void {
    this.running = false;
    this.booted = false;
    this.soft = null;
    this.devices = createSoftDevices();
    this.softDesynced = false;
    this.softError = null;
    this.gateBootPending = false;
    if (this.circuit) {
      for (const id of this.inputIds) this.circuit.removeComponent(id);
    }
    this.inputIds = [];
    this.seedWes = [];
    this.circuit = null;
    this.cpu = null;
    this.ram = null;
    this.tick = null;
    this.readPin = null;
  }

  /** Gate-level boot (FSM seed, reset, first fetch) + soft CPU reset. */
  boot(): void {
    if (!this.tick || !this.cpu || this.booted) return;

    // Soft is the interactive default — skip multi-second flatten/step pulses
    // until the user actually selects a Gates speed (see setSpeed).
    if (this.isSoft) {
      this.booted = true;
      this.soft = createSoftZ80(0xdff);
      this.devices = createSoftDevices();
      this.softDesynced = false;
      this.softError = null;
      this.gateBootPending = true;
      return;
    }

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
    this.soft = createSoftZ80(0xdff);
    this.devices = createSoftDevices();
    this.softDesynced = false;
    this.softError = null;
    this.gateBootPending = false;
  }

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

  /** One FSM phase on the transistor circuit (4 edges). */
  stepPhase(): void {
    if (!this.booted) this.boot();
    this.pulse(this.phaseClk);
    this.pulse(this.dataClk);
  }

  /** One full instruction: soft if speed=soft, else 10 gate phases. */
  stepInstruction(): void {
    if (!this.booted) this.boot();
    if (this.isSoft && this.soft && this.ram) {
      try {
        softStep(this.soft, this.ram.bytes, this.softHooks());
        this.softDesynced = true;
        if (this.soft.halted) this.running = false;
      } catch (e) {
        this.running = false;
        this.softError = e instanceof Error ? e.message : String(e);
        console.error(e);
      }
      return;
    }
    for (let i = 0; i < 10; i++) this.stepPhase();
    this.stopIfGateHalted();
  }

  private stopIfGateHalted(): void {
    if (!this.cpu || !this.readPin) return;
    if (this.readPin(this.cpu.halted[0]!) === 1) this.running = false;
  }

  /**
   * Advance Run for one animation frame.
   * Soft: many interpreter ops. Gate: phases until PHASES cap or GATE_BUDGET_MS.
   * Returns whether any work ran (caller should refresh TTY).
   */
  tickBudget(): boolean {
    if (!this.running || !this.booted) return false;
    if (this.isSoft && this.soft && this.ram) {
      try {
        softRun(this.soft, this.ram.bytes, SOFT_OPS_PER_FRAME, this.softHooks());
        this.softDesynced = true;
        if (this.soft.halted) this.running = false;
      } catch (e) {
        this.running = false;
        this.softError = e instanceof Error ? e.message : String(e);
        console.error(e);
      }
      return true;
    }
    const maxPhases = PHASES_PER_FRAME[this.speed as Exclude<RunSpeed, 'soft'>];
    const budgetMs = this.speed === 'free' ? FREE_BUDGET_MS : GATE_BUDGET_MS;
    const deadline = performance.now() + budgetMs;
    let n = 0;
    while (n < maxPhases && performance.now() < deadline && this.running) {
      this.stepPhase();
      n++;
      if (n % 10 === 0) this.stopIfGateHalted();
    }
    this.stopIfGateHalted();
    return n > 0;
  }

  setRunning(on: boolean): void {
    if (!this.attached) return;
    if (on && !this.booted) this.boot();
    this.running = on;
  }
}
