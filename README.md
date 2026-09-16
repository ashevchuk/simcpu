# SimCPU

Transistor-level schematic editor with live simulation, foldable chips, and an optional soft Z80 machine (TTY, Spectrum, CP/M).

## Getting started

```bash
npm install
npm run dev
```

Open the local URL Vite prints. Usage guide: **[USER.md](./USER.md)**.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Vite dev server |
| `npm test` | Vitest unit suite |
| `npm run build` | `tsc` + Vite production build |
| `npm run build:dist-file` | Single-file `dist-file/` build for `file://` (IIFE + `spectrum-worker.js`) |
| `npx playwright test` | E2E against `dist-file/` (run `build:dist-file` first) |

## Soft machines (quick)

- **Place → Spectrum 48K / 128K** opens the machine panel and boots soft Spectrum.
- Share demos: `#demo=rainbow` (or `glazx`, `egghead`, …). Snapshot share: `#sna=…` (deflate).
- Project share: **File → Copy share link** → `#p=…`.
- On `file://`, Chromium blocks classic Workers — Spectrum falls back to the main-thread engine (`spectrum-worker.js` is still built for http(s) hosts). Playwright `spectrum-worker.spec.ts` serves `dist-file/` over localhost to exercise the Worker path.
- **Reboot** on an active Spectrum session cold-boots ROM at `$0000` (clears SNA/TAP state). Non-Spectrum soft/gate reboot is unchanged.
- Soft Beta/TR-DOS: sector R/W + seek/read-address on `.TRD` (not cycle-exact WD1793). DivMMC/+2A ports are UI latches only.
- Soft contended memory uses approximate wait units (`contend≈` in the Spectrum regs panel).
- Smoke: `npm run test:e2e:spectrum` (file:// + http Worker + key demos).

## third_party

- `third_party/spectrum/` — ROMs + `games/` freeware TAP/SNA (embedded via `scripts/gen-spectrum-games.ts`).
- `third_party/cpm/` — CP/M 2.2 + rogue disks (embedded for Boot CP/M).

See READMEs in those folders for licenses.
