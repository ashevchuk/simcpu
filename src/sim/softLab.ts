/**
 * Soft Lab — optional behavioral eval for heavy digital-lab chips.
 *
 * When enabled, flatten() leaves matching chip instances opaque and solver.ts
 * drives their ports from truth tables / edge-triggered state (same idea as
 * RAM). Dive-in / Soft Lab off still expands the hierarchical transistor defs.
 */

import { bumpStructureVersion } from './Circuit.js';
import type { ChipInstanceComponent, Level } from './types.js';

export type SoftLabState = {
  model: string;
  lastClk: 0 | 1 | 'Z';
  /** Sequential bit storage (0/1). Length depends on the model. */
  q: Uint8Array;
};

const SOFT_LAB_LS_KEY = 'simcpu.softLab.v1';

let softLabEnabled = true;

/** Def names forced to transistor-expand this session (Soft Lab still on). */
const softExpandForced = new Set<string>();

export function isSoftLabEnabled(): boolean {
  return softLabEnabled;
}

export function setSoftLabEnabled(on: boolean): void {
  if (softLabEnabled === on) return;
  softLabEnabled = on;
  bumpStructureVersion();
}

/** When Soft Lab is on, force this ChipDef.name to expand to transistors. */
export function setSoftExpandForced(defName: string, forced: boolean): void {
  const before = softExpandForced.has(defName);
  if (forced) softExpandForced.add(defName);
  else softExpandForced.delete(defName);
  if (before !== forced) bumpStructureVersion();
}

export function isSoftExpandForced(defName: string): boolean {
  return softExpandForced.has(defName);
}

export function clearSoftExpandForced(): void {
  if (softExpandForced.size === 0) return;
  softExpandForced.clear();
  bumpStructureVersion();
}

export function loadSoftLabPreference(): boolean {
  try {
    const raw = localStorage.getItem(SOFT_LAB_LS_KEY);
    if (raw === '0' || raw === 'false') softLabEnabled = false;
    else if (raw === '1' || raw === 'true') softLabEnabled = true;
  } catch {
    /* ignore */
  }
  return softLabEnabled;
}

export function persistSoftLabPreference(): void {
  try {
    localStorage.setItem(SOFT_LAB_LS_KEY, softLabEnabled ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** Clear Soft Lab sequential state on chip instances in a circuit. */
export function clearSoftLabState(circuit: { components: Map<string, { kind: string; softState?: SoftLabState }> }): void {
  for (const c of circuit.components.values()) {
    if (c.kind === 'chip' && c.softState) delete c.softState;
  }
  bumpStructureVersion();
}

/** Canonical model keys that Soft Lab can evaluate. */
const MODEL_BITS: Record<string, number> = {
  SR_LATCH: 1,
  JK_FF: 1,
  T_FF: 1,
  REG4: 4,
  REG8: 8,
  SHIFT4_SIPO: 4,
  SHIFT8_SIPO: 8,
  SHIFT4_PISO: 4,
  SHIFT8_PISO: 8,
  COUNTER4: 4,
  COUNTER8: 8,
  LATCH8: 8,
  CLK_DIV2: 1,
  CLK_DIV16: 4,
  // combinatorial — q unused / length 0
  DECODER_2_4: 0,
  DECODER_3_8: 0,
  ENCODER_8_3: 0,
  COMP2: 0,
  COMP4: 0,
  BCD_7SEG: 0,
  BUF8: 0,
  INV8: 0,
  MUX8_1: 0,
  DEMUX_1_8: 0,
  HALF_ADDER: 0,
  FULL_ADDER: 0,
  ADDER4: 0,
  ADDER8: 0,
  ALU4: 0,
  ALU8: 0,
  /** Soft 16×8 RAM (q holds 16 bytes); wraps real RAM when expanded. */
  SOFT_RAM16: 16,
  // 74xx alias soft models (opaque wrappers only — not bare NAND/D_FF/…)
  '7400': 0,
  '7404': 0,
  '7408': 0,
  '7432': 0,
  '7486': 0,
  '7474': 1,
  '74157_1': 0,
};

const ALIAS_TO_MODEL: Record<string, string> = {
  SIPO8: 'SHIFT8_SIPO',
  PISO8: 'SHIFT8_PISO',
  '74161': 'COUNTER4',
  '74164': 'SHIFT8_SIPO',
  '74165': 'SHIFT8_PISO',
  '74138': 'DECODER_3_8',
  '74139': 'DECODER_2_4',
  '74373': 'LATCH8',
  '74374': 'REG8',
  '7447': 'BCD_7SEG',
};

export function softLabModelKey(chipName: string): string | null {
  if (MODEL_BITS[chipName] !== undefined) return chipName;
  if (ALIAS_TO_MODEL[chipName]) return ALIAS_TO_MODEL[chipName]!;
  return null;
}

export function hasSoftLabModel(chipName: string): boolean {
  return softLabModelKey(chipName) != null;
}

export function ensureSoftState(chip: ChipInstanceComponent, model: string): SoftLabState {
  const bits = MODEL_BITS[model] ?? 0;
  if (!chip.softState || chip.softState.model !== model || chip.softState.q.length !== bits) {
    chip.softState = {
      model,
      lastClk: 0,
      q: new Uint8Array(bits),
    };
  }
  return chip.softState;
}

function bit(levels: Record<string, Level>, name: string, defaultVal: 0 | 1 = 0): 0 | 1 {
  const v = levels[name];
  if (v === 0 || v === 1) return v;
  return defaultVal;
}

function rising(prev: 0 | 1 | 'Z', cur: Level): boolean {
  return prev !== 1 && cur === 1;
}

const SEG_MAP: Record<number, number> = {
  // bit0=a … bit6=g
  0: 0b0111111,
  1: 0b0000110,
  2: 0b1011011,
  3: 0b1001111,
  4: 0b1100110,
  5: 0b1101101,
  6: 0b1111101,
  7: 0b0000111,
  8: 0b1111111,
  9: 0b1101111,
};

/**
 * Drive output nets for one Soft Lab chip (relaxation pass).
 * Returns list of { netIdx, bit } forced levels — caller ORs into softMask.
 */
export function softLabDriveOutputs(
  model: string,
  pinNet: Record<string, number | undefined>,
  levels: Record<string, Level>,
  state: SoftLabState,
  force: (netIdx: number, bit: 0 | 1) => void,
): void {
  const out = (name: string, v: 0 | 1) => {
    const idx = pinNet[name];
    if (idx !== undefined) force(idx, v);
  };

  switch (model) {
    case 'SR_LATCH': {
      const s = bit(levels, 's');
      const r = bit(levels, 'r');
      if (s && !r) state.q[0] = 1;
      else if (r && !s) state.q[0] = 0;
      // both 1: hold (avoid illegal race in soft model)
      const q = state.q[0]! as 0 | 1;
      out('q', q);
      out('qn', (q ^ 1) as 0 | 1);
      return;
    }
    case 'JK_FF':
    case 'T_FF': {
      const q = state.q[0]! as 0 | 1;
      out('q', q);
      out('qn', (q ^ 1) as 0 | 1);
      return;
    }
    case 'CLK_DIV2':
      out('out', state.q[0]! as 0 | 1);
      return;
    case 'CLK_DIV16':
      out('out', state.q[3]! as 0 | 1);
      return;
    case 'REG4':
    case 'REG8':
    case 'SHIFT4_SIPO':
    case 'SHIFT8_SIPO':
    case 'LATCH8': {
      for (let i = 0; i < state.q.length; i++) out(`q${i}`, state.q[i]! as 0 | 1);
      return;
    }
    case 'COUNTER4': {
      for (let i = 0; i < state.q.length; i++) out(`q${i}`, state.q[i]! as 0 | 1);
      const v = state.q[0]! | (state.q[1]! << 1) | (state.q[2]! << 2) | (state.q[3]! << 3);
      const clr = bit(levels, 'clr');
      const ce = bit(levels, 'ce', 1);
      out('co', v === 15 && ce && !clr ? 1 : 0);
      return;
    }
    case 'COUNTER8': {
      for (let i = 0; i < state.q.length; i++) out(`q${i}`, state.q[i]! as 0 | 1);
      let v = 0;
      for (let i = 0; i < 8; i++) v |= (state.q[i]! & 1) << i;
      const clr = bit(levels, 'clr');
      const ce = bit(levels, 'ce', 1);
      out('co', v === 255 && ce && !clr ? 1 : 0);
      return;
    }
    case 'SHIFT4_PISO':
    case 'SHIFT8_PISO': {
      for (let i = 0; i < state.q.length; i++) out(`q${i}`, state.q[i]! as 0 | 1);
      out('sout', state.q[state.q.length - 1]! as 0 | 1);
      return;
    }
    case 'DECODER_2_4':
    case 'DECODER_3_8': {
      const bits = model === 'DECODER_2_4' ? 2 : 3;
      const en = bit(levels, 'en', 1);
      const n = 1 << bits;
      if (!en) {
        for (let i = 0; i < n; i++) out(`y${i}`, 0);
        return;
      }
      let addr = 0;
      for (let i = 0; i < bits; i++) if (bit(levels, `a${i}`)) addr |= 1 << i;
      for (let i = 0; i < n; i++) out(`y${i}`, i === addr ? 1 : 0);
      return;
    }
    case 'ENCODER_8_3': {
      let idx = 0;
      let found = false;
      for (let i = 7; i >= 0; i--) {
        if (bit(levels, `in${i}`)) {
          idx = i;
          found = true;
          break;
        }
      }
      out('y0', found && idx & 1 ? 1 : 0);
      out('y1', found && idx & 2 ? 1 : 0);
      out('y2', found && idx & 4 ? 1 : 0);
      return;
    }
    case 'COMP2':
    case 'COMP4': {
      const n = model === 'COMP2' ? 2 : 4;
      let a = 0;
      let b = 0;
      for (let i = 0; i < n; i++) {
        if (bit(levels, `a${i}`)) a |= 1 << i;
        if (bit(levels, `b${i}`)) b |= 1 << i;
      }
      out('eq', a === b ? 1 : 0);
      out('gt', a > b ? 1 : 0);
      out('lt', a < b ? 1 : 0);
      return;
    }
    case 'BCD_7SEG': {
      let d = 0;
      for (let i = 0; i < 4; i++) if (bit(levels, `d${i}`)) d |= 1 << i;
      const seg = d <= 9 ? SEG_MAP[d]! : 0; // blank invalid BCD
      const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;
      for (let i = 0; i < 7; i++) out(names[i]!, (seg >> i) & 1 ? 1 : 0);
      return;
    }
    case 'BUF8':
      // Only drive when oe=1; otherwise leave Z (tri-state).
      if (bit(levels, 'oe', 1) !== 1) return;
      for (let i = 0; i < 8; i++) out(`out${i}`, bit(levels, `in${i}`));
      return;
    case 'INV8':
      for (let i = 0; i < 8; i++) out(`out${i}`, (bit(levels, `in${i}`) ^ 1) as 0 | 1);
      return;
    case 'MUX8_1': {
      const sel =
        bit(levels, 'sel0') | (bit(levels, 'sel1') << 1) | (bit(levels, 'sel2') << 2);
      out('out', bit(levels, `in${sel}`));
      return;
    }
    case 'DEMUX_1_8': {
      const sel =
        bit(levels, 'sel0') | (bit(levels, 'sel1') << 1) | (bit(levels, 'sel2') << 2);
      const d = bit(levels, 'in');
      for (let i = 0; i < 8; i++) out(`y${i}`, i === sel ? d : 0);
      return;
    }
    case 'HALF_ADDER': {
      const a = bit(levels, 'a');
      const b = bit(levels, 'b');
      out('sum', (a ^ b) as 0 | 1);
      out('cout', (a & b) as 0 | 1);
      return;
    }
    case 'FULL_ADDER': {
      const a = bit(levels, 'a');
      const b = bit(levels, 'b');
      const cin = bit(levels, 'cin');
      out('sum', (a ^ b ^ cin) as 0 | 1);
      out('cout', ((a & b) | (a & cin) | (b & cin)) as 0 | 1);
      return;
    }
    case 'ADDER4':
    case 'ADDER8': {
      const n = model === 'ADDER4' ? 4 : 8;
      let cin = bit(levels, 'cin');
      for (let i = 0; i < n; i++) {
        const a = bit(levels, `a${i}`);
        const b = bit(levels, `b${i}`);
        out(`sum${i}`, (a ^ b ^ cin) as 0 | 1);
        cin = ((a & b) | (a & cin) | (b & cin)) as 0 | 1;
      }
      out('cout', cin);
      return;
    }
    case 'ALU4':
    case 'ALU8': {
      // op: 00=add, 01=sub, 10=and, 11=or
      const n = model === 'ALU8' ? 8 : 4;
      const op0 = bit(levels, 'op0');
      const op1 = bit(levels, 'op1');
      if (!op1) {
        let cin: 0 | 1 = op0 ? 1 : 0; // sub: cin=1
        for (let i = 0; i < n; i++) {
          const a = bit(levels, `a${i}`);
          const bRaw = bit(levels, `b${i}`);
          const b = (op0 ? (bRaw ^ 1) : bRaw) as 0 | 1;
          out(`s${i}`, (a ^ b ^ cin) as 0 | 1);
          cin = ((a & b) | (a & cin) | (b & cin)) as 0 | 1;
        }
        out('cout', cin);
      } else if (!op0) {
        for (let i = 0; i < n; i++) out(`s${i}`, (bit(levels, `a${i}`) & bit(levels, `b${i}`)) as 0 | 1);
        out('cout', 0);
      } else {
        for (let i = 0; i < n; i++) out(`s${i}`, (bit(levels, `a${i}`) | bit(levels, `b${i}`)) as 0 | 1);
        out('cout', 0);
      }
      return;
    }
    case 'SOFT_RAM16': {
      // Continuous OE-gated read onto data0..7 (write is edge-committed).
      let addr = 0;
      for (let i = 0; i < 4; i++) addr |= bit(levels, `addr${i}`) << i;
      const byte = state.q[addr & 15] ?? 0;
      if (bit(levels, 'oe') === 1) {
        for (let i = 0; i < 8; i++) out(`data${i}`, ((byte >> i) & 1) as 0 | 1);
      }
      return;
    }
    case '7400': // NAND
      out('out', ((bit(levels, 'a') & bit(levels, 'b')) ^ 1) as 0 | 1);
      return;
    case '7404': // NOT
      out('out', (bit(levels, 'in') ^ 1) as 0 | 1);
      return;
    case '7408': // AND
      out('out', (bit(levels, 'a') & bit(levels, 'b')) as 0 | 1);
      return;
    case '7432': // OR
      out('out', (bit(levels, 'a') | bit(levels, 'b')) as 0 | 1);
      return;
    case '7486': // XOR
      out('out', (bit(levels, 'a') ^ bit(levels, 'b')) as 0 | 1);
      return;
    case '7474': {
      const q = state.q[0]! as 0 | 1;
      out('q', q);
      out('qn', (q ^ 1) as 0 | 1);
      return;
    }
    case '74157_1': {
      // MUX2: sel picks in0/in1
      out('out', bit(levels, bit(levels, 'sel') ? 'in1' : 'in0'));
      return;
    }
    default:
      return;
  }
}

/** Apply rising-edge / level-sensitive updates after nets settle. */
export function softLabCommitEdges(
  model: string,
  levels: Record<string, Level>,
  state: SoftLabState,
): void {
  const clk = levels.clk;
  const clkLvl: Level = clk === 0 || clk === 1 || clk === 'Z' ? clk : 'Z';

  switch (model) {
    case 'JK_FF': {
      if (rising(state.lastClk, clkLvl)) {
        const j = bit(levels, 'j');
        const k = bit(levels, 'k');
        const q = state.q[0]!;
        if (j && !k) state.q[0] = 1;
        else if (!j && k) state.q[0] = 0;
        else if (j && k) state.q[0] = q ^ 1;
      }
      break;
    }
    case 'T_FF': {
      if (rising(state.lastClk, clkLvl)) {
        if (bit(levels, 'clr', 0) === 1) state.q[0] = 0;
        else if (bit(levels, 't') === 1) state.q[0] = state.q[0]! ^ 1;
      }
      break;
    }
    case 'REG4':
    case 'REG8': {
      const n = model === 'REG4' ? 4 : 8;
      if (rising(state.lastClk, clkLvl) && bit(levels, 'we') === 1) {
        for (let i = 0; i < n; i++) state.q[i] = bit(levels, `d${i}`);
      }
      break;
    }
    case 'SHIFT4_SIPO':
    case 'SHIFT8_SIPO': {
      const n = model.includes('4') ? 4 : 8;
      if (rising(state.lastClk, clkLvl)) {
        for (let i = n - 1; i > 0; i--) state.q[i] = state.q[i - 1]!;
        state.q[0] = bit(levels, 'sin');
      }
      break;
    }
    case 'SHIFT4_PISO':
    case 'SHIFT8_PISO': {
      const n = model.includes('4') ? 4 : 8;
      if (rising(state.lastClk, clkLvl)) {
        if (bit(levels, 'load') === 1) {
          for (let i = 0; i < n; i++) state.q[i] = bit(levels, `d${i}`);
        } else {
          for (let i = n - 1; i > 0; i--) state.q[i] = state.q[i - 1]!;
          state.q[0] = 0;
        }
      }
      break;
    }
    case 'COUNTER4': {
      if (rising(state.lastClk, clkLvl)) {
        if (bit(levels, 'clr') === 1) {
          state.q.fill(0);
        } else if (bit(levels, 'load') === 1) {
          for (let i = 0; i < 4; i++) state.q[i] = bit(levels, `d${i}`);
        } else if (bit(levels, 'ce', 1) === 1) {
          let v = state.q[0]! | (state.q[1]! << 1) | (state.q[2]! << 2) | (state.q[3]! << 3);
          v = (v + 1) & 0xf;
          for (let i = 0; i < 4; i++) state.q[i] = (v >> i) & 1;
        }
      }
      break;
    }
    case 'COUNTER8': {
      if (rising(state.lastClk, clkLvl)) {
        if (bit(levels, 'clr') === 1) {
          state.q.fill(0);
        } else if (bit(levels, 'load') === 1) {
          for (let i = 0; i < 8; i++) state.q[i] = bit(levels, `d${i}`);
        } else if (bit(levels, 'ce', 1) === 1) {
          let v = 0;
          for (let i = 0; i < 8; i++) v |= (state.q[i]! & 1) << i;
          v = (v + 1) & 0xff;
          for (let i = 0; i < 8; i++) state.q[i] = (v >> i) & 1;
        }
      }
      break;
    }
    case '7474': {
      if (rising(state.lastClk, clkLvl)) {
        state.q[0] = bit(levels, 'd');
      }
      break;
    }
    case 'LATCH8': {
      if (bit(levels, 'en') === 1) {
        for (let i = 0; i < 8; i++) state.q[i] = bit(levels, `d${i}`);
      }
      break;
    }
    case 'CLK_DIV2': {
      if (rising(state.lastClk, clkLvl)) {
        if (bit(levels, 'clr') === 1) state.q[0] = 0;
        else state.q[0] = state.q[0]! ^ 1;
      }
      break;
    }
    case 'CLK_DIV16': {
      if (rising(state.lastClk, clkLvl)) {
        if (bit(levels, 'clr') === 1) state.q.fill(0);
        else {
          let v = state.q[0]! | (state.q[1]! << 1) | (state.q[2]! << 2) | (state.q[3]! << 3);
          v = (v + 1) & 0xf;
          for (let i = 0; i < 4; i++) state.q[i] = (v >> i) & 1;
        }
      }
      break;
    }
    case 'SOFT_RAM16': {
      if (rising(state.lastClk, clkLvl) && bit(levels, 'we') === 1) {
        let addr = 0;
        for (let i = 0; i < 4; i++) addr |= bit(levels, `addr${i}`) << i;
        let byte = 0;
        for (let i = 0; i < 8; i++) byte |= bit(levels, `data${i}`) << i;
        state.q[addr & 15] = byte & 0xff;
      }
      break;
    }
    default:
      break;
  }

  if (clkLvl === 0 || clkLvl === 1) state.lastClk = clkLvl;
  else state.lastClk = 'Z';
}
