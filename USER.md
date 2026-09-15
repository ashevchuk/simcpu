# SimCPU — quick user guide

A transistor-level schematic editor with live simulation, foldable chips, and an optional soft Z80 machine.

## Place & wire

- **Tools:** `1` select, `2` pan, `3` wire (or the toolbar). Space + drag also pans; right-drag pans.
- **Place** menu (or hotkeys `4`–`9`, `B`, `E`, `K`, `O`, `L`) drops transistors, rails, I/O, probes, labels, clocks, analyzers.
- **Wire** tool: click pin → click pin. Esc backs up a bend or cancels.
- **T** tidies selected wires (orthogonal route). Arrow keys nudge selection by one grid; after nudge, attached wires tidy.

## Orient

- **R** / **Shift+R** — rotate clockwise / counter-clockwise (multi-select rotates around the group center).
- **M** / **Shift+M** — flip horizontal / vertical.
- Right-click the canvas for the same actions plus tidy, delete, dive, pin side, rename net, copy/paste.

## Fold & hierarchy

- **Ctrl+G** fold selection into a reusable chip; **Ctrl+Shift+G** unfold.
- Double-click a chip (or Inspector → Dive) to edit internals; breadcrumb or Esc climbs out.
- Library menu lists folded chips you can place again.

## Sessions & examples

- Work autosaves into browser session slots (File → Switch / New / Rename session).
- **File → Open examples…** loads built-in demos. **Help → Tutorial (latch)…** loads the D-latch walkthrough.
- Export / import project or chip JSON from the File menu. **Export PNG…** / **Export SVG…** snapshot the schematic.

## Simulate

- The solver runs continuously while the circuit is unsettled.
- Toolbar **Run** / **Pause** / **Step**: Pause freezes solver ticks; Step advances one tick (and one soft-CPU instruction when a machine is attached).
- Status bar shows contended nets — click it when contended > 0 to highlight the first contended net.
- Net labels named **VCC** or **GND** power that rail even without a Source component.

## Help

- Press **?** for the keyboard cheat sheet (Help menu also opens it).
- **Ctrl+Z** / **Ctrl+Y** undo / redo. **Ctrl+F** find, **Ctrl+R** rename net, **Ctrl+C/V/D** copy / paste / duplicate.
- Minimap (bottom-right) pans the view; press **=** to hide/show it.
