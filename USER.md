# SimCPU — quick user guide

A transistor-level schematic editor with live simulation, foldable chips, and an optional soft Z80 machine.

## Place & wire

- **Tools:** `1` select, `2` pan, `3` wire (or the toolbar). Space + drag also pans; right-drag pans.
- **Place** menu (or hotkeys `4`–`9`, `B`, `E`, `K`, `O`, `L`) drops transistors, rails, I/O, probes, bus probes, labels, clocks, analyzers.
- **Wire** tool: click pin → click pin. Esc backs up a bend or cancels.
- **T** tidies selected wires (orthogonal route). Arrow keys nudge selection by one grid; after nudge, attached wires tidy.

## Orient

- **R** / **Shift+R** — rotate clockwise / counter-clockwise (multi-select rotates around the group center).
- **M** / **Shift+M** — flip horizontal / vertical.
- Right-click the canvas for the same actions plus tidy, delete, dive, pin side, rename net, copy/paste.

## Fold & hierarchy

- **Ctrl+G** fold selection into a reusable chip; **Ctrl+Shift+G** unfold.
- Double-click a chip (or Inspector → Dive) to edit internals; breadcrumb or Esc climbs out.
- **Library** menu lists folded chips (search / stdcell·user filters; **Ctrl+L** focuses search). Place again from the palette.
- Stdcells include gates (NOT/NAND/…) plus the digital-lab pack: registers, shifters, counters, decoders, comparators, BCD→7seg, bus buffers, and 74xx aliases — hierarchies of smaller chips. Place a **7-seg display** from the Place menu (active-high common-cathode).
- When a chip shows a yellow **edited** badge (def changed after place), context menu or Inspector → **Update from library** refreshes pin sides/layout and clears the badge without deleting wires.

## Sessions & examples

- Work autosaves into browser session slots (File → Switch / New / Rename session). If another tab saved the same slot, the status shows **Changed elsewhere** — click it for Restore local / Load other / Export.
- **File → Open examples…** loads built-in demos. **File → Copy share link** puts a `#p=…` URL on the clipboard (open the link to load; confirms replace).
- Export / import project or chip JSON from the File menu. **Export PNG…** / **Export SVG…** snapshot the schematic.

## Simulate

- The solver runs continuously while the circuit is unsettled.
- Toolbar **Run** / **Pause** / **Step**: Pause freezes solver ticks; Step advances one tick (and one soft-CPU instruction when a machine is attached).
- Status bar shows contended nets (shorts) — click it when contended > 0 to highlight the first contended net. Contended wires pulse with a heat/ember animation.
- Net labels named **VCC** or **GND** power that rail even without a Source component.

## Soft Z80 machine (TTY)

**Place → Spectrum 48K… / 128K…** drops a Z80 + 64K RAM, opens TTY, and boots soft Spectrum in one click.

Open `#demo=rainbow` (or `egghead`, `glazx`, …) to auto-place and load a bundled demo (model from the entry, default 48K). A short teach overlay explains the Spectrum tab.

Share a live snapshot with **Copy SNA link** (`#sna=z…` deflate) or load one the same way.

Or place a **Z80CPU** with **addrBits=16** (64K RAM), open the TTY panel, Soft speed:

- **Boot Spectrum 48K / 128K** — soft ULA screen on the Spectrum tab (keys, Kempston/Cursor pad). **48 BASIC** pages the 128 editor ROM. **Boot TR-DOS** pages Beta Disk ROM.
- **Load .SNA / .Z80 / .TAP / .TZX** — snapshots and tape flash-load (`LOAD ""`). **Save .SNA / .Z80 / PNG / .SCR**.
- **Mount .TRD** — mounts a Beta Disk image and can page TR-DOS ROM; **sector I/O is a stub** (no full WD1793), so most disk titles will not load files yet.
- **Demo** dropdown loads bundled freeware TAP/SNA. TAP/TZX demos wait for BASIC input then auto-type `LOAD ""` (with retry).
- **Reboot** (machine panel) cold-boots the soft Spectrum ROM at `$0000` and clears tape/snapshot CPU state while keeping the Spectrum session. On non-Spectrum soft/gate machines it reseeds the soft CPU / gate FSM as before.
- **Spec×** multiplies soft ops/frame (frameskip at 4×+). **Mute** silences AY + beeper (128 AY via FFFD/BFFD). Soft Spectrum prefers a **Worker** (`spectrum-worker.js`); on `file://` Chromium blocks Workers so the engine falls back to the main thread.
- Spectrum tab: **Tape** browser (Rewind / Next / Pause / queue / progress — also posted to the Worker when active), **Poke / cheats**, live **registers** (64-byte watch dump), **PC / write breakpoints**, **Step Over**, **NMI**, Kempston/Cursor/Sinclair pad.
- Soft contended accesses drain the frame instruction budget (`contend≈` in regs — approximate, not cycle-exact ULA).
- Soft Beta: sector R/W + seek/read-address against `.TRD` (enough for many TR-DOS ROM paths). **Not** a full WD1793 timing model; DivMMC/+2A ports are **latches only** (no banked ROM).
- Flash-load trap enables interrupts on exit (EI+RET). Games that use BASIC `PAUSE` / “press any key” need that — **hold** a key briefly if a quick tap seems ignored.
- Also: Boot BASIC / CP/M / soft stub from the same panel.

## Help

- Press **?** for the keyboard cheat sheet (Help menu also opens it).
- **Help → Tutorial…** runs an in-canvas button→LED→wire→toggle walkthrough. **Tutorial (latch)…** loads the D-latch example.
- **Ctrl+Z** / **Ctrl+Y** undo / redo. **Ctrl+F** find, **Ctrl+R** rename net, **Ctrl+C/V/D** copy / paste / duplicate. **Ctrl+Shift+V** or Edit → **Stamp×N…** pastes a grid of copies.
- Minimap (bottom-right) pans the view; press **=** to hide/show it.
