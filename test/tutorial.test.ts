import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import { makeButton, makeLed } from '../src/sim/library.js';
import { Tutorial } from '../src/ui/Tutorial.js';

function installMinimalDom(): void {
  if (typeof document !== 'undefined') return;
  const doc = {
    head: { appendChild() {} },
    body: { appendChild() {} },
    createElement(tag: string) {
      const el: Record<string, unknown> = {
        tagName: tag.toUpperCase(),
        style: {},
        classList: { add() {}, toggle() {} },
        appendChild(child: unknown) {
          return child;
        },
        append(..._args: unknown[]) {},
        addEventListener() {},
        set textContent(v: string) {
          el._text = v;
        },
        get textContent() {
          return (el._text as string) ?? '';
        },
        set hidden(_v: boolean) {},
        get hidden() {
          return false;
        },
        set className(_v: string) {},
        set type(_v: string) {},
      };
      return el;
    },
  };
  (globalThis as unknown as { document: typeof doc }).document = doc;
}

installMinimalDom();

describe('Tutorial auto-advance', () => {
  it('ignores buttons/LEDs that already existed when start() ran', () => {
    const host = document.createElement('div') as unknown as HTMLElement;
    const circuit = new Circuit();
    makeButton(circuit, { x: 0, y: 0 });
    makeLed(circuit, { x: 40, y: 0 });

    const tutorial = new Tutorial(host);
    tutorial.start(circuit);
    expect(tutorial.active).toBe(true);
    expect(tutorial.hint).toBe('place-button');

    tutorial.tick(circuit);
    expect(tutorial.hint).toBe('place-button');

    makeButton(circuit, { x: 80, y: 0 });
    tutorial.tick(circuit);
    expect(tutorial.hint).toBe('place-led');
  });

  it('stop() clears active state so a fresh start() works', () => {
    const host = document.createElement('div') as unknown as HTMLElement;
    const circuit = new Circuit();
    const tutorial = new Tutorial(host);
    tutorial.start(circuit);
    makeButton(circuit, { x: 0, y: 0 });
    tutorial.tick(circuit);
    tutorial.stop();
    expect(tutorial.active).toBe(false);
    tutorial.start(circuit);
    expect(tutorial.active).toBe(true);
    expect(tutorial.hint).toBe('place-button');
  });
});
