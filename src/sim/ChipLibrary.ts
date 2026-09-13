import { bumpStructureVersion } from './Circuit.js';
import type { Circuit } from './Circuit.js';

/**
 * A reusable chip: an internal netlist plus an ordered list of port names.
 * `circuit` is *shared* by every placed instance (see ChipInstanceComponent
 * in types.ts) — editing it edits every instance at once, exactly like the
 * reference project's "double-click to dive in, press E to edit its
 * internals" behavior, where a chip is a definition, not a copy.
 */
export interface ChipDef {
  id: string;
  name: string;
  ports: string[]; // order matches the pin order on every placed instance
  circuit: Circuit;
}

/** Flat store of every chip definition the user has folded so far. */
export class ChipLibrary {
  private defs = new Map<string, ChipDef>();

  register(def: ChipDef): void {
    this.defs.set(def.id, def);
    // Any chip instance referencing this id expands to `def.circuit`'s own
    // guts during flatten() — registering (or re-registering) a def changes
    // that expansion for every such instance, wherever it lives, so this
    // must invalidate flatten()'s own cache exactly like a direct edit to a
    // Circuit would (see Circuit.ts's bumpStructureVersion/
    // currentStructureVersion and hierarchy.ts's flatten()).
    bumpStructureVersion();
  }

  get(id: string): ChipDef {
    const def = this.defs.get(id);
    if (!def) throw new Error(`unknown chip definition: ${id}`);
    return def;
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }

  list(): ChipDef[] {
    return [...this.defs.values()];
  }

  remove(id: string): void {
    this.defs.delete(id);
    bumpStructureVersion();
  }

  /** Drops every registered def. Used when loading a project: the library
   * object's identity is kept (main.ts's Editor holds a readonly reference
   * to it) and its contents replaced, rather than swapping in a new
   * instance nothing else would know to look at. */
  clear(): void {
    this.defs.clear();
    bumpStructureVersion();
  }
}
