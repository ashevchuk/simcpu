/**
 * Per-demo control hints for the Spectrum joystick pad / teach overlay.
 */

import type { JoyMode } from './SpectrumJoystick.js';

export type SpectrumDemoHint = {
  joyMode: JoyMode;
  padHint: string;
  teachExtra?: string;
};

const HINTS: Record<string, SpectrumDemoHint> = {
  glazx: {
    joyMode: 'wasd',
    padHint: 'GLAZX: W/S map · 0 begin · F fire · pad=WASD',
    teachExtra:
      'Menu uses W/S (not arrows). Press 0 to begin. Use 2. SET CONTROLS for Kempston/Sinclair before switching pad mode.',
  },
  pzxl: {
    joyMode: 'kempston',
    padHint: 'ParaZXland: hold Space on PAUSE · then Kempston',
    teachExtra: 'On “Press any key” / PAUSE, hold Space briefly.',
  },
  egghead: {
    joyMode: 'kempston',
    padHint: 'Egghead: Q/A/O/P or Kempston — cycle pad mode',
  },
  'egghead-space': {
    joyMode: 'kempston',
    padHint: 'Egghead in Space: Q/A/O/P or Kempston',
  },
  homebrew: {
    joyMode: 'kempston',
    padHint: 'Homebrew: redefine / Kempston — cycle pad mode',
  },
  rainbow: {
    joyMode: 'kempston',
    padHint: 'Rainbow SNA — coloured paper bands (smoke test, no game)',
  },
  'ay-beep': {
    joyMode: 'kempston',
    padHint: '128K AY smoke — Unmute to hear tone · border flashes',
    teachExtra: 'Place/boot is 128K. Unmute AY in the panel if silent.',
  },
};

const DEFAULT_HINT: SpectrumDemoHint = {
  joyMode: 'kempston',
  padHint: 'Arrows + Space/Z · cycle pad mode above',
};

export function spectrumDemoHint(id: string | null | undefined): SpectrumDemoHint {
  if (!id) return DEFAULT_HINT;
  return HINTS[id] ?? DEFAULT_HINT;
}
