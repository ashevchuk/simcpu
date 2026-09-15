import { bodyEdgeToward, getOrientation, transformOffset } from '../sim/orientation.js';
import type { ChipLibrary } from '../sim/ChipLibrary.js';
import type { Circuit } from '../sim/Circuit.js';
import { CHIP_INSTANCE_WIDTH, chipBodyWidth, chipBoxHeight, chipInstanceHeight, ramPortCount, romPortCount } from '../sim/library.js';
import type { Component, Level, Pin, Point } from '../sim/types.js';
import type { Camera } from './Camera.js';
import type { Editor } from './Editor.js';
import { GRID, findWireCrossings, routeWirePoints } from './geometry.js';

const COLOR = {
  bg: '#12141a',
  grid: '#2a2f3a',
  wireHigh: '#ff6b6b',
  wireLow: '#4da3ff',
  wireFloat: '#5b6272',
  contended: '#ff36e0',
  body: '#262b38',
  chipBody: '#232a4a',
  ramBody: '#2a3a2c',
  strokeN: '#5fd0d6',
  strokeP: '#e8b358',
  bodyStroke: '#7d8496',
  selected: '#f5c518',
  hover: '#c9cede',
  marquee: 'rgba(245, 197, 24, 0.12)',
  marqueeStroke: 'rgba(245, 197, 24, 0.65)',
  text: '#e7e9ef',
  textDim: '#9aa1b3',
};

function levelColor(level: Level, contended: boolean): string {
  if (contended) return COLOR.contended;
  if (level === 1) return COLOR.wireHigh;
  if (level === 0) return COLOR.wireLow;
  return COLOR.wireFloat;
}

/** Resolves a pin id (in the *currently viewed* circuit's local id space) to its live level. */
export type LevelResolver = (pinId: string) => { level: Level; contended: boolean };

/**
 * Viewport culling. Found live once a real `+ Z80CPU` — hundreds/thousands
 * of `chip`/`ram`/register-bit primitives, built directly into the
 * caller's own circuit rather than folded into one opaque instance (see
 * ARCHITECTURE.md's "Closing out the CPU" and "Canvas 2D rendering cost")
 * — turned a placement-time render into a browser-tab crash, not just the
 * previously-measured `~3.8fps`: with no auto-fit-camera-to-the-whole-thing
 * step after placement, the vast majority of a freshly-placed composite's
 * components sit *outside* the current viewport, at whatever zoom/pan the
 * canvas already had — yet `draw()` iterated and fully rendered (gradients,
 * multiple pin dots, stubs, text) every single one of them regardless,
 * every single call. `componentRadius` is a deliberately generous per-kind
 * half-extent (body size plus enough slack for stub lines to a pin and any
 * text drawn outside the body, e.g. a `label`'s name above its dot) — an
 * approximation, not exact pin geometry, because exactness buys nothing
 * here: the only failure mode worth avoiding is culling something that's
 * *actually* a few pixels on-screen, and a generous margin costs one cheap
 * bounds check per component to rule out, not a redraw.
 */
export function componentRadius(c: Component): { rx: number; ry: number } {
  switch (c.kind) {
    case 'transistor':
      return { rx: 30, ry: 34 };
    case 'button':
      return { rx: 28, ry: 26 };
    case 'source':
      return { rx: 28, ry: 30 };
    case 'input':
      return { rx: 22, ry: 20 };
    case 'clock':
      return { rx: 32, ry: 26 };
    case 'analyzer':
      return { rx: 40, ry: Math.max(28, (c.channelCount * 16) / 2 + 20) };
    case 'tty':
      return { rx: 44, ry: 30 };
    case 'probe':
      return { rx: 24, ry: 34 };
    case 'led':
      return { rx: 26, ry: 34 };
    case 'label':
      return { rx: 50, ry: 24 };
    case 'port':
      return { rx: 40, ry: 28 };
    case 'chip':
      return { rx: chipBodyWidth(c) / 2 + 20, ry: chipBoxHeight(c) / 2 + 20 };
    case 'ram':
      return { rx: CHIP_INSTANCE_WIDTH / 2 + 20, ry: chipInstanceHeight(ramPortCount(c)) / 2 + 20 };
    case 'rom':
      return { rx: CHIP_INSTANCE_WIDTH / 2 + 20, ry: chipInstanceHeight(romPortCount(c)) / 2 + 20 };
  }
}

export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOverlap(a: WorldBounds, b: WorldBounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function isComponentVisible(c: Component, visible: WorldBounds): boolean {
  const { rx, ry } = componentRadius(c);
  return boundsOverlap({ minX: c.pos.x - rx, minY: c.pos.y - ry, maxX: c.pos.x + rx, maxY: c.pos.y + ry }, visible);
}

export function isWireVisible(points: { x: number; y: number }[], visible: WorldBounds): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  // A wire's own glow underlay is a handful of px wide at most — a fixed
  // small margin (not componentRadius's per-kind sizing, which doesn't
  // apply to a polyline) comfortably covers it.
  const margin = 12;
  return boundsOverlap({ minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin }, visible);
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Soft glow ring behind a rounded-rect body: a wider, low-alpha stroke, cheaper and more predictable across browsers than ctx.shadowBlur under a zoom transform. */
function glowRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, color: string): void {
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  roundRectPath(ctx, x - 2, y - 2, w + 4, h + 4, r + 2);
  ctx.stroke();
  ctx.restore();
}

export function draw(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  viewportW: number,
  viewportH: number,
  circuit: Circuit,
  resolve: LevelResolver,
  editor: Editor,
  library: ChipLibrary,
  opts?: { softMode?: boolean },
): void {
  // Clear the full backing store in device pixels (identity transform), not
  // just the CSS viewport rect. Avoids a 1-px stale strip when
  // round(w*dpr) > w*dpr, and any leftover from a previous larger buffer
  // before resizeCanvas caught up.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();

  ctx.save();
  ctx.translate(viewportW / 2, viewportH / 2);
  ctx.scale(camera.scale, camera.scale);
  ctx.translate(-camera.x, -camera.y);

  // Soft Run: mute live wire/pin colors so a quiet schematic is not mistaken
  // for a stuck gate sim — levels are often Z while the soft CPU runs in RAM.
  if (opts?.softMode) {
    ctx.globalAlpha = 0.55;
  }

  drawGrid(ctx, camera, viewportW, viewportH);

  // A fixed screen-space margin (in world units, i.e. divided by scale)
  // around the visible viewport — generous enough that a component's own
  // glow ring or a wire's bend point dragged just past the edge doesn't pop
  // in and out as the camera pans by a pixel. See `componentRadius`'s own
  // doc comment for why this culling exists at all.
  const cullMargin = 200 / camera.scale;
  const topLeft = camera.screenToWorld({ x: 0, y: 0 }, viewportW, viewportH);
  const bottomRight = camera.screenToWorld({ x: viewportW, y: viewportH }, viewportW, viewportH);
  const visible: WorldBounds = {
    minX: topLeft.x - cullMargin,
    minY: topLeft.y - cullMargin,
    maxX: bottomRight.x + cullMargin,
    maxY: bottomRight.y + cullMargin,
  };

  const pinById = new Map<string, Pin>();
  for (const p of circuit.allPins()) pinById.set(p.id, p);

  const highlightNet = editor.highlightedNetId;
  const hoverNet = editor.netIdUnderPointer();
  const glowNet = highlightNet ?? hoverNet;
  const netOf = glowNet ? circuit.computeNets().netOf : null;

  // Wires first, so component bodies sit on top of the lines meeting them.
  const routedWires: Point[][] = [];
  for (const w of circuit.wires.values()) {
    const a = pinById.get(w.a);
    const b = pinById.get(w.b);
    if (!a || !b) continue;
    const raw = w.waypoints && w.waypoints.length ? [a.pos, ...w.waypoints, b.pos] : [a.pos, b.pos];
    const points = routeWirePoints(raw);
    routedWires.push(points);
    if (!isWireVisible(points, visible)) continue;
    const { level, contended } = resolve(w.a);
    const netHit = netOf != null && glowNet != null && netOf.get(w.a) === glowNet;
    const sticky = highlightNet != null && netHit;
    const emphasis =
      w.id === editor.selectedWireId || editor.selectedWireIds.has(w.id)
        ? 'selected'
        : sticky
          ? 'net'
          : netHit
            ? 'hover'
            : editor.tool.kind === 'select' && w.id === editor.hoveredWireId
              ? 'hover'
              : 'none';
    drawWire(ctx, points, levelColor(level, contended), contended, emphasis);
  }

  // Schematic-style dots where orthogonal wires cross (not join).
  ctx.save();
  ctx.fillStyle = COLOR.bodyStroke;
  for (const p of findWireCrossings(routedWires)) {
    if (p.x < visible.minX || p.x > visible.maxX || p.y < visible.minY || p.y > visible.maxY) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Rubber-band while a wire is in progress: the start pin, every bend
  // point committed so far, then a dashed segment out to the cursor.
  if (editor.tool.kind === 'wire' && editor.wireStartPinId) {
    const start = pinById.get(editor.wireStartPinId);
    if (start) {
      const raw = [start.pos, ...editor.wireWaypoints, editor.mouse];
      const points = routeWirePoints(raw);
      ctx.save();
      ctx.strokeStyle = COLOR.hover;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([5, 5]);
      strokeRoundedPolyline(ctx, points, 7);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLOR.hover;
      for (const p of editor.wireWaypoints) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  for (const c of circuit.components.values()) {
    if (!isComponentVisible(c, visible)) continue;
    const selected = editor.selectedIds.has(c.id);
    const hovered = !selected && editor.hoveredComponentId === c.id && editor.tool.kind === 'select';
    drawComponent(ctx, c, resolve, selected, hovered, library);
  }

  // Hovered pin magnet while the wire tool is active (placing or completing).
  if (editor.tool.kind === 'wire' && editor.hoveredPinId) {
    const p = pinById.get(editor.hoveredPinId);
    if (p) {
      ctx.save();
      ctx.strokeStyle = COLOR.selected;
      ctx.fillStyle = 'rgba(245, 197, 24, 0.18)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.pos.x, p.pos.y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.pos.x, p.pos.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = COLOR.selected;
      ctx.fill();
      ctx.restore();
    }
  }

  // Draggable bend-point handles, only for the wire that's selected or (in
  // select tool) currently hovered — showing them on every wire at once
  // would just be noise.
  for (const w of circuit.wires.values()) {
    if (!w.waypoints || w.waypoints.length === 0) continue;
    const isSelected = editor.selectedWireIds.has(w.id);
    const isHovered = editor.tool.kind === 'select' && w.id === editor.hoveredWireId;
    if (!isSelected && !isHovered) continue;
    ctx.fillStyle = isSelected ? COLOR.selected : COLOR.hover;
    for (const wp of w.waypoints) {
      ctx.beginPath();
      ctx.arc(wp.x, wp.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Marquee selection rectangle (already in world space, same transform as everything else).
  if (editor.marqueeStart && editor.dragging) {
    const { x, y } = editor.marqueeStart;
    const w = editor.mouse.x - x;
    const h = editor.mouse.y - y;
    ctx.fillStyle = COLOR.marquee;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = COLOR.marqueeStroke;
    ctx.lineWidth = 1 / camera.scale;
    ctx.strokeRect(x, y, w, h);
  }

  // Net name chip near the cursor (hover wire/pin, or sticky H highlight).
  // Prefer pin name+net when a pin is under the cursor.
  let tip = '';
  if (editor.hoveredPinId && !editor.dragging) {
    const pin = pinById.get(editor.hoveredPinId);
    if (pin) {
      const nets = circuit.computeNets();
      const net = editor.formatNetName(nets.netOf.get(pin.id) ?? null);
      const { level, contended } = resolve(pin.id);
      const lvl = contended ? 'X' : level === 'Z' ? 'Z' : String(level);
      tip = net ? `${pin.name} · ${net} · ${lvl}` : `${pin.name} · ${lvl}`;
    }
  }
  if (!tip) tip = editor.formatNetName(glowNet) ?? '';
  // Chip dive preview while hovering an instance in select tool.
  if (
    !tip &&
    editor.tool.kind === 'select' &&
    editor.hoveredComponentId &&
    !editor.dragging
  ) {
    const hc = circuit.components.get(editor.hoveredComponentId);
    if (hc?.kind === 'chip' && library.has(hc.defId)) {
      const def = library.get(hc.defId);
      const edited = (def.revision ?? 0) !== (hc.defRevision ?? 0);
      tip = `${def.name} · ${def.ports.length} pins · Dive${edited ? ' · edited' : ''}`;
    }
  }
  if (tip && !editor.dragging) {
    const lx = editor.mouse.x + 12 / camera.scale;
    const ly = editor.mouse.y - 10 / camera.scale;
    ctx.save();
    ctx.font = `${11 / camera.scale}px ui-monospace, "SF Mono", monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const pad = 4 / camera.scale;
    const tw = ctx.measureText(tip).width;
    const th = 14 / camera.scale;
    ctx.fillStyle = 'rgba(18, 20, 28, 0.88)';
    ctx.strokeStyle = glowNet === highlightNet ? '#5ec8ff' : COLOR.hover;
    ctx.lineWidth = 1 / camera.scale;
    roundRectPath(ctx, lx - pad, ly - th / 2, tw + pad * 2, th, 3 / camera.scale);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e7e9ef';
    ctx.fillText(tip, lx, ly);
    ctx.restore();
  }

  ctx.restore();

  if (opts?.softMode) {
    ctx.save();
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const label = 'SOFT RUN';
    const padX = 8;
    const padY = 5;
    const tw = ctx.measureText(label).width;
    const x = 10;
    const y = 10;
    ctx.fillStyle = 'rgba(40, 28, 12, 0.82)';
    ctx.strokeStyle = '#e6a23c';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(x, y, tw + padX * 2, 12 + padY * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e6a23c';
    ctx.fillText(label, x + padX, y + padY);
    ctx.restore();
  }
}

/** Adaptive dot grid: keeps on-screen dot spacing in a readable range regardless of zoom. */
function drawGrid(ctx: CanvasRenderingContext2D, camera: Camera, viewportW: number, viewportH: number): void {
  let step = GRID;
  while (step * camera.scale < 18) step *= 2;

  const topLeft = camera.screenToWorld({ x: 0, y: 0 }, viewportW, viewportH);
  const bottomRight = camera.screenToWorld({ x: viewportW, y: viewportH }, viewportW, viewportH);
  const x0 = Math.floor(topLeft.x / step) * step;
  const x1 = Math.ceil(bottomRight.x / step) * step;
  const y0 = Math.floor(topLeft.y / step) * step;
  const y1 = Math.ceil(bottomRight.y / step) * step;

  ctx.fillStyle = COLOR.grid;
  const r = 1.3 / camera.scale;
  for (let x = x0; x <= x1; x += step) {
    for (let y = y0; y <= y1; y += step) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Draws a wire as a rounded orthogonal polyline (schematic-style). */
function drawWire(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  color: string,
  contended: boolean,
  emphasis: 'none' | 'hover' | 'selected' | 'net' = 'none',
): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const path = () => strokeRoundedPolyline(ctx, points, 7);
  if (emphasis !== 'none') {
    const glow =
      emphasis === 'selected' ? COLOR.selected : emphasis === 'net' ? '#5ec8ff' : COLOR.hover;
    ctx.globalAlpha = emphasis === 'selected' ? 0.45 : emphasis === 'net' ? 0.38 : 0.28;
    ctx.strokeStyle = glow;
    ctx.lineWidth = contended ? 13 : 10;
    path();
    ctx.stroke();
  }
  ctx.globalAlpha = 0.2;
  ctx.strokeStyle = color;
  ctx.lineWidth = contended ? 9 : 6;
  path();
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = contended ? 3 : 2.2;
  ctx.strokeStyle = color;
  path();
  ctx.stroke();
  ctx.restore();
}

function drawPinDot(ctx: CanvasRenderingContext2D, pin: Pin, resolve: LevelResolver): void {
  const { level, contended } = resolve(pin.id);
  const color = levelColor(level, contended);
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(pin.pos.x, pin.pos.y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(pin.pos.x, pin.pos.y, 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Human-readable pin label for schematic bodies (addr0 → A0, we → WE, …). */
export function formatPinLabel(name: string): string {
  const addr = /^addr(\d+)$/i.exec(name);
  if (addr) return `A${addr[1]}`;
  const data = /^data(\d+)$/i.exec(name);
  if (data) return `D${data[1]}`;
  const ch = /^ch(\d+)$/i.exec(name);
  if (ch) return `CH${ch[1]}`;
  const known: Record<string, string> = {
    we: 'WE',
    oe: 'OE',
    clk: 'CLK',
    gate: 'G',
    drain: 'D',
    source: 'S',
    out: 'OUT',
    in: 'IN',
    trig: 'TRIG',
    net: 'NET',
    io: 'IO',
  };
  const low = name.toLowerCase();
  if (known[low]) return known[low]!;
  // Folded ports often arrive as p0/p1 — keep short; otherwise show as authored.
  if (/^p\d+$/i.test(name)) return name.toUpperCase();
  return name.length <= 6 ? name.toUpperCase() : name;
}

/**
 * Chip / RAM / ROM body title — silkscreen-style, like a real IC package:
 * text always runs along the long axis of the body (vertical on tall
 * left/right-pin packages, horizontal on wide ones), centered on the die.
 */
function drawChipMarking(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  text: string,
): void {
  ctx.save();
  ctx.fillStyle = COLOR.text;
  ctx.font = '10px ui-monospace, "SF Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.translate(cx, cy);
  if (h > w) {
    // Tall package (DIP-like): read upward along the body.
    ctx.rotate(-Math.PI / 2);
  }
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/**
 * Pin name just inside the body beside the pin. Offset is axis-aligned
 * toward the body center (not along the pin→center ray) so tall left/right
 * stacks keep labels level with each pin instead of sliding onto the pad.
 */
function drawBodyPinLabel(
  ctx: CanvasRenderingContext2D,
  pin: Pin,
  cx: number,
  cy: number,
  labelText?: string,
  bodyW = CHIP_INSTANCE_WIDTH,
  bodyH?: number,
): void {
  const halfW = bodyW / 2;
  const halfH = bodyH != null ? bodyH / 2 : halfW;
  const distL = Math.abs(cx - halfW - pin.pos.x);
  const distR = Math.abs(cx + halfW - pin.pos.x);
  const distT = Math.abs(cy - halfH - pin.pos.y);
  const distB = Math.abs(cy + halfH - pin.pos.y);
  const minH = Math.min(distL, distR);
  const minV = Math.min(distT, distB);

  const inset = 10;
  let lx = pin.pos.x;
  let ly = pin.pos.y;
  let align: CanvasTextAlign = 'center';
  let baseline: CanvasTextBaseline = 'middle';

  if (minH <= minV) {
    // Left / right edge — label sits inward on the same row as the pin.
    if (distL <= distR) {
      lx = pin.pos.x + inset;
      align = 'left';
    } else {
      lx = pin.pos.x - inset;
      align = 'right';
    }
  } else {
    // Top / bottom edge — label sits inward on the same column.
    if (distT <= distB) {
      ly = pin.pos.y + inset;
      baseline = 'top';
    } else {
      ly = pin.pos.y - inset;
      baseline = 'bottom';
    }
  }

  ctx.save();
  ctx.font = '9px ui-monospace, "SF Mono", monospace';
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillStyle = COLOR.textDim;
  ctx.fillText(labelText ?? formatPinLabel(pin.name), lx, ly);
  ctx.restore();
}

/**
 * Classic enhancement-mode MOSFET in local coords (gate left, D/S vertical),
 * then oriented via rotation / flip H/V on the canvas transform.
 */
function drawMosfetSymbol(
  ctx: CanvasRenderingContext2D,
  c: Extract<Component, { kind: 'transistor' }>,
  color: string,
  selected: boolean,
  hovered: boolean,
): void {
  const { rotation, mirrorX, mirrorY } = getOrientation(c);
  const chanX = 2;
  const gatePlateX = -8;
  const gateX = -28;
  const topY = -28;
  const botY = 28;
  const midY = 0;
  const sourceY = c.type === 'P' ? -28 : 28;
  const drainY = c.type === 'P' ? 28 : -28;

  ctx.save();
  ctx.translate(c.pos.x, c.pos.y);
  if (mirrorX) ctx.scale(-1, 1);
  if (mirrorY) ctx.scale(1, -1);
  ctx.rotate((rotation * Math.PI) / 180);

  if (selected || hovered) {
    ctx.strokeStyle = selected ? COLOR.selected : COLOR.hover;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(gateX, midY);
    ctx.lineTo(gatePlateX, midY);
    ctx.moveTo(chanX, topY);
    ctx.lineTo(chanX, botY);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = selected || hovered ? 2 : 1.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  if (c.type === 'P') {
    const bx = (gateX + gatePlateX) / 2;
    ctx.moveTo(gateX, midY);
    ctx.lineTo(bx - 3.5, midY);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(bx, midY, 3.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx + 3.5, midY);
    ctx.lineTo(gatePlateX, midY);
  } else {
    ctx.moveTo(gateX, midY);
    ctx.lineTo(gatePlateX, midY);
  }
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(gatePlateX, midY - 10);
  ctx.lineTo(gatePlateX, midY + 10);
  ctx.moveTo(gatePlateX + 3.5, midY - 10);
  ctx.lineTo(gatePlateX + 3.5, midY + 10);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(chanX, topY);
  ctx.lineTo(chanX, botY);
  ctx.stroke();
  for (const dy of [-8, 0, 8]) {
    ctx.beginPath();
    ctx.moveTo(gatePlateX + 5.5, midY + dy);
    ctx.lineTo(chanX, midY + dy);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.moveTo(chanX, drainY);
  ctx.lineTo(0, drainY);
  ctx.moveTo(chanX, sourceY);
  ctx.lineTo(0, sourceY);
  ctx.stroke();

  const ay = sourceY > 0 ? midY + 12 : midY - 12;
  const ax = chanX;
  const s = 3.4;
  ctx.beginPath();
  if (c.type === 'N') {
    ctx.moveTo(ax - 6, ay - s);
    ctx.lineTo(ax - 6, ay + s);
    ctx.lineTo(ax - 1, ay);
  } else {
    ctx.moveTo(ax - 1, ay - s);
    ctx.lineTo(ax - 1, ay + s);
    ctx.lineTo(ax - 6, ay);
  }
  ctx.closePath();
  ctx.fill();

  ctx.font = '9px ui-monospace, "SF Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.fillText(c.type === 'N' ? 'n' : 'p', chanX + 5, midY);
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** Draw a polyline with rounded corners (schematic-style curves). */
function strokeRoundedPolyline(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  cornerR = 8,
): void {
  if (points.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(points[0]!.x, points[0]!.y);
  if (points.length === 1) return;
  if (points.length === 2) {
    ctx.lineTo(points[1]!.x, points[1]!.y);
    return;
  }
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    const d1x = cur.x - prev.x;
    const d1y = cur.y - prev.y;
    const d2x = next.x - cur.x;
    const d2y = next.y - cur.y;
    const len1 = Math.hypot(d1x, d1y) || 1;
    const len2 = Math.hypot(d2x, d2y) || 1;
    const r = Math.min(cornerR, len1 / 2, len2 / 2);
    const p1 = { x: cur.x - (d1x / len1) * r, y: cur.y - (d1y / len1) * r };
    const p2 = { x: cur.x + (d2x / len2) * r, y: cur.y + (d2y / len2) * r };
    ctx.lineTo(p1.x, p1.y);
    ctx.quadraticCurveTo(cur.x, cur.y, p2.x, p2.y);
  }
  const last = points[points.length - 1]!;
  ctx.lineTo(last.x, last.y);
}

function drawComponent(
  ctx: CanvasRenderingContext2D,
  c: Component,
  resolve: LevelResolver,
  selected: boolean,
  hovered: boolean,
  library: ChipLibrary,
): void {
  ctx.font = '10px ui-monospace, "SF Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const ringColor = selected ? COLOR.selected : hovered ? COLOR.hover : null;
  const bodyStroke = (defaultColor: string) => (selected ? COLOR.selected : hovered ? COLOR.hover : defaultColor);

  const stub = (fromX: number, fromY: number, pin: Pin) => {
    ctx.strokeStyle = COLOR.bodyStroke;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(pin.pos.x, pin.pos.y);
    ctx.stroke();
  };

  /** Stub from body bbox edge toward the pin (orientation-aware). */
  const stubPin = (cx: number, cy: number, hw: number, hh: number, pin: Pin) => {
    const edge = bodyEdgeToward(cx, cy, hw, hh, pin.pos);
    stub(edge.x, edge.y, pin);
  };

  switch (c.kind) {
    case 'transistor': {
      const stroke = c.type === 'N' ? COLOR.strokeN : COLOR.strokeP;
      drawMosfetSymbol(ctx, c, bodyStroke(stroke), selected, hovered);
      drawPinDot(ctx, c.pins.gate, resolve);
      drawPinDot(ctx, c.pins.drain, resolve);
      drawPinDot(ctx, c.pins.source, resolve);
      break;
    }
    case 'source': {
      const { x, y } = c.pos;
      const isVcc = c.value === 1;
      const stroke = isVcc ? COLOR.wireHigh : COLOR.wireLow;
      const { rotation, mirrorX, mirrorY } = getOrientation(c);
      if (ringColor) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      // Draw the whole rail symbol in local space so rotate / flip moves
      // the bar + stem together (not just the pin stub).
      ctx.save();
      ctx.translate(x, y);
      if (mirrorX) ctx.scale(-1, 1);
      if (mirrorY) ctx.scale(1, -1);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.strokeStyle = bodyStroke(stroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (isVcc) {
        // Classic VCC: pin at +Y, stem up into a horizontal rail bar.
        ctx.beginPath();
        ctx.moveTo(0, 15);
        ctx.lineTo(0, 2);
        ctx.lineTo(0, -6);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-10, -6);
        ctx.lineTo(10, -6);
        ctx.stroke();
      } else {
        // Earth symbol: pin below, three bars above it.
        ctx.beginPath();
        ctx.moveTo(0, 15);
        ctx.lineTo(0, 6);
        ctx.stroke();
        for (let i = 0; i < 3; i++) {
          const half = 11 - i * 3.5;
          const yy = 6 - i * 4;
          ctx.beginPath();
          ctx.moveTo(-half, yy);
          ctx.lineTo(half, yy);
          ctx.stroke();
        }
      }
      ctx.restore();
      // Keep the name upright; place it opposite the pin.
      const labelOff = transformOffset(0, isVcc ? -12 : -11, rotation, mirrorX, mirrorY);
      ctx.fillStyle = COLOR.text;
      ctx.font = '9px ui-monospace, "SF Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(isVcc ? 'VCC' : 'GND', x + labelOff.x, y + labelOff.y);
      drawPinDot(ctx, c.pins.out, resolve);
      break;
    }
    case 'input': {
      const { x, y } = c.pos;
      const w = 24;
      const h = 20;
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 6, ringColor);
      ctx.fillStyle = c.value === 1 ? '#3d2f14' : '#182233';
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 6);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(c.value === 1 ? COLOR.wireHigh : COLOR.wireLow);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      stubPin(x, y, w / 2, h / 2, c.pins.out);
      drawPinDot(ctx, c.pins.out, resolve);
      ctx.fillStyle = COLOR.text;
      ctx.fillText(String(c.value), x, y);
      break;
    }
    case 'button': {
      const { x, y } = c.pos;
      const on = c.value === 1;
      const toggle = c.mode === 'toggle';
      // Chassis plate
      const pw = 34;
      const ph = 30;
      if (ringColor) glowRect(ctx, x - pw / 2, y - ph / 2, pw, ph, 6, ringColor);
      ctx.fillStyle = '#151820';
      roundRectPath(ctx, x - pw / 2, y - ph / 2, pw, ph, 5);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.2;
      ctx.stroke();
      // Raised / pressed circular actuator
      const r = on ? 8.5 : 10;
      const cyBtn = on ? y - 1 : y - 3;
      ctx.beginPath();
      ctx.arc(x, cyBtn + 1.5, r + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fill();
      const grad = ctx.createRadialGradient(x - 2, cyBtn - 2, 1, x, cyBtn, r);
      if (on) {
        grad.addColorStop(0, '#f0c040');
        grad.addColorStop(1, '#a87818');
      } else {
        grad.addColorStop(0, '#5a6578');
        grad.addColorStop(1, '#2a3140');
      }
      ctx.beginPath();
      ctx.arc(x, cyBtn, r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = bodyStroke(on ? COLOR.selected : '#8a93a8');
      ctx.lineWidth = 1.3;
      ctx.stroke();
      // Mode caption under the bezel
      ctx.font = '7px ui-monospace, "SF Mono", monospace';
      ctx.fillStyle = COLOR.textDim;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(toggle ? 'TOG' : 'MOM', x, y + 11);
      stubPin(x, y, pw / 2, ph / 2, c.pins.out);
      drawPinDot(ctx, c.pins.out, resolve);
      break;
    }
    case 'clock': {
      const { x, y } = c.pos;
      const w = 44;
      const h = 32;
      const active = c.mode === 'oneshot' ? c.holdFrames > 0 : c.running;
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 6, ringColor);
      ctx.fillStyle = active ? '#1e2a38' : COLOR.body;
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 6);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(c.value === 1 ? COLOR.wireHigh : COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      stubPin(x, y, w / 2, h / 2, c.pins.out);
      stubPin(x, y, w / 2, h / 2, c.pins.trig);
      drawPinDot(ctx, c.pins.out, resolve);
      drawPinDot(ctx, c.pins.trig, resolve);
      ctx.save();
      ctx.font = '8px ui-monospace, "SF Mono", monospace';
      ctx.fillStyle = COLOR.textDim;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('OUT', c.pins.out.pos.x + 6, c.pins.out.pos.y);
      ctx.textAlign = 'right';
      ctx.fillText('TRIG', c.pins.trig.pos.x - 6, c.pins.trig.pos.y);
      ctx.restore();
      ctx.fillStyle = COLOR.selected;
      ctx.textAlign = 'center';
      ctx.fillText(c.mode === 'oneshot' ? 'PULSE' : active ? 'CLK▶' : 'CLK', x, y - 5);
      ctx.fillStyle = COLOR.textDim;
      ctx.fillText(c.mode === 'oneshot' ? `${c.dutyFrames}f` : `${c.periodFrames}f`, x, y + 9);
      break;
    }
    case 'analyzer': {
      const { x, y } = c.pos;
      const n = c.channelCount;
      const h = Math.max(36, n * 16 + 12);
      const w = 64;
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 6, ringColor);
      ctx.fillStyle = c.armed ? '#1a2430' : COLOR.body;
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 6);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(c.armed ? COLOR.selected : COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      for (let i = 0; i < n; i++) {
        const p = c.pins[`ch${i}`];
        if (!p) continue;
        stubPin(x, y, w / 2, h / 2, p);
        drawPinDot(ctx, p, resolve);
        drawBodyPinLabel(ctx, p, x, y, undefined, w, h);
      }
      ctx.fillStyle = COLOR.selected;
      ctx.font = '10px ui-monospace, "SF Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('LA', x + 14, y - 8);
      ctx.fillStyle = c.armed ? COLOR.wireHigh : COLOR.textDim;
      ctx.fillText(c.armed ? 'REC' : `${n}ch`, x + 14, y + 8);
      break;
    }
    case 'tty': {
      const { x, y } = c.pos;
      const w = 64;
      const h = 36;
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 6, ringColor);
      ctx.fillStyle = '#152018';
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 6);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      ctx.fillStyle = COLOR.selected;
      ctx.fillText('TTY', x, y - 4);
      ctx.fillStyle = COLOR.textDim;
      ctx.fillText(c.ramId ? 'linked' : '—', x, y + 10);
      break;
    }
    case 'led': {
      const { x, y } = c.pos;
      const { level, contended } = resolve(c.pins.in.id);
      const on = level === 1 && !contended;
      if (ringColor) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      if (on) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = c.color;
        ctx.beginPath();
        ctx.arc(x, y, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = on ? c.color : '#1a1c22';
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(on ? c.color : COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      stubPin(x, y, 11, 11, c.pins.in);
      drawPinDot(ctx, c.pins.in, resolve);
      if (c.label) {
        ctx.fillStyle = COLOR.textDim;
        ctx.fillText(c.label, x, y - 20);
      }
      break;
    }
    case 'probe': {
      const { x, y } = c.pos;
      const { level, contended } = resolve(c.pins.in.id);
      if (ringColor) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.fillStyle = COLOR.body;
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      stubPin(x, y, 10, 10, c.pins.in);
      drawPinDot(ctx, c.pins.in, resolve);
      ctx.fillStyle = levelColor(level, contended);
      ctx.fillText(level === 'Z' ? '?' : String(level), x, y);
      if (c.label) {
        ctx.fillStyle = COLOR.textDim;
        ctx.fillText(c.label, x, y - 18);
      }
      break;
    }
    case 'label': {
      const { x, y } = c.pos;
      drawPinDot(ctx, c.pins.net, resolve);
      ctx.fillStyle = selected || hovered ? COLOR.selected : COLOR.textDim;
      ctx.fillText(c.name, x, y - 12);
      break;
    }
    case 'port': {
      const { x, y } = c.pos;
      const s = 8;
      ctx.fillStyle = COLOR.body;
      ctx.beginPath();
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x, y + s);
      ctx.lineTo(x - s, y);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = bodyStroke(COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      // Direction chevron: in ←, out →, inout both (diamond alone).
      const dir = c.dir ?? 'inout';
      if (dir === 'in' || dir === 'out') {
        ctx.beginPath();
        if (dir === 'in') {
          ctx.moveTo(x + 14, y - 4);
          ctx.lineTo(x + 8, y);
          ctx.lineTo(x + 14, y + 4);
        } else {
          ctx.moveTo(x - 14, y - 4);
          ctx.lineTo(x - 8, y);
          ctx.lineTo(x - 14, y + 4);
        }
        ctx.strokeStyle = selected || hovered ? COLOR.selected : COLOR.textDim;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      drawPinDot(ctx, c.pins.io, resolve);
      ctx.fillStyle = selected || hovered ? COLOR.selected : COLOR.textDim;
      const tag = dir === 'in' ? 'IN ' : dir === 'out' ? 'OUT ' : '';
      ctx.fillText(`${tag}${c.name}`, x, y - 16);
      break;
    }
    case 'chip': {
      const { x, y } = c.pos;
      const w = chipBodyWidth(c);
      const h = chipBoxHeight(c);
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 8, ringColor);
      const grad = ctx.createLinearGradient(x - w / 2, y - h / 2, x + w / 2, y + h / 2);
      grad.addColorStop(0, COLOR.chipBody);
      grad.addColorStop(1, '#2c335c');
      ctx.fillStyle = grad;
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 8);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      for (const p of Object.values(c.pins) as Pin[]) {
        stubPin(x, y, w / 2, h / 2, p);
        drawPinDot(ctx, p, resolve);
        let label: string | undefined;
        if (library.has(c.defId)) {
          for (const ic of library.get(c.defId).circuit.components.values()) {
            if (ic.kind === 'port' && ic.name === p.name) {
              const dir = ic.dir ?? 'inout';
              if (dir === 'in') label = `›${formatPinLabel(p.name)}`;
              else if (dir === 'out') label = `${formatPinLabel(p.name)}›`;
              break;
            }
          }
        }
        drawBodyPinLabel(ctx, p, x, y, label, w, h);
      }
      ctx.fillStyle = COLOR.text;
      const name =
        c.marking?.trim() || (library.has(c.defId) ? library.get(c.defId).name : '?');
      drawChipMarking(ctx, x, y, w, h, name);
      // Shared ChipDef was edited after this instance was placed / last dived.
      if (library.has(c.defId)) {
        const rev = library.get(c.defId).revision ?? 0;
        if (rev !== (c.defRevision ?? 0)) {
          ctx.fillStyle = COLOR.selected;
          ctx.beginPath();
          ctx.arc(x + w / 2 - 8, y - h / 2 + 8, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
    case 'ram': {
      const { x, y } = c.pos;
      const w = CHIP_INSTANCE_WIDTH;
      const h = chipInstanceHeight(ramPortCount(c));
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 8, ringColor);
      const grad = ctx.createLinearGradient(x - w / 2, y - h / 2, x + w / 2, y + h / 2);
      grad.addColorStop(0, COLOR.ramBody);
      grad.addColorStop(1, '#1c2e1f');
      ctx.fillStyle = grad;
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 8);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      for (const p of Object.values(c.pins) as Pin[]) {
        stubPin(x, y, w / 2, h / 2, p);
        drawPinDot(ctx, p, resolve);
        drawBodyPinLabel(ctx, p, x, y, undefined, w, h);
      }
      drawChipMarking(ctx, x, y, w, h, `RAM ${1 << c.addrBits}×${c.dataBits}`);
      break;
    }
    case 'rom': {
      const { x, y } = c.pos;
      const w = CHIP_INSTANCE_WIDTH;
      const h = chipInstanceHeight(romPortCount(c));
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 8, ringColor);
      const grad = ctx.createLinearGradient(x - w / 2, y - h / 2, x + w / 2, y + h / 2);
      grad.addColorStop(0, '#2a2438');
      grad.addColorStop(1, '#1c1830');
      ctx.fillStyle = grad;
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 8);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      for (const p of Object.values(c.pins) as Pin[]) {
        stubPin(x, y, w / 2, h / 2, p);
        drawPinDot(ctx, p, resolve);
        drawBodyPinLabel(ctx, p, x, y, undefined, w, h);
      }
      drawChipMarking(ctx, x, y, w, h, `ROM ${1 << c.addrBits}×${c.dataBits}`);
      break;
    }
  }
}
