import type { ChipLibrary } from '../sim/ChipLibrary.js';
import type { Circuit } from '../sim/Circuit.js';
import { CHIP_INSTANCE_WIDTH, chipInstanceHeight, ramPortCount } from '../sim/library.js';
import type { Component, Level, Pin } from '../sim/types.js';
import type { Camera } from './Camera.js';
import type { Editor } from './Editor.js';
import { GRID } from './geometry.js';

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
    case 'source':
      return { rx: 26, ry: 26 };
    case 'input':
      return { rx: 22, ry: 20 };
    case 'probe':
      return { rx: 24, ry: 34 };
    case 'label':
      return { rx: 50, ry: 24 };
    case 'port':
      return { rx: 40, ry: 28 };
    case 'chip':
      return { rx: CHIP_INSTANCE_WIDTH / 2 + 20, ry: chipInstanceHeight(Object.keys(c.pins).length) / 2 + 20 };
    case 'ram':
      return { rx: CHIP_INSTANCE_WIDTH / 2 + 20, ry: chipInstanceHeight(ramPortCount(c)) / 2 + 20 };
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
): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, viewportW, viewportH);

  ctx.save();
  ctx.translate(viewportW / 2, viewportH / 2);
  ctx.scale(camera.scale, camera.scale);
  ctx.translate(-camera.x, -camera.y);

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

  // Wires first, so component bodies sit on top of the lines meeting them.
  for (const w of circuit.wires.values()) {
    const a = pinById.get(w.a);
    const b = pinById.get(w.b);
    if (!a || !b) continue;
    const points = w.waypoints && w.waypoints.length ? [a.pos, ...w.waypoints, b.pos] : [a.pos, b.pos];
    if (!isWireVisible(points, visible)) continue;
    const { level, contended } = resolve(w.a);
    const emphasis =
      w.id === editor.selectedWireId ? 'selected' : editor.tool.kind === 'select' && w.id === editor.hoveredWireId ? 'hover' : 'none';
    drawWire(ctx, points, levelColor(level, contended), contended, emphasis);
  }

  // Rubber-band while a wire is in progress: the start pin, every bend
  // point committed so far, then a dashed segment out to the cursor.
  if (editor.tool.kind === 'wire' && editor.wireStartPinId) {
    const start = pinById.get(editor.wireStartPinId);
    if (start) {
      const points = [start.pos, ...editor.wireWaypoints, editor.mouse];
      ctx.save();
      ctx.strokeStyle = COLOR.hover;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(points[0]!.x, points[0]!.y);
      for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
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

  // Hovered pin, while the wire tool is actually usable (placing or completing a wire).
  if (editor.tool.kind === 'wire' && editor.hoveredPinId) {
    const p = pinById.get(editor.hoveredPinId);
    if (p) {
      ctx.save();
      ctx.strokeStyle = COLOR.hover;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.pos.x, p.pos.y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Draggable bend-point handles, only for the wire that's selected or (in
  // select tool) currently hovered — showing them on every wire at once
  // would just be noise.
  for (const w of circuit.wires.values()) {
    if (!w.waypoints || w.waypoints.length === 0) continue;
    const isSelected = w.id === editor.selectedWireId;
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

  ctx.restore();
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

/** Draws a wire as one continuous polyline through `points` (pin -> bend points, if any -> pin), not just a two-point line. */
function drawWire(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  color: string,
  contended: boolean,
  emphasis: 'none' | 'hover' | 'selected' = 'none',
): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
  };
  // Selection/hover halo, under everything else — same idea as a component's glow ring.
  if (emphasis !== 'none') {
    ctx.globalAlpha = emphasis === 'selected' ? 0.45 : 0.28;
    ctx.strokeStyle = emphasis === 'selected' ? COLOR.selected : COLOR.hover;
    ctx.lineWidth = contended ? 13 : 10;
    path();
    ctx.stroke();
  }
  // Soft glow underlay.
  ctx.globalAlpha = 0.2;
  ctx.strokeStyle = color;
  ctx.lineWidth = contended ? 9 : 6;
  path();
  ctx.stroke();
  // Crisp core line.
  ctx.globalAlpha = 1;
  ctx.lineWidth = contended ? 3 : 2.2;
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

/**
 * Minimal schematic MOSFET glyph: an insulated gate plate (short, offset,
 * never touching the channel — that gap *is* the symbol) beside the
 * drain-source channel line, plus a small arrow standing in for the
 * type — pointing into the channel for N (carriers flow in), out of it for
 * P — so the letter in the body is a label, not the only way to tell N
 * from P apart.
 */
function drawTransistorGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, type: 'N' | 'P', color: string, halfLen: number): void {
  const gateX = x - 4;
  const chanX = x + 1;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(gateX, y - 5);
  ctx.lineTo(gateX, y + 5);
  ctx.moveTo(chanX, y - halfLen);
  ctx.lineTo(chanX, y + halfLen);
  ctx.stroke();

  // Arrow in the gate/channel gap, pointing the way carriers flow.
  const dir = type === 'N' ? 1 : -1;
  const ax = x - 1.5;
  const s = 2.6;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(ax - dir * s, y - s);
  ctx.lineTo(ax - dir * s, y + s);
  ctx.lineTo(ax + dir * s, y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
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

  switch (c.kind) {
    case 'transistor': {
      const { x, y } = c.pos;
      const w = 20;
      const h = 24;
      const stroke = c.type === 'N' ? COLOR.strokeN : COLOR.strokeP;
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 5, ringColor);
      ctx.fillStyle = COLOR.body;
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 5);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(stroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();

      stub(x - w / 2, y, c.pins.gate);
      stub(x, y - h / 2, c.pins.drain);
      stub(x, y + h / 2, c.pins.source);
      drawTransistorGlyph(ctx, x, y, c.type, stroke, h / 2 - 2);
      drawPinDot(ctx, c.pins.gate, resolve);
      drawPinDot(ctx, c.pins.drain, resolve);
      drawPinDot(ctx, c.pins.source, resolve);

      // Pin labels, offset perpendicular to each stub so they clear both the
      // line and the pin dot rather than sitting on top of either.
      ctx.font = '8px ui-monospace, "SF Mono", monospace';
      ctx.fillStyle = COLOR.textDim;
      ctx.textAlign = 'center';
      ctx.fillText('G', c.pins.gate.pos.x, c.pins.gate.pos.y - 8);
      ctx.textAlign = 'left';
      ctx.fillText('D', c.pins.drain.pos.x + 5, c.pins.drain.pos.y);
      ctx.fillText('S', c.pins.source.pos.x + 5, c.pins.source.pos.y);

      // N/P tag stays as a small corner badge — the glyph's arrow already
      // carries the type visually, this is just a legible fallback.
      ctx.textAlign = 'center';
      ctx.fillText(c.type, x + w / 2 - 5, y + h / 2 - 6);
      break;
    }
    case 'source': {
      const { x, y } = c.pos;
      const w = 32;
      const h = 16;
      const stroke = c.value === 1 ? COLOR.wireHigh : COLOR.wireLow;
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 6, ringColor);
      ctx.fillStyle = COLOR.body;
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 6);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(stroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      stub(x, y + h / 2, c.pins.out);
      drawPinDot(ctx, c.pins.out, resolve);
      ctx.fillStyle = COLOR.text;
      ctx.fillText(c.value === 1 ? 'VCC' : 'GND', x, y);
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
      stub(x + w / 2, y, c.pins.out);
      drawPinDot(ctx, c.pins.out, resolve);
      ctx.fillStyle = COLOR.text;
      ctx.fillText(String(c.value), x, y);
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
      stub(x - 10, y, c.pins.in);
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
      drawPinDot(ctx, c.pins.io, resolve);
      ctx.fillStyle = selected || hovered ? COLOR.selected : COLOR.textDim;
      ctx.fillText(c.name, x, y - 16);
      break;
    }
    case 'chip': {
      const { x, y } = c.pos;
      const w = CHIP_INSTANCE_WIDTH;
      const h = chipInstanceHeight(Object.keys(c.pins).length);
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
        stub(x - w / 2, p.pos.y, p);
        drawPinDot(ctx, p, resolve);
      }
      ctx.fillStyle = COLOR.text;
      const name = library.has(c.defId) ? library.get(c.defId).name : '?';
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(name, 0, 0);
      ctx.restore();
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
        stub(x - w / 2, p.pos.y, p);
        drawPinDot(ctx, p, resolve);
      }
      ctx.fillStyle = COLOR.text;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`RAM ${1 << c.addrBits}x${c.dataBits}`, 0, 0);
      ctx.restore();
      break;
    }
  }
}
