# ZX Spectrum test games (freeware / redistributable)

Files for exercising **Load .TAP** / **Load .SNA** in the soft Spectrum machine.
Only titles with clear redistribution permission are included.

| File | Type | Source / terms |
|------|------|----------------|
| `glazx48.tap` | TAP 48K | [GLAZX](https://github.com/EugenyN/GLAZX) — **MIT** |
| `ay-beep128.sna` | SNA 128K | Project-made AY tone + border flash smoke |
| `Homebrew.tap` | TAP 48K | Jonathan Cauldwell — freeware; author permits hosting |
| `Egghead.tap` | TAP 48K | Jonathan Cauldwell — freeware; author permits hosting |
| `EggheadInSpace.tap` | TAP 48K | Jonathan Cauldwell (Egghead 3) — freeware |
| `pZXl.tap` + `pZXl.txt` | TAP 48K | [ParaZXland](https://massimiliano-arca.itch.io/parazxland) — free redistribution if unmodified + keep `pZXl.txt` |
| `rainbow-demo.sna` | SNA 48K | Project smoke — bright paper-colour rainbow (attrs @ `$5800`, code @ `$8000`, DI) |

## How to try

1. Soft Run, Z80 with **addrBits=16**.
2. TTY → **Demo** dropdown → **Load demo** (e.g. `rainbow-demo.sna`), or **Load .SNA** / **Load .TAP**.
3. Or **Boot Spectrum 48K** then Spectrum tab → **LOAD ""** for TAP demos.
4. On “Press any key” / BASIC `PAUSE`, **hold Space** briefly.

## Coverage paths (CI / e2e)

| Path | Fixture / action |
|------|------------------|
| 48K SNA | `rainbow` |
| 48K TAP + PAUSE | `pzxl` (ParaZXland) |
| 48K TAP paint | `glazx` / Cauldwell titles |
| 48K TAP IM 2 gameplay | `glazx` (HALT+IM2 frame IRQ — needs soft IM 2) |
| 128K + 48 BASIC + TAP | Place 128 → 48 BASIC → `glazx` |
| Worker (http) | `spectrum-worker.spec.ts` |
| Beta TRD mount | synthetic `buildMinimalTrd` (sector stub — not full disk games) |

Commercial classic games (Manic Miner, etc.) are **not** redistributed here.
No extra 128K AY game binary is bundled — AY is covered by unit tests + Place 128 mute/UI.

Regenerate the embedded catalog after changing fixtures:

```bash
npm run gen:spectrum-games
```
