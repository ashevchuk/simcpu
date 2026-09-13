import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { makeChipInstance, makeLabel, makeRam, makeSource, makeTransistor } from '../src/sim/library.js';
import { seedStandardCells } from '../src/sim/stdcells.js';
import { boundsOverlap, componentRadius, isComponentVisible, isWireVisible, type WorldBounds } from '../src/ui/Renderer.js';

describe('Renderer viewport culling', () => {
  /**
   * `draw()` used to render every component in the circuit unconditionally
   * — fine for a handful of gates, a real problem once `+ Z80CPU` put
   * thousands of them directly at the top level (see ARCHITECTURE.md's
   * "Canvas 2D rendering cost, closed out"). These are the pure geometry
   * functions culling is built on, tested without ever touching a Canvas
   * context — `boundsOverlap` is plain interval-overlap math on two boxes,
   * `componentRadius`/`isComponentVisible`/`isWireVisible` just turn a
   * component or wire into one such box.
   */
  const VIEWPORT: WorldBounds = { minX: -100, minY: -100, maxX: 100, maxY: 100 };

  describe('boundsOverlap', () => {
    it('is true for identical boxes', () => {
      expect(boundsOverlap(VIEWPORT, VIEWPORT)).toBe(true);
    });
    it('is true when one box merely touches the edge of the other', () => {
      expect(boundsOverlap(VIEWPORT, { minX: 100, minY: -50, maxX: 200, maxY: 50 })).toBe(true);
    });
    it('is false once boxes are fully separated on one axis', () => {
      expect(boundsOverlap(VIEWPORT, { minX: 101, minY: -50, maxX: 200, maxY: 50 })).toBe(false);
    });
    it('is false when separated on the Y axis even if X ranges overlap', () => {
      expect(boundsOverlap(VIEWPORT, { minX: -50, minY: 101, maxX: 50, maxY: 200 })).toBe(false);
    });
  });

  describe('isComponentVisible', () => {
    it('a transistor sitting inside the viewport is visible', () => {
      const c = new Circuit();
      const t = makeTransistor(c, 'N', { x: 0, y: 0 });
      expect(isComponentVisible(t, VIEWPORT)).toBe(true);
    });

    it('a transistor far outside the viewport is culled', () => {
      const c = new Circuit();
      const t = makeTransistor(c, 'N', { x: 100_000, y: 100_000 });
      expect(isComponentVisible(t, VIEWPORT)).toBe(false);
    });

    it("a component just past the viewport edge is still visible within its own kind's radius", () => {
      const c = new Circuit();
      const probe = makeSource(c, 1, { x: 0, y: 0 }); // just to read componentRadius('source') honestly, not hand-copy its constant
      const { rx } = componentRadius(probe);
      const source = makeSource(c, 1, { x: 100 + rx - 1, y: 0 });
      expect(isComponentVisible(source, VIEWPORT)).toBe(true);
    });

    it('a label carries enough radius to cover its name text drawn above the dot', () => {
      const c = new Circuit();
      const label = makeLabel(c, 'CLK', { x: 100 + 30, y: 0 }); // inside a label's rx=50, outside a bare point check
      expect(isComponentVisible(label, VIEWPORT)).toBe(true);
    });

    it('a chip instance close to the viewport uses its own real width/height, not a generic radius', () => {
      const library = new ChipLibrary();
      seedStandardCells(library);
      const c = new Circuit();
      const def = library.get([...library.list()].find((d) => d.name === 'AND')!.id);
      const inst = makeChipInstance(c, def, { x: 90, y: 0 });
      expect(isComponentVisible(inst, VIEWPORT)).toBe(true);
    });

    it('a RAM instance sizes its radius off its own real port count', () => {
      const c = new Circuit();
      const ram = makeRam(c, 4, 8, undefined, { x: 90, y: 0 });
      expect(isComponentVisible(ram, VIEWPORT)).toBe(true);
      const farRam = makeRam(c, 4, 8, undefined, { x: 100_000, y: 0 });
      expect(isComponentVisible(farRam, VIEWPORT)).toBe(false);
    });
  });

  describe('isWireVisible', () => {
    it('a wire entirely inside the viewport is visible', () => {
      expect(isWireVisible([{ x: -50, y: 0 }, { x: 50, y: 0 }], VIEWPORT)).toBe(true);
    });
    it('a wire entirely outside the viewport is culled', () => {
      expect(
        isWireVisible(
          [
            { x: 1000, y: 1000 },
            { x: 2000, y: 2000 },
          ],
          VIEWPORT,
        ),
      ).toBe(false);
    });
    it('a wire that merely crosses into the viewport through a bend point stays visible', () => {
      expect(
        isWireVisible(
          [
            { x: -1000, y: 0 },
            { x: 0, y: 0 }, // bend point lands inside the viewport
            { x: -1000, y: 50 },
          ],
          VIEWPORT,
        ),
      ).toBe(true);
    });
  });
});
