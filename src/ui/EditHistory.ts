/**
 * Undo/redo for the circuit editor — snapshots of the active Circuit only
 * (top level or the ChipDef currently dived into). Library chip defs other
 * than the open one are untouched.
 */

import { captureCircuit, restoreCircuit, type CircuitSnapshot } from '../sim/serialize.js';
import type { Circuit } from '../sim/Circuit.js';

const LIMIT = 60;

export class EditHistory {
  private undoStack: CircuitSnapshot[] = [];
  private redoStack: CircuitSnapshot[] = [];

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Call immediately before a user mutation. */
  checkpoint(circuit: Circuit): void {
    this.undoStack.push(captureCircuit(circuit));
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(circuit: Circuit): boolean {
    if (this.undoStack.length === 0) return false;
    this.redoStack.push(captureCircuit(circuit));
    restoreCircuit(circuit, this.undoStack.pop()!);
    return true;
  }

  redo(circuit: Circuit): boolean {
    if (this.redoStack.length === 0) return false;
    this.undoStack.push(captureCircuit(circuit));
    restoreCircuit(circuit, this.redoStack.pop()!);
    return true;
  }
}
