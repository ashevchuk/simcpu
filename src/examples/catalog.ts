/**
 * Built-in demo projects (same JSON shape as File → Export project).
 * Source files live in /examples/*.json for easy hand-editing; regenerate
 * with `npx vite-node scripts/gen-examples.ts` after changing builders.
 */

import type { SerializedProject } from '../sim/serialize.js';
import andGate from '../../examples/and-gate.json';
import cmosInverter from '../../examples/cmos-inverter.json';
import dLatch from '../../examples/d-latch.json';
import halfAdder from '../../examples/half-adder.json';
import nandGate from '../../examples/nand-gate.json';
import romViewer from '../../examples/rom-viewer.json';
import xorPulse from '../../examples/xor-pulse.json';

export interface ExampleProject {
  id: string;
  title: string;
  detail: string;
  project: SerializedProject;
}

export const EXAMPLE_PROJECTS: ExampleProject[] = [
  {
    id: 'cmos-inverter',
    title: 'CMOS inverter',
    detail: 'Toggle → transistor NOT → LED',
    project: cmosInverter as SerializedProject,
  },
  {
    id: 'nand-gate',
    title: 'NAND (library chip)',
    detail: 'Two toggles → NAND stdcell → LED',
    project: nandGate as SerializedProject,
  },
  {
    id: 'and-gate',
    title: 'AND (library chip)',
    detail: 'Dive into a folded stdcell',
    project: andGate as SerializedProject,
  },
  {
    id: 'half-adder',
    title: 'Half adder',
    detail: 'A/B → sum & carry LEDs',
    project: halfAdder as SerializedProject,
  },
  {
    id: 'd-latch',
    title: 'Latch walkthrough',
    detail: 'Tutorial: D + enable → Q / Qn — toggle D, pulse E, watch Q hold',
    project: dLatch as SerializedProject,
  },
  {
    id: 'rom-viewer',
    title: 'ROM viewer',
    detail: '256×8 ROM with Hello! — dblclick to hex-edit',
    project: romViewer as SerializedProject,
  },
  {
    id: 'xor-pulse',
    title: 'XOR + pulse clock',
    detail: 'Toggle ⊕ free-running Pulse → LED',
    project: xorPulse as SerializedProject,
  },
];
