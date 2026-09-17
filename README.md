# SimCPU

Transistor-level schematic editor with live simulation, foldable chips, a digital lab pack, and an optional soft Z80 machine (TTY, Spectrum, CP/M).

## Getting started

```bash
npm install
npm run dev
```

Open the local URL Vite prints. Usage guide: **[USER.md](./USER.md)**. Soft Lab walkthrough (in-app): **Help → Lab manual…**.

## Digital lab (quick)

- **Help → Lab manual…** — sections + screenshots (Soft Lab, course ladder, bus switches, instruments). Keep it current when lab UX changes.
- Library palette filters: **Gates** / **Lab** / **74xx** / **User**.
- Toolbar **Soft Lab** (default on) runs COUNTER/REG/SHIFT/BCD/… as fast behavioral chips; off = full transistor flatten.
- **Help → Lab course…** — checklist ladder (CMOS → latch → counter → ALU → Soft RAM → contention → mini-CPU → analyzer).
- Examples: Counter+7-seg, SIPO, decoder, logic analyzer — **File → Open examples…** or **Help → Tutorial (lab counter)…**.
- Logic analyzer: Arm, optional edge trigger, channel labels, add/remove channels.
- Instruments: pulse clock (**K**), 7-seg (**S**), buttons, LEDs, bus probes / DIP bus switches.
- Wire routing stand notes (future): [`docs/wire-routing.md`](./docs/wire-routing.md).

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Vite dev server |
| `npm test` | Vitest unit suite |
| `npm run test:spectrum-play` | Spectrum playability + IM2 / demo hints |
| `npm run build` | `tsc` + Vite production build |
| `npm run build:dist-file` | Single-file `dist-file/` build for `file://` (IIFE + `spectrum-worker.js`) |
| `npx playwright test` | E2E against `dist-file/` (run `build:dist-file` first) |

## Soft machines (quick)

- **Place → Spectrum 48K / 128K** opens the machine panel and boots soft Spectrum.
- Share demos: `#demo=rainbow` (or `glazx`, `egghead`, …). Snapshot share: `#sna=…` (deflate).
- Project share: **File → Copy share link** → `#p=…`.
- On `file://`, Chromium blocks classic Workers — Spectrum falls back to the main-thread engine (`spectrum-worker.js` is still built for http(s) hosts). Playwright `spectrum-worker.spec.ts` serves `dist-file/` over localhost to exercise the Worker path.
- **Reboot** on an active Spectrum session cold-boots ROM at `$0000` (clears SNA/TAP state). Non-Spectrum soft/gate reboot is unchanged.
- Soft Beta/TR-DOS: sector R/W stub (not cycle-exact WD1793). UI marks **TR-DOS***.
- Soft contended memory uses approximate wait units (`contend≈` in the Spectrum regs panel).
- Smoke: `npm run test:e2e:spectrum` (file:// + http Worker + key demos). Playability: `npm run test:spectrum-play`.

## third_party

- `third_party/spectrum/` — ROMs + `games/` freeware TAP/SNA (embedded via `scripts/gen-spectrum-games.ts`).
- `third_party/cpm/` — CP/M 2.2 + rogue disks (embedded for Boot CP/M).

See READMEs in those folders for licenses.
