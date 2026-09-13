import { describe, expect, it } from 'vitest';
import { Camera } from '../src/ui/Camera.js';

describe('Camera coordinate transforms', () => {
  it('screenToWorld is the inverse of worldToScreen at any pan/zoom', () => {
    const cam = new Camera();
    cam.x = 123;
    cam.y = -45;
    cam.scale = 1.7;
    const world = { x: 200, y: 300 };
    const screen = cam.worldToScreen(world, 800, 600);
    const back = cam.screenToWorld(screen, 800, 600);
    expect(back.x).toBeCloseTo(world.x);
    expect(back.y).toBeCloseTo(world.y);
  });

  it('the viewport center always maps to the camera position', () => {
    const cam = new Camera();
    cam.x = 50;
    cam.y = 80;
    cam.scale = 2;
    const world = cam.screenToWorld({ x: 400, y: 300 }, 800, 600);
    expect(world.x).toBeCloseTo(50);
    expect(world.y).toBeCloseTo(80);
  });
});

describe('Camera.zoomAt', () => {
  it('keeps the world point under the cursor fixed on screen', () => {
    const cam = new Camera();
    cam.x = 10;
    cam.y = 10;
    cam.scale = 1;
    const cursor = { x: 300, y: 150 };
    const worldUnderCursorBefore = cam.screenToWorld(cursor, 800, 600);

    cam.zoomAt(cursor, 1.5, 800, 600);
    cam.zoomAt(cursor, 1.5, 800, 600); // zoom in twice more, still anchored

    const worldUnderCursorAfter = cam.screenToWorld(cursor, 800, 600);
    expect(worldUnderCursorAfter.x).toBeCloseTo(worldUnderCursorBefore.x);
    expect(worldUnderCursorAfter.y).toBeCloseTo(worldUnderCursorBefore.y);
    expect(cam.scale).toBeCloseTo(2.25);
  });

  it('clamps to [minScale, maxScale]', () => {
    const cam = new Camera();
    for (let i = 0; i < 50; i++) cam.zoomAt({ x: 0, y: 0 }, 2, 800, 600);
    expect(cam.scale).toBeLessThanOrEqual(cam.maxScale);
    for (let i = 0; i < 50; i++) cam.zoomAt({ x: 0, y: 0 }, 0.5, 800, 600);
    expect(cam.scale).toBeGreaterThanOrEqual(cam.minScale);
  });
});

describe('Camera.fit', () => {
  it('centers on the bounds midpoint and shrinks to fit a large box in a small viewport', () => {
    const cam = new Camera();
    cam.fit({ minX: 0, minY: 0, maxX: 1000, maxY: 500 }, 400, 300, 20);
    expect(cam.x).toBeCloseTo(500);
    expect(cam.y).toBeCloseTo(250);
    expect(cam.scale).toBeLessThan(1);
  });
});
