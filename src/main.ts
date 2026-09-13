import { buildAlu, buildInstructionRegister, buildMinimalCpu, buildProgramCounter, buildRegister, buildRingCounter, buildStubRom, buildZ80Cpu } from './sim/blocks.js';
import { ChipLibrary } from './sim/ChipLibrary.js';
import { Circuit } from './sim/Circuit.js';
import { flatten, fold, renamePort } from './sim/hierarchy.js';
import { buildNot, makeInput, makeProbe, makeRam, makeSource, wire } from './sim/library.js';
import {
  deserializeProject,
  importChipDef,
  serializeChipDef,
  serializeProject,
  type SerializedChipBundle,
  type SerializedProject,
} from './sim/serialize.js';
import { initialState, step } from './sim/solver.js';
import { seedStandardCells } from './sim/stdcells.js';
import type { ChipInstanceComponent, Component, Level, SimState } from './sim/types.js';
import { Camera, type Bounds } from './ui/Camera.js';
import { showAlert, showConfirm, showPrompt } from './ui/Dialog.js';
import { Editor, type Tool } from './ui/Editor.js';
import { GRID, snap } from './ui/geometry.js';
import { draw } from './ui/Renderer.js';

const stage = document.getElementById('stage') as HTMLDivElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('2D canvas context is not available');

const library = new ChipLibrary();
seedStandardCells(library); // NOT/NAND/AND/NOR/OR/XOR/MUX2/MUX4/FULL_ADDER/D_LATCH/D_FF, ready to drag out
const topCircuit = new Circuit();
seedDemoCircuit(topCircuit);

function seedDemoCircuit(c: Circuit): void {
  const vcc = makeSource(c, 1, { x: 80, y: 60 }).pins.out;
  const gnd = makeSource(c, 0, { x: 80, y: 140 }).pins.out;
  const notGate = buildNot(c, vcc, gnd, { x: 220, y: 70 });
  const input = makeInput(c, 0, { x: 140, y: 100 });
  const probe = makeProbe(c, { x: 300, y: 100 }, 'out');
  wire(c, input.pins.out, notGate.in);
  wire(c, notGate.out, probe.pins.in);
}

/** Bounding box of every component's center in `circuit`, padded a little, for fit/center-on-dive. */
function circuitBounds(circuit: Circuit): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of circuit.components.values()) {
    minX = Math.min(minX, c.pos.x);
    minY = Math.min(minY, c.pos.y);
    maxX = Math.max(maxX, c.pos.x);
    maxY = Math.max(maxY, c.pos.y);
  }
  if (!Number.isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  const pad = 60;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}
function centroid(b: Bounds): { x: number; y: number } {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

// --- Camera --------------------------------------------------------------
const camera = new Camera();
function viewportSize(): { w: number; h: number } {
  const rect = stage.getBoundingClientRect();
  return { w: rect.width, h: rect.height };
}
function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  const { w, h } = viewportSize();
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx!.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS-pixel units regardless of device pixel ratio
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// --- Hierarchy navigation ------------------------------------------------
// The live simulation always flattens from `topCircuit` regardless of which
// level is being viewed (see hierarchy.ts's flatten()). `navStack` only
// tracks *what the editor currently shows*: the circuit itself, the
// namespace path (see flatten()'s doc comment) needed to translate that
// circuit's local pin ids into the flattened simulation's net ids so the
// live colors line up even while dived inside a chip's internals, and
// (below the top) which ChipDef this level belongs to, for renamePort().
interface NavFrame {
  circuit: Circuit;
  pathPrefix: string;
  label: string;
  defId?: string;
}
const navStack: NavFrame[] = [{ circuit: topCircuit, pathPrefix: '', label: 'top' }];

const editor = new Editor(topCircuit, library);
let simState: SimState = initialState();

// A single window-level, capture-phase tap on every event type that could
// possibly change what the next frame ought to look like — mouse/keyboard
// interaction with the canvas or a dialog, wheel zoom, a toolbar button
// click, a window resize — set unconditionally to `true`, never read or
// cleared here. `frame()` below is the only place that ever sets it back to
// `false`, once it has actually redrawn for that reason. Deliberately a
// blunt, over-inclusive net rather than threading a precise "this specific
// mutation changed something visible" flag through Editor/Camera/every
// toolbar handler individually: a stray extra redraw costs nothing a user
// can perceive, but a missed one means a stale frame sitting on screen — see
// `frame()`'s own doc comment for why marking too eagerly is the safe
// direction to err in here.
let uiDirty = true;
for (const evtName of ['mousedown', 'mousemove', 'mouseup', 'dblclick', 'wheel', 'keydown', 'keyup', 'click', 'change', 'resize']) {
  window.addEventListener(evtName, () => (uiDirty = true), { capture: true, passive: true });
}

function diveInto(inst: ChipInstanceComponent): void {
  const def = library.get(inst.defId);
  const parent = navStack[navStack.length - 1]!;
  navStack.push({
    circuit: def.circuit,
    pathPrefix: `${parent.pathPrefix}${inst.id}/`,
    label: def.name,
    defId: def.id,
  });
  enterLevel();
}

function diveTo(index: number): void {
  navStack.length = index + 1;
  enterLevel();
}

function enterLevel(): void {
  const view = navStack[navStack.length - 1]!;
  editor.circuit = view.circuit;
  editor.clearSelection();
  editor.cancelWire();
  // "Auto-centered at 100%" — see the reference project's own dive-in behavior.
  camera.centerOn(centroid(circuitBounds(view.circuit)), 1);
  renderBreadcrumb();
}

const breadcrumbEl = document.getElementById('breadcrumb') as HTMLDivElement;
function renderBreadcrumb(): void {
  breadcrumbEl.replaceChildren();
  navStack.forEach((frame, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = ' › ';
      breadcrumbEl.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.textContent = frame.label;
    btn.addEventListener('click', () => diveTo(i));
    breadcrumbEl.appendChild(btn);
  });
}
renderBreadcrumb();
camera.centerOn(centroid(circuitBounds(topCircuit)), 1);

// --- Chip palette: place an instance of any folded chip ------------------
const chipPaletteEl = document.getElementById('chip-palette') as HTMLDivElement;
function refreshChipPalette(): void {
  chipPaletteEl.replaceChildren();
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = 'chips:';
  chipPaletteEl.appendChild(hint);
  for (const def of library.list()) {
    const btn = document.createElement('button');
    btn.textContent = def.name;
    btn.dataset.defId = def.id;
    btn.classList.toggle('active', editor.tool.kind === 'place-chip' && editor.tool.defId === def.id);
    btn.addEventListener('click', () => setTool({ kind: 'place-chip', defId: def.id }));
    chipPaletteEl.appendChild(btn);
  }
}
refreshChipPalette();

// --- Toolbar + cursor ----------------------------------------------------
const CURSOR: Record<Tool['kind'], string> = {
  select: 'default',
  pan: 'grab',
  wire: 'crosshair',
  nmos: 'copy',
  pmos: 'copy',
  vcc: 'copy',
  gnd: 'copy',
  input: 'copy',
  probe: 'copy',
  label: 'copy',
  'place-chip': 'copy',
};
const toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tool]'));
// Built from each button's own data-key, not hand-duplicated here, so the
// keyboard shortcut and its on-screen (N) hint (index.html) can't drift apart.
const TOOL_KEYS = new Map<string, Tool>(
  toolButtons
    .filter((b) => b.dataset.key)
    .map((b) => [b.dataset.key!, { kind: b.dataset.tool as Exclude<Tool['kind'], 'place-chip'> }]),
);
function setTool(tool: Tool): void {
  editor.tool = tool;
  editor.cancelWire();
  editor.marqueeStart = null;
  for (const b of toolButtons) b.classList.toggle('active', b.dataset.tool === tool.kind);
  canvas.style.cursor = CURSOR[tool.kind];
  refreshChipPalette();
}
for (const b of toolButtons) {
  b.addEventListener('click', () => setTool({ kind: b.dataset.tool as Exclude<Tool['kind'], 'place-chip'> }));
}
setTool({ kind: 'select' });

document.getElementById('clear')?.addEventListener('click', async () => {
  if (!(await showConfirm('Clear this level of the circuit?'))) return;
  editor.circuit.components.clear();
  editor.circuit.wires.clear();
  editor.clearSelection();
  editor.cancelWire();
});

document.getElementById('fold')?.addEventListener('click', () => void foldSelection());

async function foldSelection(): Promise<void> {
  if (editor.selectedIds.size === 0) return;
  const name = await showPrompt('Chip name:', 'CHIP');
  if (!name) return;
  const pos = snap(centroid(boundsOfSelection()));
  const { instance } = fold(editor.circuit, editor.selectedIds, name, library, pos);
  editor.selectedIds = new Set([instance.id]);
  refreshChipPalette();
}

function boundsOfSelection(): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of editor.selectedIds) {
    const c = editor.circuit.components.get(id);
    if (!c) continue;
    minX = Math.min(minX, c.pos.x);
    minY = Math.min(minY, c.pos.y);
    maxX = Math.max(maxX, c.pos.x);
    maxY = Math.max(maxY, c.pos.y);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

// --- Insert prebuilt blocks ------------------------------------------------
// buildRegister()/buildAlu() (blocks.ts) place several wired-together chip
// instances at once — placing that many raw transistors by hand (a naive
// 8-bit register is on the order of 8 * ~60 transistors) isn't a reasonable
// ask of anyone clicking a palette. Width is prompted, not a fixed 8, since
// nothing else about these functions is width-specific.
async function promptWidth(label: string): Promise<number | null> {
  const raw = await showPrompt(`${label} width (bits):`, '4');
  if (!raw) return null;
  const bits = Math.trunc(Number(raw));
  if (!Number.isFinite(bits) || bits < 1) return null;
  return Math.min(bits, 32); // a soft cap — a wider composite means more top-level components for the still-unfixed Canvas 2D render cost (see ARCHITECTURE.md's "Canvas 2D rendering cost"), not a flatten() cost anymore
}

document.getElementById('add-register')?.addEventListener('click', async () => {
  const bits = await promptWidth('Register');
  if (bits === null) return;
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  buildRegister(editor.circuit, library, bits, pos);
  refreshChipPalette();
});

document.getElementById('add-alu')?.addEventListener('click', async () => {
  const bits = await promptWidth('ALU');
  if (bits === null) return;
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  buildAlu(editor.circuit, library, bits, pos);
  refreshChipPalette();
});

document.getElementById('add-pc')?.addEventListener('click', async () => {
  const bits = await promptWidth('Program counter');
  if (bits === null) return;
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  buildProgramCounter(editor.circuit, library, bits, pos);
  refreshChipPalette();
});

document.getElementById('add-ir')?.addEventListener('click', () => {
  // No width prompt: an instruction register is fixed at 8 bits, a Z80
  // opcode byte — see buildInstructionRegister's doc comment.
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  buildInstructionRegister(editor.circuit, library, pos);
  refreshChipPalette();
});

document.getElementById('add-fsm')?.addEventListener('click', async () => {
  const phases = await promptWidth('FSM phase count');
  if (phases === null || phases < 2) return;
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  buildRingCounter(editor.circuit, library, phases, pos);
  refreshChipPalette();
});

/** Parses "00,01,ff" into an array of 8-bit LSB-first words, rounded up to a power-of-two count (padded with 0x00) — the shape buildStubRom requires. */
async function promptRomBytes(): Promise<(0 | 1)[][] | null> {
  const raw = await showPrompt('ROM bytes, comma-separated hex (e.g. 00,01,02,03):', '00,01,02,03');
  if (!raw) return null;
  const bytes = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 16))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (bytes.length === 0) return null;

  let wordCount = 1;
  while (wordCount < bytes.length) wordCount *= 2;
  return Array.from({ length: wordCount }, (_, i) => {
    const byte = (bytes[i] ?? 0) & 0xff;
    return Array.from({ length: 8 }, (_, bit) => ((byte >> bit) & 1) as 0 | 1);
  });
}

document.getElementById('add-rom')?.addEventListener('click', async () => {
  const words = await promptRomBytes();
  if (words === null) return;
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  buildStubRom(editor.circuit, library, words, pos);
  refreshChipPalette();
});

document.getElementById('add-ram')?.addEventListener('click', async () => {
  const addrBits = await promptWidth('RAM address bits');
  if (addrBits === null) return;
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  makeRam(editor.circuit, addrBits, 8, undefined, pos);
  // No refreshChipPalette(): RAM is a raw component, not a chip def — see
  // ARCHITECTURE.md's "Real RAM" for why it can't be folded/palette-listed.
});

/** Parses "05,83,0a,81" into raw program bytes for buildMinimalCpu's RAM — no power-of-two rounding needed here (makeRam's own `initial` handles a program shorter than the RAM's full capacity by leaving the rest zeroed). */
async function promptProgramBytes(): Promise<Uint8Array | null> {
  const raw = await showPrompt('Program bytes, comma-separated hex (e.g. 05,83,0a,81 — see ARCHITECTURE.md\'s "Decode and execute" for the LDI/ADI encoding):', '05,83,0a,81');
  if (!raw) return null;
  const bytes = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 16))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (bytes.length === 0) return null;
  return Uint8Array.from(bytes.map((b) => b & 0xff));
}

document.getElementById('add-cpu')?.addEventListener('click', async () => {
  const addrBits = await promptWidth('CPU RAM address bits');
  if (addrBits === null) return;
  const program = await promptProgramBytes();
  if (program === null) return;
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  buildMinimalCpu(editor.circuit, library, addrBits, program, pos);
  refreshChipPalette();
});

/** Same shape as promptProgramBytes(), defaulted to real Z80 opcode bytes (the x=10 ALU-on-register / x=11 ALU op A,n, x=01 LD r,r', x=11 PUSH/POP/RET/RST n / JP nn / CALL nn / JP cc,nn / CALL cc,nn / RET cc / EXX / JP (HL) / LD SP,HL / EX DE,HL / EX (SP),HL / IN A,(n) / OUT (n),A, and x=00 NOP / EX AF,AF' / INC/DEC rr / INC/DEC r / LD r,n / LD dd,nn / ADD HL,rr / JR cc,e / JR e / DJNZ e / indirect loads through (BC)/(DE)/(nn) / INC (HL)/DEC (HL)/LD (HL),n / RLCA/RRCA/RLA/RRA/CPL/SCF/CCF groups buildZ80Cpu executes) instead of buildMinimalCpu's made-up encoding. */
async function promptZ80ProgramBytes(): Promise<Uint8Array | null> {
  const raw = await showPrompt(
    'Program bytes, comma-separated hex — real Z80 opcodes: 0x40-0x7F (LD r,r\', except 0x76), 0x80-0xBF (ADD/ADC/SUB/SBC/AND/XOR/OR/CP A,r — P/V is signed overflow for the first five, parity for the last three), ALU op A,n (0xC6/CE/D6/DE/E6/EE/F6/FE — same eight ops against an immediate byte that follows), PUSH rp/POP rp/RET/RST n (0xC1/C5/D1/D5/E1/E5/F1/F5, 0xC9, 0xC7-0xFF step 8), RET cc (0xC0/C8/D0/D8/E0/E8/F0/F8 — NZ/Z/NC/C/PO/PE/P/M, no operand bytes), JP nn (0xC3), CALL nn (0xCD), JP cc,nn (0xC2/CA/D2/DA/E2/EA/F2/FA), or CALL cc,nn (0xC4/CC/D4/DC/E4/EC/F4/FC — same NZ/Z/NC/C/PO/PE/P/M), each followed by its own 2-byte target/return address, low byte first — CALL, a taken CALL cc,nn, and a taken RET cc each push or pop one stack byte, poppable by (or pushed the same way as) this same RET, JR e (0x18, unconditional), DJNZ e (0x10 — decrements B, jumps if nonzero), or JR cc,e (0x20/0x28/0x30/0x38 — NZ/Z/NC/C only, real Z80\'s own limit for this opcode), each followed by its own signed 8-bit displacement (two\'s complement, e.g. 0x03 = +3, 0xFB = -5) added to PC right after the 2-byte instruction, INC rr/DEC rr (0x03/0B/13/1B/23/2B/33/3B), INC r/DEC r (0x04/05/0C/0D/14/15/1C/1D/24/25/2C/2D/3C/3D, each excluding (HL)), LD r,n (0x06/0E/16/1E/26/2E/3E, not (HL), each followed by its own immediate byte), LD dd,nn (0x01/11/21/31 — BC/DE/HL/SP — each followed by its own 2-byte immediate, low byte first), ADD HL,rr (0x09/19/29/39 — BC/DE/HL/SP, 16-bit add into HL, only the carry flag affected), LD (BC),A/LD A,(BC)/LD (DE),A/LD A,(DE) (0x02/0x0A/0x12/0x1A), LD (nn),HL/LD HL,(nn)/LD (nn),A/LD A,(nn) (0x22/0x2A/0x32/0x3A, each followed by its own 2-byte address, low byte first), INC (HL)/DEC (HL)/LD (HL),n (0x34/0x35/0x36 — the (HL) slot INC r/DEC r/LD r,n above exclude, a real RAM read-modify-write; LD (HL),n followed by its own immediate byte), RLCA/RRCA/RLA/RRA/CPL/SCF/CCF (0x07/0x0F/0x17/0x1F/0x2F/0x37/0x3F — single-byte, touch only A and/or F, no operand bytes), DAA (0x27, corrects A back into valid packed BCD after an 8-bit add or subtract — reads the real H/C/N flags this simulator now models), NOP (0x00, a genuine no-op — decoded and advances PC, touches nothing else), EX AF,AF\' (0x08) or EXX (0xD9, both single-byte, swap the shadow register set live), JP (HL) (0xE9, jumps to HL\'s own value, no operand bytes), LD SP,HL (0xF9), EX DE,HL (0xEB), EX (SP),HL (0xE3, swaps HL with the two bytes on top of the stack — a real RAM read-modify-write, not just a register swap), IN A,(n)/OUT (n),A (0xDB/0xD3, each followed by its own immediate port-address byte — this simulator\'s own invented I/O port, wired to nothing else on this canvas, see ARCHITECTURE.md\'s "Closing out the CPU" section), ED-prefixed LDI/LDD/LDIR/LDDR (0xED 0xA0/0xA8/0xB0/0xB8 — (DE)<-(HL), then HL/DE both ++ for LDI/LDIR or -- for LDD/LDDR, BC--, N/H reset, P/V<-(BC-1 != 0), S/Z/C untouched; LDIR/LDDR repeat by landing PC back on their own opcode for as long as BC stays nonzero), ED-prefixed CPI/CPD/CPIR/CPDR (0xED 0xA1/0xA9/0xB1/0xB9 — A-(HL) for flags only, A itself untouched, then HL++ for CPI/CPIR or -- for CPD/CPDR, BC--, N set, H a real half-borrow, P/V<-(BC-1 != 0), S/Z off the comparison, C untouched; CPIR/CPDR repeat the same way but stop the moment a match is found too, not only when BC reaches 0), ED-prefixed INI/IND/INIR/INDR (0xED 0xA2/0xAA/0xB2/0xBA — (HL)<-IN(C), a byte read from this simulator\'s own invented I/O port and addressed by C rather than an immediate byte, then HL++ for INI/INIR or -- for IND/INDR, B-- (never the BC pair — C keeps addressing the same port every repeat), N<-the transferred byte\'s own bit 7, Z<-(B==0) — the only two flag bits real Z80 documents for this family, S/H/P/V/C left unmodeled; INIR/INDR repeat by landing PC back on their own opcode for as long as B stays nonzero), ED-prefixed OUTI/OUTD/OTIR/OTDR (0xED 0xA3/0xAB/0xB3/0xBB — OUT(C)<-(HL), the mirror image of INI\'s own family: a byte read from (HL) this time and sent to the port, then HL++ for OUTI/OTIR or -- for OUTD/OTDR, B-- alone, N/Z the identical two documented flags; OTIR/OTDR repeat the same way, watching B alone, the simplest of this project\'s three repeat conditions, no "found it" to also watch for), ED-prefixed NEG (0xED 0x44 — A<-0-A, real two\'s-complement negation through its own dedicated adder, every flag bit real and fresh: S/Z off the result, H a real half-borrow, P/V set only when A was 0x80, N always 1, C set whenever A was nonzero; this project\'s first non-block ED-table opcode, executed for every y-value in its own column, a real documented "undocumented duplicate" quirk), or ED-prefixed ADC HL,rr/SBC HL,rr (0xED 0x4A/0x5A/0x6A/0x7A and 0x42/0x52/0x62/0x72 — BC/DE/HL/SP — reusing ADD HL,rr\'s own shared 16-bit adder, widened for a real carry-in and operand invert, the identical x=10 ADC/SBC recipe just 16 bits wide; every flag bit real here too, unlike ADD HL,rr\'s own C-only treatment: S/Z off the 16-bit result, H at the 16-bit nibble boundary, P/V the classic overflow formula at the sign bit, N picks ADC/SBC, C borrow-inverted for SBC, X/Y mirroring the high byte\'s own bits 3/5) only; these six instructions are this project\'s first CB/ED/DD/FD-table ones, the first four closing out ED\'s own block-instruction half entirely, the last two its first non-block ones — the mechanism the other three prefix bytes and the rest of ED\'s own table build on but don\'t execute anything from yet; see ARCHITECTURE.md\'s "A real Z80 decoder":',
    '80,91,a0,a9,b6,87',
  );
  if (!raw) return null;
  const bytes = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 16))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (bytes.length === 0) return null;
  return Uint8Array.from(bytes.map((b) => b & 0xff));
}

document.getElementById('add-z80cpu')?.addEventListener('click', async () => {
  const addrBits = await promptWidth('Z80 CPU RAM address bits');
  if (addrBits === null) return;
  const program = await promptZ80ProgramBytes();
  if (program === null) return;
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  buildZ80Cpu(editor.circuit, library, addrBits, program, pos);
  refreshChipPalette();
});

// --- Project & chip file I/O ------------------------------------------------
function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('export-project')?.addEventListener('click', () => {
  downloadJson('circuit-project.json', serializeProject(topCircuit, library));
});

const importProjectInput = document.getElementById('import-project-file') as HTMLInputElement;
document.getElementById('import-project')?.addEventListener('click', () => importProjectInput.click());
importProjectInput.addEventListener('change', async () => {
  const file = importProjectInput.files?.[0];
  importProjectInput.value = ''; // so picking the same file again still fires 'change'
  if (!file) return;
  if (!(await showConfirm('Import project? This replaces the current circuit and chip library entirely.'))) return;
  file
    .text()
    .then((text) => {
      const loaded = deserializeProject(JSON.parse(text) as SerializedProject);

      // Keep the existing Circuit/ChipLibrary *objects* (Editor holds a
      // readonly reference to the library, and dived-in NavFrames hold
      // direct circuit references) — replace their contents instead of
      // rebinding `topCircuit`/`library` to the freshly-parsed instances.
      topCircuit.components.clear();
      topCircuit.wires.clear();
      for (const c of loaded.topCircuit.components.values()) topCircuit.addComponent(c);
      for (const w of loaded.topCircuit.wires.values()) topCircuit.addRawWire(w);
      library.clear();
      for (const def of loaded.library.list()) library.register(def);
      // A project file is a snapshot of what the user had, not the standard
      // cell toolbox — re-seed it so the palette doesn't lose NOT/NAND/...
      // just because the loaded project (likely built before this feature,
      // or from a pared-down export) didn't happen to include them. Harmless
      // even if the project already had its own same-named copies — those
      // just show up as an extra palette entry, never a broken one.
      seedStandardCells(library);

      navStack.length = 0;
      navStack.push({ circuit: topCircuit, pathPrefix: '', label: 'top' });
      editor.circuit = topCircuit;
      editor.clearSelection();
      editor.cancelWire();
      simState = initialState();
      renderBreadcrumb();
      refreshChipPalette();
      camera.centerOn(centroid(circuitBounds(topCircuit)), 1);
    })
    .catch((err: unknown) => {
      void showAlert(`Could not load that project file: ${err instanceof Error ? err.message : String(err)}`);
    });
});

document.getElementById('export-chip')?.addEventListener('click', async () => {
  const chips = [...editor.selectedIds]
    .map((id) => editor.circuit.components.get(id))
    .filter((c): c is ChipInstanceComponent => c?.kind === 'chip');
  if (chips.length !== 1) {
    await showAlert('Select exactly one chip instance first — that chip\'s definition is what gets exported.');
    return;
  }
  const def = library.get(chips[0]!.defId);
  downloadJson(`${def.name}.json`, serializeChipDef(def, library));
});

const importChipInput = document.getElementById('import-chip-file') as HTMLInputElement;
document.getElementById('import-chip')?.addEventListener('click', () => importChipInput.click());
importChipInput.addEventListener('change', () => {
  const file = importChipInput.files?.[0];
  importChipInput.value = '';
  if (!file) return;
  file
    .text()
    .then(async (text) => {
      const def = importChipDef(JSON.parse(text) as SerializedChipBundle, library);
      refreshChipPalette();
      await showAlert(`Imported "${def.name}" — it's in the chip palette now.`);
    })
    .catch((err: unknown) => {
      void showAlert(`Could not load that chip file: ${err instanceof Error ? err.message : String(err)}`);
    });
});

// --- Zoom controls ---------------------------------------------------------
const zoomPctEl = document.getElementById('zoom-pct') as HTMLSpanElement;
function vw(): number {
  return viewportSize().w;
}
function vh(): number {
  return viewportSize().h;
}
document.getElementById('zoom-in')?.addEventListener('click', () => camera.zoomAt({ x: vw() / 2, y: vh() / 2 }, 1.25, vw(), vh()));
document.getElementById('zoom-out')?.addEventListener('click', () => camera.zoomAt({ x: vw() / 2, y: vh() / 2 }, 1 / 1.25, vw(), vh()));
document.getElementById('zoom-100')?.addEventListener('click', () => {
  camera.scale = 1;
});
document.getElementById('zoom-fit')?.addEventListener('click', () => camera.fit(circuitBounds(editor.circuit), vw(), vh()));

// --- Mouse / keyboard input ------------------------------------------------
function screenPoint(ev: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}
function worldPoint(ev: MouseEvent): { x: number; y: number } {
  return camera.screenToWorld(screenPoint(ev), vw(), vh());
}

let spacePressed = false;
let panDrag: { startScreen: { x: number; y: number } } | null = null;
// Set only by canvas's own mousedown, checked by window's mouseup below — a
// drag started on the canvas must still resolve correctly even if it ends
// outside it (window listens so that works), but a mouseup with no matching
// canvas mousedown (e.g. releasing a click on a toolbar button, which also
// bubbles a mouseup to window) must NOT be treated as a canvas interaction.
// Without this guard, clicking "fold" fires a spurious empty-space click in
// world space first, silently clearing the selection fold() was about to
// use — a real bug caught live, not an automation-timing artifact.
let mouseDownOnCanvas = false;

function isPanGesture(ev: MouseEvent): boolean {
  return editor.tool.kind === 'pan' || spacePressed || ev.button === 1;
}

canvas.addEventListener('mousedown', (ev) => {
  mouseDownOnCanvas = true;
  if (isPanGesture(ev)) {
    ev.preventDefault();
    panDrag = { startScreen: screenPoint(ev) };
    canvas.style.cursor = 'grabbing';
    return;
  }
  editor.handleMouseDown(worldPoint(ev));
});

// While actively dragging something, the cursor says so regardless of
// tool; otherwise hovering a grabbable part (in the select tool) previews
// that a drag is possible before the user commits to one.
function updateCursor(): void {
  if (editor.isDragging) {
    canvas.style.cursor = 'grabbing';
  } else if (editor.tool.kind === 'select' && (editor.hoveredComponentId || editor.hoveredWireId)) {
    canvas.style.cursor = 'grab';
  } else {
    canvas.style.cursor = CURSOR[editor.tool.kind];
  }
}

canvas.addEventListener('mousemove', (ev) => {
  if (panDrag) {
    const p = screenPoint(ev);
    camera.pan(p.x - panDrag.startScreen.x, p.y - panDrag.startScreen.y);
    panDrag = { startScreen: p };
    return;
  }
  const world = worldPoint(ev);
  editor.handleMouseMove(world);
  editor.handleMouseDrag(world); // no-ops internally unless a marquee/waypoint/component drag is actually in progress
  updateCursor();
});

// Editor.handleMouseUp() is the sole decision point for click-vs-drag (see
// its doc comment) — main.ts no longer needs to know which one happened.
window.addEventListener('mouseup', (ev) => {
  if (!mouseDownOnCanvas) return;
  mouseDownOnCanvas = false;
  if (panDrag) {
    panDrag = null;
    canvas.style.cursor = CURSOR[editor.tool.kind];
    return;
  }
  editor.handleMouseUp(worldPoint(ev), ev.shiftKey);
  updateCursor();
});

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const factor = Math.exp(-ev.deltaY * 0.0015);
  camera.zoomAt(screenPoint(ev), factor, vw(), vh());
}, { passive: false });

canvas.addEventListener('dblclick', async (ev) => {
  const hit: Component | null = editor.handleDoubleClick(worldPoint(ev));
  if (!hit) return;
  if (hit.kind === 'chip') {
    diveInto(hit);
  } else if (hit.kind === 'label') {
    const name = await showPrompt('Rename net:', hit.name);
    if (name) hit.name = name;
  } else if (hit.kind === 'port') {
    const view = navStack[navStack.length - 1]!;
    if (!view.defId) return; // a bare port can't exist outside a chip's internals
    const name = await showPrompt('Rename port:', hit.name);
    if (!name || name === hit.name) return;
    const ok = renamePort(library, [topCircuit, ...library.list().map((d) => d.circuit)], view.defId, hit.name, name);
    if (!ok) await showAlert(`Port name "${name}" is already used on this chip.`);
  }
});

const NUDGE_KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, -GRID],
  ArrowDown: [0, GRID],
  ArrowLeft: [-GRID, 0],
  ArrowRight: [GRID, 0],
};

window.addEventListener('keydown', (ev) => {
  if (ev.code === 'Space') spacePressed = true;
  if (document.activeElement?.tagName === 'INPUT') return;
  const noModifiers = !ev.ctrlKey && !ev.metaKey && !ev.altKey;

  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'g') {
    ev.preventDefault();
    foldSelection();
  } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
    editor.handleDelete();
  } else if (ev.key === 'Escape') {
    editor.cancelWire();
    if (navStack.length > 1) diveTo(navStack.length - 2);
  } else if (ev.key === '0') {
    camera.scale = 1;
  } else if (ev.key.toLowerCase() === 'f') {
    camera.fit(circuitBounds(editor.circuit), vw(), vh());
  } else if (noModifiers && NUDGE_KEYS[ev.key] && editor.selectedIds.size > 0) {
    // Fine-positioning after a rough drag — one grid step per press, no
    // separate "confirm" step needed since a move is already grid-snapped.
    ev.preventDefault();
    const [dx, dy] = NUDGE_KEYS[ev.key]!;
    for (const id of editor.selectedIds) editor.circuit.moveComponent(id, dx, dy);
  } else if (noModifiers && TOOL_KEYS.has(ev.key.toLowerCase())) {
    setTool(TOOL_KEYS.get(ev.key.toLowerCase())!);
  }
});
window.addEventListener('keyup', (ev) => {
  if (ev.code === 'Space') spacePressed = false;
});

// --- Simulation + render loop -------------------------------------------
const statusEl = document.getElementById('status') as HTMLDivElement;

/**
 * Idle-frame skip: found live once `flatten()`/`computeNets()` caching (see
 * ARCHITECTURE.md's "Caching flatten()/computeNets()") turned out to fix
 * only *half* the documented `~3.8fps`-while-idle bottleneck — `step()`
 * itself still costs real relaxation work proportional to circuit size
 * every single call, and `draw()` redraws every top-level primitive from
 * scratch every call, *neither* of them aware that a genuinely idle circuit
 * (nobody clicked anything, and it already reached a fixpoint) produces the
 * exact same output on every call. `step()`'s own relaxation is
 * deterministic: calling it again with an unchanged circuit and unchanged
 * inputs, starting from a state that already settled, reaches that identical
 * fixpoint in exactly one internal pass — the returned `levelOf` is a new
 * `Map` object, but every value in it is bit-for-bit what it already was.
 * `!uiDirty && simState.settled`, checked *before* calling `step()` at all,
 * is therefore a cheap, provably safe (never wrong, only ever conservative)
 * signal that this frame would be a no-op: `uiDirty` catches every possible
 * source of a genuine change (circuit edits, an Input toggled by click,
 * camera pan/zoom, selection/hover, a toolbar action — see the tap installed
 * above), and `settled` catches the one case that flag can't: a circuit that
 * is still actively converging (or, for a user-built free-running
 * oscillator, one that legitimately never does) keeps stepping and drawing
 * every frame regardless of `uiDirty`, exactly as before this change.
 */
function frame(): void {
  if (uiDirty || !simState.settled) {
    const flat = flatten(topCircuit, library);
    const flatNetMap = flat.computeNets();
    simState = step(flat, flatNetMap, simState);

    const view = navStack[navStack.length - 1]!;
    const resolve = (localPinId: string): { level: Level; contended: boolean } => {
      const net = flatNetMap.netOf.get(view.pathPrefix + localPinId);
      if (!net) return { level: 'Z', contended: false };
      return { level: simState.levelOf.get(net) ?? 'Z', contended: simState.contended.has(net) };
    };

    draw(ctx!, camera, vw(), vh(), view.circuit, resolve, editor, library);
    zoomPctEl.textContent = `${Math.round(camera.scale * 100)}%`;
    statusEl.textContent =
      `${navStack.map((f) => f.label).join('/')} | flat nets: ${flatNetMap.pinsOf.size} | ` +
      `iterations: ${simState.iterations} | settled: ${simState.settled} | contended: ${simState.contended.size}`;
    uiDirty = false;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
