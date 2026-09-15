import { buildAlu, buildInstructionRegister, buildMinimalCpu, buildProgramCounter, buildRegister, buildRingCounter, buildStubRom, buildZ80Cpu } from './sim/blocks.js';
import { ChipLibrary } from './sim/ChipLibrary.js';
import { Circuit } from './sim/Circuit.js';
import { foldZ80CpuLeavingRam, newComponentIdSet, packFoldedMachine } from './sim/foldZ80.js';
import { replaceLongWiresWithLabels } from './sim/labelWires.js';
import { circuitNeedsLabTick, tickLabInstruments } from './sim/labTick.js';
import { flatten, fold, renamePort } from './sim/hierarchy.js';
import { buildNot, makeButton, makeLed, makeProbe, makeRam, makeRom, makeSource, makeTty, wire } from './sim/library.js';
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
import { MACHINE_ADDR_BITS, BMP_WIDTH, BMP_HEIGHT } from './machine/memoryMap.js';
import { MachineRunner } from './machine/MachineRunner.js';
import { commandRomHexPrompt } from './machine/commandRom.js';
import { Camera, type Bounds } from './ui/Camera.js';
import { showAlert, showConfirm, showPrompt } from './ui/Dialog.js';
import { EditHistory } from './ui/EditHistory.js';
import { Editor, type Tool } from './ui/Editor.js';
import { GRID, snap } from './ui/geometry.js';
import { LogicAnalyzer } from './ui/LogicAnalyzer.js';
import { MachinePanel } from './ui/MachinePanel.js';
import { MemoryEditor } from './ui/MemoryEditor.js';
import { draw } from './ui/Renderer.js';

const stage = document.getElementById('stage') as HTMLDivElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('2D canvas context is not available');

const machinePanel = new MachinePanel();
const machineRunner = new MachineRunner();
machinePanel.bindRunner(machineRunner);

const memoryEditor = new MemoryEditor();
const logicAnalyzer = new LogicAnalyzer();


const library = new ChipLibrary();
seedStandardCells(library); // NOT/NAND/AND/NOR/OR/XOR/MUX2/MUX4/FULL_ADDER/D_LATCH/D_FF, ready to drag out
const topCircuit = new Circuit();
seedDemoCircuit(topCircuit);

function seedDemoCircuit(c: Circuit): void {
  makeSource(c, 1, { x: 80, y: 60 }); // rail driver
  makeSource(c, 0, { x: 80, y: 140 });
  const notGate = buildNot(c, { x: 260, y: 70 });
  const btn = makeButton(c, { x: 140, y: 100 }, 'toggle');
  const led = makeLed(c, { x: 360, y: 100 }, 'out');
  const probe = makeProbe(c, { x: 360, y: 160 }, 'out');
  wire(c, btn.pins.out, notGate.in);
  wire(c, notGate.out, led.pins.in);
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
  // Only reassign when the backing store size actually changes — setting
  // canvas.width clears the bitmap and resets the context transform.
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
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
const editHistory = new EditHistory();
editor.onBeforeEdit = () => editHistory.checkpoint(editor.circuit);
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
memoryEditor.setOnChange(() => {
  uiDirty = true;
});
logicAnalyzer.setOnRunChange(() => {
  uiDirty = true;
});

for (const evtName of ['mousedown', 'mousemove', 'mouseup', 'dblclick', 'wheel', 'keydown', 'keyup', 'click', 'change', 'resize']) {
  window.addEventListener(evtName, () => (uiDirty = true), { capture: true, passive: true });
}
// Stage shrinks/grows when the TTY panel toggles (and on browser zoom /
// DPR changes that don't always fire `window.resize`). Without this, the
// canvas CSS box follows flex layout but the backing store stays at the
// old size — fillRect only covers the new CSS viewport, leaving a strip of
// stale pixels that the browser then squashes into the right edge as a
// smear (most visible while zooming, which forces redraws).
new ResizeObserver(() => {
  resizeCanvas();
  uiDirty = true;
}).observe(stage);

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
  editHistory.clear();
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

// --- Chip palette (Library menu): place an instance of any folded chip ---
const chipPaletteListEl = document.getElementById('chip-palette-list') as HTMLDivElement;
const libraryMenuTrigger = document.getElementById('library-menu-trigger');
function refreshChipPalette(): void {
  chipPaletteListEl.replaceChildren();
  const defs = library.list();
  if (defs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = 'No chips yet — fold a selection (Ctrl+G)';
    chipPaletteListEl.appendChild(empty);
  } else {
    for (const def of defs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-item';
      btn.textContent = def.name;
      btn.dataset.defId = def.id;
      btn.classList.toggle('active', editor.tool.kind === 'place-chip' && editor.tool.defId === def.id);
      btn.addEventListener('click', () => setTool({ kind: 'place-chip', defId: def.id }));
      chipPaletteListEl.appendChild(btn);
    }
  }
  libraryMenuTrigger?.classList.toggle(
    'active',
    editor.tool.kind === 'place-chip',
  );
}
refreshChipPalette();

// --- Menubar: open / close / hover-switch like a desktop app -------------
const menus = Array.from(document.querySelectorAll<HTMLElement>('#menubar .menu'));
function closeAllMenus(): void {
  for (const m of menus) m.classList.remove('open');
}
function openMenu(menu: HTMLElement): void {
  for (const m of menus) m.classList.toggle('open', m === menu);
}
let menuBarArmed = false;
for (const menu of menus) {
  const trigger = menu.querySelector('.menu-trigger');
  trigger?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (menu.classList.contains('open')) {
      closeAllMenus();
      menuBarArmed = false;
    } else {
      openMenu(menu);
      menuBarArmed = true;
    }
  });
  trigger?.addEventListener('mouseenter', () => {
    if (menuBarArmed) openMenu(menu);
  });
}
document.addEventListener('click', () => {
  closeAllMenus();
  menuBarArmed = false;
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    closeAllMenus();
    menuBarArmed = false;
  }
});
for (const panel of Array.from(document.querySelectorAll('#menubar .menu-panel'))) {
  panel.addEventListener('click', (ev: Event) => {
    // Keep the menu open only for non-action chrome (section labels).
    const t = ev.target as HTMLElement;
    if (t.closest('.menu-item')) {
      // Close after the item's own handler runs (bubble phase).
      queueMicrotask(() => {
        closeAllMenus();
        menuBarArmed = false;
      });
    }
  });
}

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
  button: 'copy',
  led: 'copy',
  clock: 'copy',
  analyzer: 'copy',
  tty: 'copy',
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
const PLACE_TOOL_LABELS: Partial<Record<Tool['kind'], string>> = {
  nmos: 'placing N-MOS',
  pmos: 'placing P-MOS',
  vcc: 'placing VCC',
  gnd: 'placing GND',
  input: 'placing input',
  button: 'placing button',
  led: 'placing LED',
  clock: 'placing pulse gen',
  analyzer: 'placing analyzer',
  tty: 'placing TTY',
  probe: 'placing probe',
  label: 'placing net label',
  'place-chip': 'placing chip',
};
const activePlaceHint = document.getElementById('active-place-hint');
const activeToolName = document.getElementById('active-tool-name');
function setTool(tool: Tool): void {
  editor.tool = tool;
  editor.cancelWire();
  editor.marqueeStart = null;
  for (const b of toolButtons) b.classList.toggle('active', b.dataset.tool === tool.kind);
  canvas.style.cursor = CURSOR[tool.kind];
  const placeLabel =
    tool.kind === 'place-chip'
      ? `placing ${library.get(tool.defId)?.name ?? 'chip'}`
      : PLACE_TOOL_LABELS[tool.kind];
  if (activePlaceHint && activeToolName) {
    if (placeLabel) {
      activeToolName.textContent = placeLabel;
      activePlaceHint.hidden = false;
    } else {
      activePlaceHint.hidden = true;
      activeToolName.textContent = '';
    }
  }
  refreshChipPalette();
}
for (const b of toolButtons) {
  b.addEventListener('click', () => setTool({ kind: b.dataset.tool as Exclude<Tool['kind'], 'place-chip'> }));
}
setTool({ kind: 'select' });

document.getElementById('clear')?.addEventListener('click', async () => {
  if (!(await showConfirm('Clear this level of the circuit?'))) return;
  if (navStack.length === 1) {
    machineRunner.detach();
    machinePanel.detach();
    memoryEditor.detach();
    logicAnalyzer.clearChannels();
  }
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
  editHistory.checkpoint(editor.circuit);
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
async function promptWidth(label: string, defaultBits = '4'): Promise<number | null> {
  const raw = await showPrompt(`${label} width (bits):`, defaultBits);
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
  const addrBits = await promptWidth('ROM address bits', '8');
  if (addrBits === null) return;
  const raw = await showPrompt('Optional initial hex bytes (comma-separated, blank = zeros):', '');
  let initial: Uint8Array | undefined;
  if (raw && raw.trim()) {
    const bytes = raw
      .split(',')
      .map((s) => parseInt(s.trim(), 16))
      .filter((n) => Number.isFinite(n) && n >= 0)
      .map((b) => b & 0xff);
    if (bytes.length > 0) initial = Uint8Array.from(bytes);
  }
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  const rom = makeRom(editor.circuit, addrBits, 8, initial, pos);
  memoryEditor.attach(rom);
});

document.getElementById('add-stub-rom')?.addEventListener('click', async () => {
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
  const ram = makeRam(editor.circuit, addrBits, 8, undefined, pos);
  memoryEditor.attach(ram);
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

/**
 * Default demo: Z80 command ROM (TTY H/M/W/G on FB @ 0xE00). Needs addrBits ≥ 12.
 */
const Z80_MONITOR_HEX = commandRomHexPrompt();

/** Same shape as promptProgramBytes(), defaulted to the command ROM. */
async function promptZ80ProgramBytes(): Promise<Uint8Array | null> {
  const raw = await showPrompt(
    'Program bytes, comma-separated hex — default is the Z80 command ROM (TTY H/M/W/G; FB @ 0xE00; needs 12-bit RAM):',
    Z80_MONITOR_HEX,
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
  // Default 12-bit so the soft TTY map (FB @ 0xE00, keys @ 0xF00) fits.
  const addrBits = await promptWidth('Z80 CPU RAM address bits', String(MACHINE_ADDR_BITS));
  if (addrBits === null) return;
  const program = await promptZ80ProgramBytes();
  if (program === null) return;
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  machineRunner.detach();

  // Snapshot ids so we can fold the flat composite into one chip afterward
  // (RAM stays outside — see foldZ80CpuLeavingRam).
  const beforeIds = new Set(editor.circuit.components.keys());
  const cpu = buildZ80Cpu(editor.circuit, library, addrBits, program, pos);
  const placedIds = newComponentIdSet(editor.circuit, beforeIds);

  if (addrBits >= MACHINE_ADDR_BITS) {
    const simTick = () => {
      const flat = flatten(topCircuit, library);
      const flatNetMap = flat.computeNets();
      simState = step(flat, flatNetMap, simState);
      // Do not set uiDirty here — tickBudget used to force a redraw every
      // clock edge and doubled work with frame()'s own step+draw.
    };
    machinePanel.attach(cpu.ram);
    machinePanel.bindRunner(machineRunner);
    // Wire Inputs *before* fold so clocks/seeds become chip ports.
    machineRunner.attach(editor.circuit, library, cpu, simTick);
    machineRunner.boot();
    machineRunner.setSpeed('soft');
    machineRunner.setRunning(true);
    // Place a TTY instrument linked to the machine RAM (opens dialog on dblclick).
    const tty = makeTty(editor.circuit, { x: pos.x + 120, y: pos.y - 80 }, cpu.ram.id);
    void tty;
    machinePanel.refreshControls();
    machinePanel.draw();
  } else {
    machinePanel.detach();
    machineRunner.detach();
  }

  foldZ80CpuLeavingRam(editor.circuit, library, placedIds, pos);
  // Chip lands at `pos`; RAM/Inputs were left at pre-fold compact coords
  // (often thousands of units away). Pack into one cluster, then label any
  // remaining long legs.
  packFoldedMachine(editor.circuit, pos);
  replaceLongWiresWithLabels(editor.circuit, 24);
  camera.fit(circuitBounds(editor.circuit), vw(), vh());
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
      machineRunner.detach();
      machinePanel.detach(); // re-attach via + Z80CPU with addrBits ≥ 12
      memoryEditor.detach();
      logicAnalyzer.clearChannels();
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
  // Right button (2) — middle-click is awkward on many mice/trackpads.
  return editor.tool.kind === 'pan' || spacePressed || ev.button === 2;
}

canvas.addEventListener('contextmenu', (ev) => {
  ev.preventDefault(); // right-drag pans; don't open the browser menu
});

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
  } else if (hit.kind === 'ram' || hit.kind === 'rom') {
    memoryEditor.attach(hit);
  } else if (hit.kind === 'analyzer') {
    logicAnalyzer.attach(hit);
  } else if (hit.kind === 'tty') {
    const ramComp = hit.ramId ? editor.circuit.components.get(hit.ramId) : undefined;
    if (ramComp && ramComp.kind === 'ram') {
      machinePanel.attach(ramComp);
    } else {
      await showAlert('TTY is not linked to a machine RAM. Place a Z80CPU (≥12 addr bits) first.');
    }
  } else if (hit.kind === 'clock') {
    const modeRaw = await showPrompt(
      'Pulse generator — mode (continuous|oneshot), period frames, pulse width frames:\ne.g. continuous,30,15  or  oneshot,30,4',
      `${hit.mode},${hit.periodFrames},${hit.dutyFrames}`,
    );
    if (!modeRaw) return;
    const parts = modeRaw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    const mode = parts[0] === 'oneshot' ? 'oneshot' : parts[0] === 'continuous' ? 'continuous' : null;
    const period = parseInt(parts[1] ?? '', 10);
    const duty = parseInt(parts[2] ?? '', 10);
    if (!mode || !Number.isFinite(period) || period < 2) return;
    hit.mode = mode;
    hit.periodFrames = period;
    hit.dutyFrames = Math.max(1, Math.min(period - 1, Number.isFinite(duty) ? duty : Math.floor(period / 2)));
    hit.phase = 0;
    hit.holdFrames = 0;
    hit.running = false;
    hit.value = 0;
  } else if (hit.kind === 'button') {
    hit.mode = hit.mode === 'toggle' ? 'momentary' : 'toggle';
    hit.holdFrames = 0;
    hit.value = 0;
    await showAlert(`Button mode: ${hit.mode}`);
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
  if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
  const noModifiers = !ev.ctrlKey && !ev.metaKey && !ev.altKey;

  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'g') {
    ev.preventDefault();
    foldSelection();
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
    ev.preventDefault();
    if (editHistory.undo(editor.circuit)) {
      editor.clearSelection();
      editor.cancelWire();
      uiDirty = true;
    }
  } else if (
    (ev.ctrlKey || ev.metaKey) &&
    (ev.key.toLowerCase() === 'y' || (ev.shiftKey && ev.key.toLowerCase() === 'z'))
  ) {
    ev.preventDefault();
    if (editHistory.redo(editor.circuit)) {
      editor.clearSelection();
      editor.cancelWire();
      uiDirty = true;
    }
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'c') {
    ev.preventDefault();
    editor.copySelection();
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'v') {
    ev.preventDefault();
    if (editor.pasteClipboard()) uiDirty = true;
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
    editHistory.checkpoint(editor.circuit);
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

/** Offscreen 128×64 for soft bitmap HUD (screen-fixed, not world coords). */
const bmpHudTmp = document.createElement('canvas');
bmpHudTmp.width = BMP_WIDTH;
bmpHudTmp.height = BMP_HEIGHT;
const bmpHudCtx = bmpHudTmp.getContext('2d');

/** Subtle corner preview when SoftDevices.bitmap has any set pixel. */
function drawSoftBitmapHud(c: CanvasRenderingContext2D, _vw: number, vh: number): void {
  if (!machineRunner.attached || !bmpHudCtx) return;
  const bmp = machineRunner.softDevices.bitmap;
  let any = false;
  for (let i = 0; i < bmp.length; i++) {
    if (bmp[i]) {
      any = true;
      break;
    }
  }
  if (!any) return;

  const img = bmpHudCtx.createImageData(BMP_WIDTH, BMP_HEIGHT);
  for (let i = 0; i < BMP_WIDTH * BMP_HEIGHT; i++) {
    const bit = (bmp[(i / 8) | 0]! >> (7 - (i & 7))) & 1;
    const o = i * 4;
    const v = bit ? 180 : 12;
    img.data[o] = v;
    img.data[o + 1] = bit ? 190 : 14;
    img.data[o + 2] = bit ? 210 : 18;
    img.data[o + 3] = bit ? 220 : 160;
  }
  bmpHudCtx.putImageData(img, 0, 0);
  const scale = 1;
  const w = BMP_WIDTH * scale;
  const h = BMP_HEIGHT * scale;
  const x = 8;
  const y = vh - h - 8;
  c.save();
  c.globalAlpha = 0.85;
  c.fillStyle = 'rgba(10,12,18,0.7)';
  c.fillRect(x - 2, y - 2, w + 4, h + 4);
  c.imageSmoothingEnabled = false;
  c.drawImage(bmpHudTmp, x, y, w, h);
  c.restore();
}

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
  // Soft Run advances the interpreter only; gate Run spends a time-budgeted
  // slice of transistor phases. Either way we avoid the old pattern of
  // 160 full step()s *plus* another step+draw in the same rAF.
  let machineWorked = false;
  if (machineRunner.running) {
    machineWorked = machineRunner.tickBudget();
  }

  // No manual Lab Run — keep ticking while a pulse/button/analyzer actually
  // needs wall-clock frames; idle TRIG edges are still seen whenever we step.
  const labActive = circuitNeedsLabTick(topCircuit, logicAnalyzer.anyArmed(topCircuit));

  const softRun = machineRunner.running && machineRunner.isSoft;
  // Soft Run: skip transistor step/canvas every frame (TTY samples RAM).
  // Gate Run / idle / edits: normal path. Soft still redraws canvas when
  // the user pans/zooms (uiDirty from camera handlers).
  const needSimDraw =
    softRun
      ? uiDirty
      : uiDirty || !simState.settled || (machineRunner.running && machineWorked) || labActive;

  if (needSimDraw) {
    // Keep backing store in sync even if a layout change slipped past the
    // ResizeObserver (e.g. panel attach in the same turn as a zoom redraw).
    resizeCanvas();
    // Soft at top level: draw chip boxes without expanding ~200k components
    // through flatten() — interactive TTY does not need pin levels. Dive-in
    // (navStack depth > 1) or any Gates path still flattens as before.
    const softTop = softRun && navStack.length === 1;
    if (!softRun || uiDirty || labActive) {
      const view = navStack[navStack.length - 1]!;
      if (softTop && !labActive) {
        const resolve = (_localPinId: string): { level: Level; contended: boolean } => ({
          level: 'Z',
          contended: false,
        });
        draw(ctx!, camera, vw(), vh(), view.circuit, resolve, editor, library);
        drawSoftBitmapHud(ctx!, vw(), vh());
        zoomPctEl.textContent = `${Math.round(camera.scale * 100)}%`;
        statusEl.textContent = `${navStack.map((f) => f.label).join('/')} | soft (flatten deferred) | machine: soft`;
      } else {
        const flat = flatten(topCircuit, library);
        const flatNetMap = flat.computeNets();
        if (!softRun) {
          simState = step(flat, flatNetMap, simState);
        }
        // Opportunistic tick on every sim frame (catches TRIG edges); continuous
        // instruments keep the loop alive via circuitNeedsLabTick above.
        if (tickLabInstruments(topCircuit, flatNetMap, simState.levelOf)) {
          uiDirty = true;
        }
        if (labActive) {
          logicAnalyzer.sampleCircuit(topCircuit, flatNetMap, simState.levelOf);
        }

        const resolve = (localPinId: string): { level: Level; contended: boolean } => {
          const net = flatNetMap.netOf.get(view.pathPrefix + localPinId);
          if (!net) return { level: 'Z', contended: false };
          return { level: simState.levelOf.get(net) ?? 'Z', contended: simState.contended.has(net) };
        };

        draw(ctx!, camera, vw(), vh(), view.circuit, resolve, editor, library);
        drawSoftBitmapHud(ctx!, vw(), vh());
        zoomPctEl.textContent = `${Math.round(camera.scale * 100)}%`;
        const mode =
          machineRunner.running && machineRunner.isSoft
            ? 'machine: soft'
            : machineRunner.running
              ? 'machine: gates'
              : machineRunner.attached
                ? 'machine: pause'
                : '';
        const lab = labActive ? ' | lab' : '';
        statusEl.textContent =
          `${navStack.map((f) => f.label).join('/')} | flat nets: ${flatNetMap.pinsOf.size} | ` +
          `iterations: ${simState.iterations} | settled: ${simState.settled} | contended: ${simState.contended.size}` +
          (mode ? ` | ${mode}` : '') +
          lab;
      }
    }
    uiDirty = false;
  }
  // Soft TTY samples ram.bytes independently of the transistor canvas.
  if (machinePanel.attached) machinePanel.draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
