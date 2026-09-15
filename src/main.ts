import { buildAlu, buildInstructionRegister, buildMinimalCpu, buildProgramCounter, buildRegister, buildRingCounter, buildStubRom, buildZ80Cpu } from './sim/blocks.js';
import { ChipLibrary } from './sim/ChipLibrary.js';
import { Circuit, currentStructureVersion } from './sim/Circuit.js';
import { foldZ80CpuLeavingRam, newComponentIdSet, packFoldedMachine } from './sim/foldZ80.js';
import { replaceLongWiresWithLabels } from './sim/labelWires.js';
import { circuitNeedsLabTick, tickLabInstruments } from './sim/labTick.js';
import { flatten, fold, foldPortWarnings, forkChipInstance, unfold } from './sim/hierarchy.js';
import { buildNot, makeButton, makeLed, makeProbe, makeRam, makeRom, makeSource, makeTty, wire } from './sim/library.js';
import { EXAMPLE_PROJECTS } from './examples/catalog.js';
import {
  deserializeProject,
  importChipDef,
  serializeChipDef,
  serializeProject,
  type SerializedChipBundle,
  type SerializedProject,
} from './sim/serialize.js';
import {
  clearAutosave,
  clearSlot,
  createAutosaveScheduler,
  ensureSlot,
  getSessionMeta,
  loadAutosave,
  loadAutosaveSync,
  loadSlot,
  MAX_SLOTS,
  saveSessionMeta,
  type AutosaveStatus,
} from './sim/autosave.js';
import { netIdFromEditorSelection, renameNet } from './sim/netRename.js';
import { initialState, step } from './sim/solver.js';
import { pruneDuplicateChipNames, seedStandardCells } from './sim/stdcells.js';
import type { ChipInstanceComponent, Component, Level, SimState } from './sim/types.js';
import { MACHINE_ADDR_BITS, BMP_WIDTH, BMP_HEIGHT } from './machine/memoryMap.js';
import { MachineRunner } from './machine/MachineRunner.js';
import { commandRomHexPrompt } from './machine/commandRom.js';
import { Camera, type Bounds } from './ui/Camera.js';
import { showAlert, showChoice, showConfirm, showPrompt } from './ui/Dialog.js';
import { EditHistory } from './ui/EditHistory.js';
import { Editor, type Tool } from './ui/Editor.js';
import { GRID, snap } from './ui/geometry.js';
import { LogicAnalyzer } from './ui/LogicAnalyzer.js';
import { MachinePanel } from './ui/MachinePanel.js';
import { MemoryEditor } from './ui/MemoryEditor.js';
import { ObjectInspector } from './ui/ObjectInspector.js';
import { draw } from './ui/Renderer.js';
import { isOrientable, orientSelection } from './sim/orientation.js';
import {
  showContextMenu,
  hideContextMenu,
  contextMenuOpen,
  type ContextMenuItem,
} from './ui/ContextMenu.js';
import { toggleCheatSheet, hideCheatSheet, cheatSheetOpen } from './ui/CheatSheet.js';
import { Minimap } from './ui/Minimap.js';

const stage = document.getElementById('stage') as HTMLDivElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('2D canvas context is not available');

const machinePanel = new MachinePanel();
const machineRunner = new MachineRunner();
machinePanel.bindRunner(machineRunner);

const memoryEditor = new MemoryEditor();
const logicAnalyzer = new LogicAnalyzer();
const objectInspector = new ObjectInspector();

const library = new ChipLibrary();
seedStandardCells(library); // NOT/NAND/AND/NOR/OR/XOR/MUX2/MUX4/FULL_ADDER/D_LATCH/D_FF, ready to drag out
const topCircuit = new Circuit();

function applyLoadedProject(loaded: { topCircuit: Circuit; library: ChipLibrary }): void {
  topCircuit.components.clear();
  topCircuit.wires.clear();
  for (const c of loaded.topCircuit.components.values()) topCircuit.addComponent(c);
  for (const w of loaded.topCircuit.wires.values()) topCircuit.addRawWire(w);
  library.clear();
  for (const def of loaded.library.list()) library.register(def);
  // Fill any missing stdcells without re-adding names already in the session,
  // then drop orphan duplicates left by older builds that re-seeded on every load.
  seedStandardCells(library);
  pruneDuplicateChipNames(library, [topCircuit, ...library.list().map((d) => d.circuit)]);
}

const restoredSync = loadAutosaveSync();
if (restoredSync) {
  try {
    applyLoadedProject(deserializeProject(restoredSync));
  } catch {
    seedDemoCircuit(topCircuit);
  }
} else {
  seedDemoCircuit(topCircuit);
}

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

const autosaveStatusEl = document.getElementById('autosave-status');
function setAutosaveStatusUi(status: AutosaveStatus, detail?: string): void {
  if (!autosaveStatusEl) return;
  autosaveStatusEl.dataset.state = status;
  const slot = getSessionMeta().slots.find((s) => s.id === getSessionMeta().activeId);
  const name = slot?.name ?? 'Session';
  switch (status) {
    case 'pending':
      autosaveStatusEl.textContent = `${name} · …`;
      break;
    case 'saving':
      autosaveStatusEl.textContent = `${name} · Saving…`;
      break;
    case 'saved':
      autosaveStatusEl.textContent = detail ? `${name} · Saved (${detail})` : `${name} · Saved`;
      break;
    case 'error':
      autosaveStatusEl.textContent = `${name} · Save failed${detail ? ` (${detail})` : ''}`;
      break;
    case 'conflict':
      autosaveStatusEl.textContent = `${name} · Changed elsewhere`;
      break;
    default:
      autosaveStatusEl.textContent = name;
  }
}

const autosave = createAutosaveScheduler(() => serializeProject(topCircuit, library), {
  onStatus: setAutosaveStatusUi,
  onConflict: () => {
    /* status already set; click badge to export a safety copy */
  },
});
autosave.adoptWriteGen(getSessionMeta().activeId);
let lastAutosaveStructureVersion = currentStructureVersion();
setAutosaveStatusUi('idle');

function bumpDefRevisionOnEdit(): void {
  const defId = navStack[navStack.length - 1]?.defId;
  if (defId && library.has(defId)) {
    const def = library.get(defId);
    def.revision = (def.revision ?? 0) + 1;
  }
}

editor.onBeforeEdit = () => {
  editHistory.checkpoint(editor.circuit);
  bumpDefRevisionOnEdit();
  autosave.schedule();
};
objectInspector.onBeforeEdit = () => {
  editHistory.checkpoint(editor.circuit);
  bumpDefRevisionOnEdit();
  autosave.schedule();
};
objectInspector.onDive = (inst) => {
  void diveInto(inst);
};
objectInspector.editor = editor;
let simState: SimState = initialState();
/** Last flat net map — used by MachineRunner gate halt detection. */
let lastFlatNetMap: ReturnType<Circuit['computeNets']> | null = null;

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
objectInspector.onChange = () => {
  uiDirty = true;
};
objectInspector.setContext({
  circuit: topCircuit,
  library,
  defId: null,
  allCircuits: [topCircuit, ...library.list().map((d) => d.circuit)],
});

function syncInspector(): void {
  if (editor.selectedIds.size === 0) {
    objectInspector.sync(null);
    return;
  }
  const comps = [...editor.selectedIds]
    .map((id) => editor.circuit.components.get(id))
    .filter((c): c is Component => !!c);
  if (comps.length === 0) {
    objectInspector.sync(null);
    return;
  }
  objectInspector.sync(comps.length === 1 ? comps[0]! : comps);
}
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

function countChipInstances(defId: string): number {
  let n = 0;
  const circuits = [topCircuit, ...library.list().map((d) => d.circuit)];
  for (const circ of circuits) {
    for (const c of circ.components.values()) {
      if (c.kind === 'chip' && c.defId === defId) n++;
    }
  }
  return n;
}

async function diveInto(inst: ChipInstanceComponent): Promise<void> {
  let def = library.get(inst.defId);
  const shared = countChipInstances(inst.defId) > 1;
  if (shared) {
    const fork = await showConfirm(
      `"${def.name}" has multiple instances. Fork a private copy so edits do not affect the others?`,
    );
    if (fork) {
      def = forkChipInstance(library, inst);
      uiDirty = true;
    }
  }
  // Acknowledge current revision so the "edited" badge clears for this instance.
  inst.defRevision = def.revision ?? 0;
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
  // Keep per-circuit undo stacks — diving must not wipe the parent's history.
  objectInspector.setContext({
    circuit: view.circuit,
    library,
    defId: view.defId ?? null,
    allCircuits: [topCircuit, ...library.list().map((d) => d.circuit)],
  });
  objectInspector.sync(null);
  // "Auto-centered at 100%" — see the reference project's own dive-in behavior.
  camera.centerOn(centroid(circuitBounds(view.circuit)), 1);
  renderBreadcrumb();
  refreshWatchStrip();
}

const breadcrumbEl = document.getElementById('breadcrumb') as HTMLDivElement;
function renderBreadcrumb(): void {
  breadcrumbEl.replaceChildren();
  const meta = getSessionMeta();
  const slot = meta.slots.find((s) => s.id === meta.activeId);
  const sessionBtn = document.createElement('button');
  sessionBtn.className = 'crumb-session';
  sessionBtn.textContent = slot?.name ?? 'Session';
  sessionBtn.title = 'Switch session';
  sessionBtn.addEventListener('click', () => void switchSession());
  breadcrumbEl.appendChild(sessionBtn);

  navStack.forEach((frame, i) => {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = ' › ';
    breadcrumbEl.appendChild(sep);
    const btn = document.createElement('button');
    btn.textContent = frame.label;
    btn.addEventListener('click', () => diveTo(i));
    breadcrumbEl.appendChild(btn);
  });
}
renderBreadcrumb();
camera.centerOn(centroid(circuitBounds(topCircuit)), 1);

// IndexedDB-only autosave (too big for localStorage) — apply once if boot
// only saw the demo because LS was empty.
if (!restoredSync) {
  void loadAutosave().then((data) => {
    if (!data) return;
    // Still on the fresh demo (no user edits yet, or empty) — replace.
    try {
      applyLoadedProject(deserializeProject(data));
      navStack.length = 0;
      navStack.push({ circuit: topCircuit, pathPrefix: '', label: 'top' });
      editor.circuit = topCircuit;
      editor.clearSelection();
      editHistory.clear();
      simState = initialState();
      renderBreadcrumb();
      refreshChipPalette();
      camera.centerOn(centroid(circuitBounds(topCircuit)), 1);
      uiDirty = true;
    } catch {
      /* keep demo */
    }
  });
}

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
    hideCheatSheet();
    hideContextMenu();
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
  port: 'copy',
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
  port: 'placing port',
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
  editHistory.checkpoint(editor.circuit);
  editor.circuit.components.clear();
  editor.circuit.wires.clear();
  editor.clearSelection();
  editor.cancelWire();
  autosave.schedule();
});

function resetEditorToTop(): void {
  navStack.length = 0;
  navStack.push({ circuit: topCircuit, pathPrefix: '', label: 'top' });
  editor.circuit = topCircuit;
  editor.clearSelection();
  editor.cancelWire();
  editHistory.clear();
  simState = initialState();
  machineRunner.detach();
  machinePanel.detach();
  memoryEditor.detach();
  logicAnalyzer.clearChannels();
  renderBreadcrumb();
  refreshChipPalette();
  camera.centerOn(centroid(circuitBounds(topCircuit)), 1);
  uiDirty = true;
  syncInspector();
  refreshWatchStrip();
  objectInspector.setContext({
    circuit: topCircuit,
    library,
    defId: null,
    allCircuits: [topCircuit, ...library.list().map((d) => d.circuit)],
  });
}

document.getElementById('reset-session')?.addEventListener('click', async () => {
  if (
    !(await showConfirm(
      'Discard ALL browser sessions and reset to the demo circuit? This cannot be undone.',
    ))
  ) {
    return;
  }
  await clearAutosave();
  topCircuit.components.clear();
  topCircuit.wires.clear();
  library.clear();
  seedStandardCells(library);
  seedDemoCircuit(topCircuit);
  const meta = getSessionMeta();
  meta.activeId = '1';
  meta.slots = [{ id: '1', name: 'Session 1', updatedAt: Date.now() }];
  saveSessionMeta(meta);
  autosave.setActiveSlot('1');
  resetEditorToTop();
  setAutosaveStatusUi('idle');
});

document.getElementById('session-rename')?.addEventListener('click', async () => {
  const meta = getSessionMeta();
  const slot = meta.slots.find((s) => s.id === meta.activeId);
  if (!slot) return;
  const name = await showPrompt('Session name:', slot.name);
  if (!name?.trim()) return;
  slot.name = name.trim();
  saveSessionMeta(meta);
  setAutosaveStatusUi('idle');
  renderBreadcrumb();
});

document.getElementById('session-switch')?.addEventListener('click', () => void switchSession());
document.getElementById('session-new')?.addEventListener('click', () => void newSession());

async function switchSession(): Promise<void> {
  await autosave.flush();
  const meta = getSessionMeta();
  const pick = await showChoice(
    'Switch session',
    meta.slots.map((s) => ({
      value: s.id,
      label: s.name,
      detail: s.id === meta.activeId ? 'current' : undefined,
      current: s.id === meta.activeId,
      deletable: meta.slots.length > 1,
    })),
  );
  if (!pick) return;

  if (pick.action === 'delete') {
    if (meta.slots.length <= 1) {
      await showAlert('Cannot delete the only session.');
      return;
    }
    const victim = meta.slots.find((s) => s.id === pick.value);
    if (
      !(await showConfirm(`Delete session “${victim?.name ?? pick.value}”? This cannot be undone.`))
    ) {
      return;
    }
    await clearSlot(pick.value);
    meta.slots = meta.slots.filter((s) => s.id !== pick.value);
    if (meta.activeId === pick.value) {
      const next = meta.slots[0]!;
      meta.activeId = next.id;
      saveSessionMeta(meta);
      autosave.setActiveSlot(next.id);
      const data = await loadSlot(next.id);
      if (data) {
        try {
          applyLoadedProject(deserializeProject(data));
        } catch {
          topCircuit.components.clear();
          topCircuit.wires.clear();
          library.clear();
          seedStandardCells(library);
        }
      } else {
        topCircuit.components.clear();
        topCircuit.wires.clear();
        library.clear();
        seedStandardCells(library);
      }
      resetEditorToTop();
    } else {
      saveSessionMeta(meta);
    }
    setAutosaveStatusUi('idle');
    renderBreadcrumb();
    return;
  }

  const id = pick.value;
  if (id === meta.activeId) return;
  const data = await loadSlot(id);
  meta.activeId = id;
  saveSessionMeta(meta);
  autosave.setActiveSlot(id);
  if (data) {
    try {
      applyLoadedProject(deserializeProject(data));
    } catch (err) {
      await showAlert(`Could not load session: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  } else {
    topCircuit.components.clear();
    topCircuit.wires.clear();
    library.clear();
    seedStandardCells(library);
  }
  resetEditorToTop();
  setAutosaveStatusUi('idle');
}

async function newSession(): Promise<void> {
  await autosave.flush();
  const meta = getSessionMeta();
  if (meta.slots.length >= MAX_SLOTS) {
    await showAlert(`Already ${MAX_SLOTS} sessions — switch or rename an existing one.`);
    return;
  }
  let next = 1;
  while (meta.slots.some((s) => s.id === String(next))) next++;
  const id = String(next);
  const name = (await showPrompt('New session name:', `Session ${id}`))?.trim() || `Session ${id}`;
  ensureSlot(meta, id, name);
  meta.activeId = id;
  saveSessionMeta(meta);
  autosave.setActiveSlot(id);
  topCircuit.components.clear();
  topCircuit.wires.clear();
  library.clear();
  seedStandardCells(library);
  resetEditorToTop();
  autosave.schedule();
  setAutosaveStatusUi('idle');
  renderBreadcrumb();
}

document.getElementById('fold')?.addEventListener('click', () => void foldSelection());
document.getElementById('unfold')?.addEventListener('click', () => void unfoldSelection());
document.getElementById('find')?.addEventListener('click', () => void findInCircuit());
document.getElementById('rename-net')?.addEventListener('click', () => void renameSelectedNet());
document.getElementById('duplicate')?.addEventListener('click', () => {
  if (editor.duplicateSelection()) uiDirty = true;
});
document.getElementById('export-selection-chip')?.addEventListener('click', () => void exportSelectionAsChip());

async function renameSelectedNet(): Promise<void> {
  const netId = netIdFromEditorSelection(editor.circuit, {
    highlightedNetId: editor.highlightedNetId,
    selectedWireId: editor.selectedWireId,
    selectedIds: editor.selectedIds,
  });
  if (!netId) {
    await showAlert('Select a wire, label, or component (or press H on a net) first.');
    return;
  }
  const name = await showPrompt('Net name (same name merges nets):', '');
  if (!name?.trim()) return;
  editHistory.checkpoint(editor.circuit);
  const result = renameNet(editor.circuit, netId, name.trim());
  if (!result.ok) {
    await showAlert(result.reason);
    return;
  }
  // Recompute so highlight tracks the (possibly merged) named net.
  const nets = editor.circuit.computeNets();
  for (const c of editor.circuit.components.values()) {
    if (c.kind === 'label' && c.name === name.trim()) {
      editor.highlightedNetId = nets.netOf.get(c.pins.net.id) ?? null;
      break;
    }
  }
  uiDirty = true;
  if (result.merged) {
    /* soft notice via status */
    statusEl.textContent = `Net merged into "${name.trim()}"`;
  }
}

async function exportSelectionAsChip(): Promise<void> {
  if (editor.selectedIds.size === 0) {
    await showAlert('Select the components to fold and export.');
    return;
  }
  const warnings = foldPortWarnings(editor.circuit, editor.selectedIds);
  if (warnings.length > 0) {
    const ok = await showConfirm(`${warnings.join('\n')}\n\nFold and export anyway?`);
    if (!ok) return;
  }
  const name = await showPrompt('Chip name:', 'CHIP');
  if (!name) return;
  editHistory.checkpoint(editor.circuit);
  const pos = snap(centroid(boundsOfSelection()));
  const { def, instance } = fold(editor.circuit, editor.selectedIds, name, library, pos);
  editor.selectedIds = new Set([instance.id]);
  refreshChipPalette();
  downloadJson(`${def.name}.json`, serializeChipDef(def, library));
  autosave.schedule();
}

async function findInCircuit(): Promise<void> {
  const q = (await showPrompt('Find (net / port / chip / label):', ''))?.trim().toLowerCase();
  if (!q) return;
  const hits: Component[] = [];
  for (const c of editor.circuit.components.values()) {
    let hay = '';
    if (c.kind === 'label' || c.kind === 'port') hay = c.name;
    else if (c.kind === 'chip') hay = library.has(c.defId) ? library.get(c.defId).name : '';
    else if (c.kind === 'probe' && c.label) hay = c.label;
    else if (c.kind === 'ram') hay = 'ram';
    else if (c.kind === 'rom') hay = 'rom';
    else hay = c.kind;
    if (hay.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) hits.push(c);
  }
  if (hits.length === 0) {
    await showAlert(`No match for "${q}".`);
    return;
  }
  editor.selectedIds = new Set(hits.map((c) => c.id));
  editor.selectedWireId = null;
  // Prefer highlighting a label/port net when the query matches one.
  const labelOrPort = hits.find((c) => c.kind === 'label' || c.kind === 'port');
  if (labelOrPort) {
    const pin =
      labelOrPort.kind === 'label'
        ? labelOrPort.pins.net
        : labelOrPort.kind === 'port'
          ? labelOrPort.pins.io
          : null;
    if (pin) {
      const nets = editor.circuit.computeNets();
      const netId = nets.netOf.get(pin.id);
      if (netId) editor.highlightedNetId = netId;
    }
  }
  const b = boundsOfIds(hits.map((c) => c.id));
  camera.fit(b, vw(), vh());
  uiDirty = true;
  syncInspector();
}

function boundsOfIds(ids: string[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const c = editor.circuit.components.get(id);
    if (!c) continue;
    minX = Math.min(minX, c.pos.x);
    minY = Math.min(minY, c.pos.y);
    maxX = Math.max(maxX, c.pos.x);
    maxY = Math.max(maxY, c.pos.y);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const pad = 80;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

async function foldSelection(): Promise<void> {
  if (editor.selectedIds.size === 0) return;
  const warnings = foldPortWarnings(editor.circuit, editor.selectedIds);
  if (warnings.length > 0) {
    const ok = await showConfirm(`${warnings.join('\n')}\n\nFold anyway?`);
    if (!ok) return;
  }
  const name = await showPrompt('Chip name:', 'CHIP');
  if (!name) return;
  editHistory.checkpoint(editor.circuit);
  const pos = snap(centroid(boundsOfSelection()));
  const { instance } = fold(editor.circuit, editor.selectedIds, name, library, pos);
  editor.selectedIds = new Set([instance.id]);
  refreshChipPalette();
  autosave.schedule();
}

async function unfoldSelection(): Promise<void> {
  const ids = [...editor.selectedIds];
  const chips = ids
    .map((id) => editor.circuit.components.get(id))
    .filter((c): c is ChipInstanceComponent => !!c && c.kind === 'chip');
  if (chips.length === 0) {
    await showAlert('Select one or more chip instances to unfold.');
    return;
  }
  editHistory.checkpoint(editor.circuit);
  const newIds = new Set<string>();
  for (const chip of chips) {
    const { ids: placed } = unfold(editor.circuit, chip.id, library);
    for (const id of placed) newIds.add(id);
  }
  editor.selectedIds = newIds;
  editor.selectedWireId = null;
  uiDirty = true;
  syncInspector();
  autosave.schedule();
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
      lastFlatNetMap = flatNetMap;
      simState = step(flat, flatNetMap, simState);
      // Do not set uiDirty here — tickBudget used to force a redraw every
      // clock edge and doubled work with frame()'s own step+draw.
    };
    machinePanel.attach(cpu.ram);
    machinePanel.bindRunner(machineRunner);
    // Wire Inputs *before* fold so clocks/seeds become chip ports.
    machineRunner.attach(editor.circuit, library, cpu, simTick, {
      readPin: (pin) => {
        if (!lastFlatNetMap) return 'Z';
        const net = lastFlatNetMap.netOf.get(pin.id);
        if (!net) return 'Z';
        return simState.levelOf.get(net) ?? 'Z';
      },
    });
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
  exportActiveSession();
});

function exportActiveSession(): void {
  const meta = getSessionMeta();
  const slot = meta.slots.find((s) => s.id === meta.activeId);
  const safe = (slot?.name ?? 'session').replace(/[^\w.-]+/g, '_');
  downloadJson(`${safe}.json`, serializeProject(topCircuit, library));
}

autosaveStatusEl?.addEventListener('click', () => {
  exportActiveSession();
});

const watchStripEl = document.getElementById('watch-strip');

function refreshWatchStrip(): void {
  if (!watchStripEl) return;
  const probes = [...editor.circuit.components.values()].filter((c) => c.kind === 'probe');
  if (probes.length === 0) {
    watchStripEl.classList.remove('visible');
    watchStripEl.replaceChildren();
    return;
  }
  watchStripEl.classList.add('visible');
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(watchStripEl.children)) {
    const id = (child as HTMLElement).dataset.probeId;
    if (id) existing.set(id, child as HTMLElement);
  }
  watchStripEl.replaceChildren();
  const title = document.createElement('span');
  title.className = 'watch-label';
  title.textContent = 'Watch';
  watchStripEl.appendChild(title);
  for (const p of probes) {
    if (p.kind !== 'probe') continue;
    let item = existing.get(p.id);
    if (!item) {
      item = document.createElement('span');
      item.className = 'watch-item';
      item.dataset.probeId = p.id;
      const name = document.createElement('span');
      name.className = 'watch-name';
      const lvl = document.createElement('span');
      lvl.className = 'watch-lvl';
      lvl.dataset.lvl = 'Z';
      lvl.textContent = 'Z';
      item.append(name, lvl);
    }
    const nameEl = item.querySelector('.watch-name')!;
    nameEl.textContent = p.label?.trim() || 'probe';
    watchStripEl.appendChild(item);
  }
}

function updateWatchLevels(
  resolve: (localPinId: string) => { level: Level; contended: boolean },
): void {
  if (!watchStripEl?.classList.contains('visible')) return;
  for (const child of Array.from(watchStripEl.querySelectorAll('.watch-item'))) {
    const id = (child as HTMLElement).dataset.probeId;
    if (!id) continue;
    const c = editor.circuit.components.get(id);
    if (!c || c.kind !== 'probe') continue;
    const { level } = resolve(c.pins.in.id);
    const lvlEl = child.querySelector('.watch-lvl') as HTMLElement | null;
    if (!lvlEl) continue;
    const text = String(level);
    lvlEl.dataset.lvl = text;
    lvlEl.textContent = text;
  }
}

refreshWatchStrip();

function resetViewAfterProjectLoad(): void {
  navStack.length = 0;
  navStack.push({ circuit: topCircuit, pathPrefix: '', label: 'top' });
  editor.circuit = topCircuit;
  editor.clearSelection();
  editor.cancelWire();
  editHistory.clear();
  simState = initialState();
  renderBreadcrumb();
  refreshChipPalette();
  refreshWatchStrip();
  camera.fit(circuitBounds(topCircuit), vw(), vh());
  machineRunner.detach();
  machinePanel.detach();
  memoryEditor.detach();
  logicAnalyzer.clearChannels();
  objectInspector.setContext({
    circuit: topCircuit,
    library,
    defId: null,
    allCircuits: [topCircuit, ...library.list().map((d) => d.circuit)],
  });
  objectInspector.sync(null);
  uiDirty = true;
  autosave.schedule();
}

async function openExampleProject(): Promise<void> {
  const pick = await showChoice(
    'Open example',
    EXAMPLE_PROJECTS.map((ex) => ({
      value: ex.id,
      label: ex.title,
      detail: ex.detail,
    })),
  );
  if (!pick || pick.action === 'delete') return;
  const ex = EXAMPLE_PROJECTS.find((e) => e.id === pick.value);
  if (!ex) return;
  if (
    !(await showConfirm(
      `Load “${ex.title}”? This replaces the current circuit and chip library in this session.`,
    ))
  ) {
    return;
  }
  try {
    applyLoadedProject(deserializeProject(ex.project));
    resetViewAfterProjectLoad();
    if (ex.id === 'd-latch') {
      await showAlert(
        'Latch walkthrough:\n\n' +
          '1. Toggle D (data) with the select tool.\n' +
          '2. Pulse or hold Enable so Q follows D.\n' +
          '3. Release Enable — Q holds the last value.\n' +
          '4. Double-click the chip to dive into its gates.\n\n' +
          'Press ? for keyboard shortcuts.',
      );
    }
  } catch (err) {
    await showAlert(`Could not load example: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function openLatchTutorial(): Promise<void> {
  const ex = EXAMPLE_PROJECTS.find((e) => e.id === 'd-latch');
  if (!ex) {
    await showAlert('Latch tutorial example is missing.');
    return;
  }
  if (
    !(await showConfirm(
      `Load “${ex.title}”? This replaces the current circuit and chip library in this session.`,
    ))
  ) {
    return;
  }
  try {
    applyLoadedProject(deserializeProject(ex.project));
    resetViewAfterProjectLoad();
    await showAlert(
      'Latch walkthrough:\n\n' +
        '1. Toggle D (data) with the select tool.\n' +
        '2. Pulse or hold Enable so Q follows D.\n' +
        '3. Release Enable — Q holds the last value.\n' +
        '4. Double-click the chip to dive into its gates.\n\n' +
        'Press ? for keyboard shortcuts.',
    );
  } catch (err) {
    await showAlert(`Could not load tutorial: ${err instanceof Error ? err.message : String(err)}`);
  }
}

document.getElementById('open-examples')?.addEventListener('click', () => void openExampleProject());
document.getElementById('help-tutorial')?.addEventListener('click', () => void openLatchTutorial());
document.getElementById('help-cheatsheet')?.addEventListener('click', () => toggleCheatSheet());

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
      applyLoadedProject(loaded);
      resetViewAfterProjectLoad();
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

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportSchematicPng(): void {
  const bounds = circuitBounds(editor.circuit);
  const w = 1600;
  const h = 1000;
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const octx = off.getContext('2d');
  if (!octx) return;
  const cam = new Camera();
  cam.fit(bounds, w, h);
  const view = navStack[navStack.length - 1]!;
  const flat = flatten(topCircuit, library);
  const flatNetMap = flat.computeNets();
  const resolve = (localPinId: string): { level: Level; contended: boolean } => {
    const net = flatNetMap.netOf.get(view.pathPrefix + localPinId);
    if (!net) return { level: 'Z', contended: false };
    return { level: simState.levelOf.get(net) ?? 'Z', contended: simState.contended.has(net) };
  };
  draw(octx, cam, w, h, editor.circuit, resolve, editor, library);
  off.toBlob((blob) => {
    if (blob) downloadBlob('schematic.png', blob);
  }, 'image/png');
}

function exportSchematicSvg(): void {
  const circuit = editor.circuit;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of circuit.components.values()) {
    minX = Math.min(minX, c.pos.x - 40);
    minY = Math.min(minY, c.pos.y - 40);
    maxX = Math.max(maxX, c.pos.x + 40);
    maxY = Math.max(maxY, c.pos.y + 40);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 200;
    maxY = 200;
  }
  const pad = 20;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  const pinById = new Map([...circuit.allPins()].map((p) => [p.id, p]));
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" ` +
      `width="${Math.round(maxX - minX)}" height="${Math.round(maxY - minY)}">`,
  );
  parts.push('<rect fill="#0b0c10" x="' + minX + '" y="' + minY + '" width="' + (maxX - minX) + '" height="' + (maxY - minY) + '"/>');
  for (const w of circuit.wires.values()) {
    const a = pinById.get(w.a);
    const b = pinById.get(w.b);
    if (!a || !b) continue;
    const pts = w.waypoints?.length ? [a.pos, ...w.waypoints, b.pos] : [a.pos, b.pos];
    parts.push(
      `<polyline fill="none" stroke="#9aa1b3" stroke-width="2" points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}"/>`,
    );
  }
  for (const c of circuit.components.values()) {
    const label =
      c.kind === 'chip'
        ? c.marking || (library.has(c.defId) ? library.get(c.defId).name : c.kind)
        : c.kind === 'label' || c.kind === 'port'
          ? c.name
          : c.kind;
    const bw = c.kind === 'chip' ? (c.boxWidth ?? 96) : 48;
    const bh = 36;
    parts.push(
      `<rect x="${c.pos.x - bw / 2}" y="${c.pos.y - bh / 2}" width="${bw}" height="${bh}" ` +
        `fill="#191c25" stroke="#f5c518" stroke-width="1.5" rx="4"/>`,
    );
    parts.push(
      `<text x="${c.pos.x}" y="${c.pos.y + 4}" text-anchor="middle" fill="#e7e9ef" ` +
        `font-family="ui-monospace,monospace" font-size="11">${escapeXml(label)}</text>`,
    );
  }
  parts.push('</svg>');
  downloadBlob('schematic.svg', new Blob([parts.join('\n')], { type: 'image/svg+xml' }));
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

document.getElementById('export-png')?.addEventListener('click', () => exportSchematicPng());
document.getElementById('export-svg')?.addEventListener('click', () => exportSchematicSvg());

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

/** True while focus is in a dialog, floating instrument, or text field. */
function focusInUiChrome(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return !!el.closest('.float-win, .z80-dialog-overlay, .hex-view, .z80-ctx, .z80-cheat, #minimap');
}

function isPanGesture(ev: MouseEvent): boolean {
  // Right button (2) — middle-click is awkward on many mice/trackpads.
  return editor.tool.kind === 'pan' || spacePressed || ev.button === 2;
}

let rightDragDist = 0;
let rightDragOrigin: { x: number; y: number } | null = null;

function orientSelected(mode: 'cw' | 'ccw' | 'flipH' | 'flipV'): boolean {
  const comps = [...editor.selectedIds]
    .map((id) => editor.circuit.components.get(id))
    .filter((c): c is Component => !!c && isOrientable(c));
  if (comps.length === 0) return false;
  editHistory.checkpoint(editor.circuit);
  orientSelection(comps, mode, (c, dx, dy) => editor.circuit.moveComponent(c.id, dx, dy));
  editor.tidySelectedWires(false);
  return true;
}

function openCanvasContextMenu(ev: MouseEvent): void {
  const world = worldPoint(ev);
  editor.handleMouseMove(world);

  const pin = editor.hoveredPinId
    ? editor.circuit.allPins().find((p) => p.id === editor.hoveredPinId)
    : undefined;
  const hitComp = editor.hoveredComponentId
    ? editor.circuit.components.get(editor.hoveredComponentId)
    : undefined;
  const hitWireId = editor.hoveredWireId;

  // Prefer the hit target for selection when nothing useful is selected.
  if (hitComp && !editor.selectedIds.has(hitComp.id)) {
    editor.selectedIds = new Set([hitComp.id]);
    editor.selectedWireId = null;
  } else if (hitWireId && editor.selectedIds.size === 0) {
    editor.selectedWireId = hitWireId;
  }

  const hasSel = editor.selectedIds.size > 0 || editor.selectedWireIds.size > 0;
  const orientable = [...editor.selectedIds]
    .map((id) => editor.circuit.components.get(id))
    .filter((c): c is Component => !!c && isOrientable(c));
  const chipSel = [...editor.selectedIds]
    .map((id) => editor.circuit.components.get(id))
    .filter((c): c is ChipInstanceComponent => c?.kind === 'chip');
  const analyzerSel = [...editor.selectedIds]
    .map((id) => editor.circuit.components.get(id))
    .find((c) => c?.kind === 'analyzer');

  const items: (ContextMenuItem | 'sep')[] = [];
  if (orientable.length > 0) {
    items.push(
      { label: 'Rotate CW', kbd: 'R', run: () => { if (orientSelected('cw')) { uiDirty = true; syncInspector(); objectInspector.refresh(); } } },
      { label: 'Rotate CCW', kbd: '⇧R', run: () => { if (orientSelected('ccw')) { uiDirty = true; syncInspector(); objectInspector.refresh(); } } },
      { label: 'Flip H', kbd: 'M', run: () => { if (orientSelected('flipH')) { uiDirty = true; syncInspector(); objectInspector.refresh(); } } },
      { label: 'Flip V', kbd: '⇧M', run: () => { if (orientSelected('flipV')) { uiDirty = true; syncInspector(); objectInspector.refresh(); } } },
      'sep',
    );
  }
  items.push({
    label: 'Tidy wires',
    kbd: 'T',
    disabled: !hasSel,
    run: () => {
      if (editor.tidySelectedWires() > 0) uiDirty = true;
    },
  });
  items.push({
    label: 'Delete',
    kbd: 'Del',
    danger: true,
    disabled: !hasSel,
    run: () => editor.handleDelete(),
  });
  if (chipSel.length === 1) {
    items.push({
      label: 'Dive',
      run: () => void diveInto(chipSel[0]!),
    });
  }
  if (analyzerSel && analyzerSel.kind === 'analyzer') {
    items.push({
      label: 'Add LA channel',
      run: () => {
        if (editor.addAnalyzerChannel(analyzerSel.id)) {
          uiDirty = true;
          objectInspector.refresh();
        }
      },
    });
  }
  if (pin && hitComp?.kind === 'chip') {
    const pinName = pin.name;
    items.push('sep');
    items.push({
      label: `Pin “${pinName}” → Left`,
      run: () => {
        if (editor.setChipPinSide(hitComp.id, pinName, -1)) {
          uiDirty = true;
          objectInspector.refresh();
        }
      },
    });
    items.push({
      label: `Pin “${pinName}” → Right`,
      run: () => {
        if (editor.setChipPinSide(hitComp.id, pinName, 1)) {
          uiDirty = true;
          objectInspector.refresh();
        }
      },
    });
  }
  items.push('sep');
  items.push({
    label: 'Rename net…',
    kbd: '⌃R',
    run: () => void renameSelectedNet(),
  });
  items.push({
    label: 'Copy',
    kbd: '⌃C',
    disabled: editor.selectedIds.size === 0,
    run: () => editor.copySelection(),
  });
  items.push({
    label: 'Paste',
    kbd: '⌃V',
    run: () => {
      if (editor.pasteClipboard()) uiDirty = true;
    },
  });

  showContextMenu(ev.clientX, ev.clientY, items);
  uiDirty = true;
}

canvas.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  if (rightDragDist > 6) {
    rightDragDist = 0;
    return;
  }
  openCanvasContextMenu(ev);
});

canvas.addEventListener('mousedown', (ev) => {
  mouseDownOnCanvas = true;
  hideContextMenu();
  if (isPanGesture(ev)) {
    ev.preventDefault();
    panDrag = { startScreen: screenPoint(ev) };
    if (ev.button === 2) {
      rightDragOrigin = screenPoint(ev);
      rightDragDist = 0;
    }
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
    if (rightDragOrigin) {
      const dx = p.x - rightDragOrigin.x;
      const dy = p.y - rightDragOrigin.y;
      rightDragDist = Math.hypot(dx, dy);
    }
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
    rightDragOrigin = null;
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
    await diveInto(hit);
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
  }
  // Labels / buttons / clocks / ports — use the Object Inspector (selection).
});

const NUDGE_KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, -GRID],
  ArrowDown: [0, GRID],
  ArrowLeft: [-GRID, 0],
  ArrowRight: [GRID, 0],
};

window.addEventListener('keydown', (ev) => {
  // Cheat sheet / context menu close even when focus is in chrome.
  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key === '?') {
    ev.preventDefault();
    toggleCheatSheet();
    return;
  }
  if (ev.key === 'Escape') {
    if (cheatSheetOpen()) {
      hideCheatSheet();
      ev.preventDefault();
      return;
    }
    if (contextMenuOpen()) {
      hideContextMenu();
      ev.preventDefault();
      return;
    }
  }
  // Hex editor / floating instruments / dialogs use focusable divs, not only
  // INPUT/TEXTAREA — skip canvas hotkeys while typing there.
  if (focusInUiChrome()) return;
  if (ev.code === 'Space') spacePressed = true;
  const noModifiers = !ev.ctrlKey && !ev.metaKey && !ev.altKey;

  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'g') {
    ev.preventDefault();
    if (ev.shiftKey) void unfoldSelection();
    else void foldSelection();
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') {
    ev.preventDefault();
    void findInCircuit();
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'r' && !ev.shiftKey) {
    ev.preventDefault();
    void renameSelectedNet();
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'd') {
    ev.preventDefault();
    if (editor.duplicateSelection()) uiDirty = true;
  } else if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === 'e') {
    ev.preventDefault();
    void exportSelectionAsChip();
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
    if (editor.escapeWireStep()) {
      /* bend popped or wire cancelled */
    } else if (navStack.length > 1) {
      diveTo(navStack.length - 2);
    }
  } else if (ev.key === '0') {
    camera.scale = 1;
  } else if (ev.key.toLowerCase() === 'f') {
    camera.fit(circuitBounds(editor.circuit), vw(), vh());
  } else if (ev.altKey && !ev.ctrlKey && !ev.metaKey && NUDGE_KEYS[ev.key] && editor.selectedIds.size >= 2) {
    ev.preventDefault();
    const [dx, dy] = NUDGE_KEYS[ev.key]!;
    if (ev.shiftKey && editor.selectedIds.size >= 3) {
      if (dx !== 0) editor.distributeSelection('x');
      else editor.distributeSelection('y');
    } else if (!ev.shiftKey) {
      if (dx < 0) editor.alignSelection('x', 'min');
      else if (dx > 0) editor.alignSelection('x', 'max');
      else if (dy < 0) editor.alignSelection('y', 'min');
      else if (dy > 0) editor.alignSelection('y', 'max');
    }
    uiDirty = true;
    syncInspector();
  } else if (noModifiers && NUDGE_KEYS[ev.key] && editor.selectedIds.size > 0) {
    // Fine-positioning after a rough drag — one grid step per press, no
    // separate "confirm" step needed since a move is already grid-snapped.
    ev.preventDefault();
    editHistory.checkpoint(editor.circuit);
    const [dx, dy] = NUDGE_KEYS[ev.key]!;
    for (const id of editor.selectedIds) editor.circuit.moveComponent(id, dx, dy);
    editor.tidySelectedWires(false);
  } else if (noModifiers && ev.key.toLowerCase() === 'h') {
    editor.highlightSelectionNet();
    uiDirty = true;
  } else if (noModifiers && ev.key.toLowerCase() === 't') {
    if (editor.tidySelectedWires() > 0) uiDirty = true;
  } else if (noModifiers && (ev.key === 'r' || ev.key === 'R')) {
    if (orientSelected(ev.shiftKey ? 'ccw' : 'cw')) {
      ev.preventDefault();
      uiDirty = true;
      syncInspector();
      objectInspector.refresh();
    }
  } else if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key.toLowerCase() === 'm') {
    if (orientSelected(ev.shiftKey ? 'flipV' : 'flipH')) {
      ev.preventDefault();
      uiDirty = true;
      syncInspector();
      objectInspector.refresh();
    }
  } else if (noModifiers && ev.key === '=') {
    minimap.setVisible(minimap.root.hidden);
    uiDirty = true;
  } else if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.shiftKey && ev.key.toLowerCase() === 'o') {
    ev.preventDefault();
    setTool({ kind: 'port', promptName: true });
  } else if (noModifiers && TOOL_KEYS.has(ev.key.toLowerCase())) {
    setTool(TOOL_KEYS.get(ev.key.toLowerCase())!);
  }
});
window.addEventListener('keyup', (ev) => {
  if (focusInUiChrome()) return;
  if (ev.code === 'Space') spacePressed = false;
});

// --- Simulation + render loop -------------------------------------------
const statusEl = document.getElementById('status') as HTMLDivElement;
let lastContendedNets = new Set<string>();
let simPaused = false;
let simStepOnce = false;

const minimap = new Minimap(
  () => editor.circuit,
  () => camera,
  () => ({ w: vw(), h: vh() }),
  () => {
    uiDirty = true;
  },
);
stage.appendChild(minimap.root);

function updateSimChrome(): void {
  document.getElementById('sim-run')?.classList.toggle('active', !simPaused);
  document.getElementById('sim-pause')?.classList.toggle('active', simPaused);
}

document.getElementById('sim-run')?.addEventListener('click', () => {
  simPaused = false;
  if (machineRunner.attached) machineRunner.setRunning(true);
  updateSimChrome();
  uiDirty = true;
});
document.getElementById('sim-pause')?.addEventListener('click', () => {
  simPaused = true;
  if (machineRunner.attached) machineRunner.setRunning(false);
  updateSimChrome();
  uiDirty = true;
});
document.getElementById('sim-step')?.addEventListener('click', () => {
  if (machineRunner.attached) {
    machineRunner.setRunning(false);
    machineRunner.stepInstruction();
  }
  simPaused = true;
  simStepOnce = true;
  updateSimChrome();
  uiDirty = true;
});
updateSimChrome();

function highlightFirstContendedNet(): void {
  if (lastContendedNets.size === 0 || !lastFlatNetMap) return;
  const netId = [...lastContendedNets][0]!;
  const view = navStack[navStack.length - 1]!;
  const pins = lastFlatNetMap.pinsOf.get(netId) ?? [];
  const localPins = pins
    .filter((p) => (view.pathPrefix ? p.startsWith(view.pathPrefix) : !p.includes('/')))
    .map((p) => (view.pathPrefix ? p.slice(view.pathPrefix.length) : p));
  editor.clearSelection();
  const localNets = editor.circuit.computeNets();
  for (const pid of localPins) {
    const compId = pid.split(':')[0];
    if (compId && editor.circuit.components.has(compId)) editor.selectedIds.add(compId);
  }
  if (localPins[0]) {
    editor.highlightedNetId = localNets.netOf.get(localPins[0]) ?? null;
  } else {
    // Named rails (VCC/GND) may already match local net ids.
    editor.highlightedNetId = localNets.pinsOf.has(netId) ? netId : null;
  }
  // Also select wires on the highlighted local net.
  if (editor.highlightedNetId) {
    for (const w of editor.circuit.wires.values()) {
      if (localNets.netOf.get(w.a) === editor.highlightedNetId) editor.selectedWireIds.add(w.id);
    }
  }
  syncInspector();
  uiDirty = true;
}

statusEl.addEventListener('click', () => {
  if (lastContendedNets.size === 0) return;
  highlightFirstContendedNet();
});

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
  syncInspector();
  // Catch Insert-menu / paste / clear mutations that skip onBeforeEdit.
  const ver = currentStructureVersion();
  if (ver !== lastAutosaveStructureVersion) {
    lastAutosaveStructureVersion = ver;
    autosave.schedule();
    refreshWatchStrip();
  }
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
      : uiDirty ||
        (!simPaused && !simState.settled) ||
        simStepOnce ||
        (machineRunner.running && machineWorked) ||
        labActive;

  if (needSimDraw) {
    // Keep backing store in sync even if a layout change slipped past the
    // ResizeObserver (e.g. panel attach in the same turn as a zoom redraw).
    resizeCanvas();
    // Soft at top level: draw chip boxes without expanding ~200k components
    // through flatten() — interactive TTY does not need pin levels. Dive-in
    // (navStack depth > 1) or any Gates path still flattens as before.
    const softTop = softRun && navStack.length === 1;
    if (!softRun || uiDirty || labActive || simStepOnce) {
      const view = navStack[navStack.length - 1]!;
      if (softTop && !labActive && !simStepOnce) {
        const resolve = (_localPinId: string): { level: Level; contended: boolean } => ({
          level: 'Z',
          contended: false,
        });
        draw(ctx!, camera, vw(), vh(), view.circuit, resolve, editor, library, { softMode: true });
        drawSoftBitmapHud(ctx!, vw(), vh());
        minimap.draw();
        zoomPctEl.textContent = `${Math.round(camera.scale * 100)}%`;
        lastContendedNets = new Set();
        statusEl.classList.remove('clickable');
        statusEl.textContent = `${navStack.map((f) => f.label).join('/')} | soft (flatten deferred) | machine: soft${simPaused ? ' | sim paused' : ''}`;
        updateWatchLevels(resolve);
      } else {
        const flat = flatten(topCircuit, library);
        const flatNetMap = flat.computeNets();
        lastFlatNetMap = flatNetMap;
        if (!softRun && (!simPaused || simStepOnce)) {
          simState = step(flat, flatNetMap, simState);
        }
        simStepOnce = false;
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

        draw(ctx!, camera, vw(), vh(), view.circuit, resolve, editor, library, {
          softMode: softRun,
        });
        drawSoftBitmapHud(ctx!, vw(), vh());
        minimap.draw();
        zoomPctEl.textContent = `${Math.round(camera.scale * 100)}%`;
        lastContendedNets = new Set(simState.contended);
        if (lastContendedNets.size > 0) statusEl.classList.add('clickable');
        else statusEl.classList.remove('clickable');
        const contendedHint =
          lastContendedNets.size > 0 && lastContendedNets.size <= 4
            ? ` [${[...lastContendedNets].map((n) => editor.formatNetName(n) ?? n).join(', ')}]`
            : '';
        const mode =
          machineRunner.running && machineRunner.isSoft
            ? 'machine: soft'
            : machineRunner.running
              ? 'machine: gates'
              : machineRunner.attached
                ? 'machine: pause'
                : '';
        const lab = labActive ? ' | lab' : '';
        const paused = simPaused ? ' | sim paused' : '';
        statusEl.textContent =
          `${navStack.map((f) => f.label).join('/')} | flat nets: ${flatNetMap.pinsOf.size} | ` +
          `iterations: ${simState.iterations} | settled: ${simState.settled} | contended: ${simState.contended.size}${contendedHint}` +
          (mode ? ` | ${mode}` : '') +
          lab +
          paused;
        updateWatchLevels(resolve);
      }
    }
    uiDirty = false;
  }
  // Soft TTY samples ram.bytes independently of the transistor canvas.
  if (machinePanel.attached) machinePanel.draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
