import type { Point } from '../sim/types.js';

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * A 2D pan/zoom camera: `x, y` is the world-space point currently centered
 * in the viewport, `scale` is world-to-screen zoom. All editor interaction
 * (hit-testing, wiring, placement — see geometry.ts and Editor.ts) happens
 * in *world* space and knows nothing about the camera; main.ts is the only
 * place that converts between the two, right where mouse events come in
 * and right where the Renderer draws.
 */
export class Camera {
  x = 0;
  y = 0;
  scale = 1;
  readonly minScale = 0.2;
  readonly maxScale = 4;

  worldToScreen(p: Point, viewportW: number, viewportH: number): Point {
    return {
      x: (p.x - this.x) * this.scale + viewportW / 2,
      y: (p.y - this.y) * this.scale + viewportH / 2,
    };
  }

  screenToWorld(p: Point, viewportW: number, viewportH: number): Point {
    return {
      x: (p.x - viewportW / 2) / this.scale + this.x,
      y: (p.y - viewportH / 2) / this.scale + this.y,
    };
  }

  /** Pan by a screen-space delta (e.g. mouse movement while dragging). */
  pan(dxScreen: number, dyScreen: number): void {
    this.x -= dxScreen / this.scale;
    this.y -= dyScreen / this.scale;
  }

  /** Zoom by `factor`, keeping the world point under `screenPoint` fixed on screen. */
  zoomAt(screenPoint: Point, factor: number, viewportW: number, viewportH: number): void {
    const before = this.screenToWorld(screenPoint, viewportW, viewportH);
    this.scale = clamp(this.scale * factor, this.minScale, this.maxScale);
    const after = this.screenToWorld(screenPoint, viewportW, viewportH);
    this.x -= after.x - before.x;
    this.y -= after.y - before.y;
  }

  /** Center on a point at a fixed scale — "auto-centered at 100%" style navigation (dive in/out). */
  centerOn(p: Point, scale = 1): void {
    this.x = p.x;
    this.y = p.y;
    this.scale = clamp(scale, this.minScale, this.maxScale);
  }

  /** Frame `bounds` entirely in the viewport, with `padding` screen px of margin. */
  fit(bounds: Bounds, viewportW: number, viewportH: number, padding = 60): void {
    const w = Math.max(bounds.maxX - bounds.minX, 1);
    const h = Math.max(bounds.maxY - bounds.minY, 1);
    const fitScale = Math.min((viewportW - padding * 2) / w, (viewportH - padding * 2) / h);
    this.scale = clamp(fitScale, this.minScale, this.maxScale);
    this.x = (bounds.minX + bounds.maxX) / 2;
    this.y = (bounds.minY + bounds.maxY) / 2;
  }
}
