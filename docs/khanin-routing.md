# How cs.khanin.info routes wires

Mirror date: 2026-09-17 · source: `https://cs.khanin.info/src/editor/Workbench.js`

Khanin’s editor does **not** use A\*, channel mazes, body keepouts, or rip-up.
Routing is a small, deterministic ortho baker plus live end-stub reflow on drag.
That is why wires stay predictable and “KiCad-simple” on move.

## Core model

A wire is `{ a, b, pts }` where `pts` are **internal waypoints only** (pins are not stored).

| Situation | Behaviour |
|-----------|-----------|
| `pts` empty | Draw via `_orthoCorners` (auto L / mid-jog) |
| `pts` non-empty | Draw as a **straight polyline** pin → pts → pin (`_pathThrough`) — no per-segment re-ortho |
| After pin→pin create | `_finalizeWire` **bakes** `_orthoCorners` into `pts` so the wire owns its shape |

## Auto geometry: `_orthoCorners(a, b, lane)`

Pin facing comes from which edge the pin sits on (`_facing`: left/right → horizontal, top/bottom → vertical).

```
both H pins:  mid-X vertical jog   →  (mx,y1)-(mx,y2)     mx = avg(x) + lane*GRID
both V pins:  mid-Y horizontal jog →  (x1,my)-(x2,my)
H then V:     jog at dest column   →  (x2,y1)-(x2,y2)     (+ lane offset)
V then H:     jog at dest row      →  (x1,y2)-(x2,y2)
```

`lane = _laneOf(fromPin, wireIndex)` = count of earlier wires that share that pin → parallel exits fan out by one grid each.

## Create: `_finalizeWire`

1. If no manual pts → `pts = _orthoCorners(a, b, lane)`
2. `_pruneWirePts` drops waypoints whose removal does not change the drawn path (colinear / redundant)

## Drag (the important UX)

On mousedown over a selection:

1. **`_capMovingWirePts`** — wires with **both** ends selected: snapshot all waypoints (they translate with the chips).
2. **`_capReflowWires`** — wires with **exactly one** end selected: remember the waypoint **adjacent to the moving pin** and whether that stub is horizontal or vertical.

Each move frame:

1. Translate both-end waypoints by `(dx, dy)`.
2. **`_reflowEndSegs`** — for one-sided wires only:
   - horizontal stub → set that waypoint’s **Y** to the moved pin’s new Y  
   - vertical stub → set that waypoint’s **X** to the moved pin’s new X  

Far-side geometry is **never rebuilt**. No tidy-on-mouseup is required for orthogonality; the near stub simply tracks the pin.

## Manual edit extras

- Click-route snaps segments to 0° / 45° / 90° (`_snapWire`).
- Segment drag (`wireReshape`) shifts an H/V segment perpendicularly and rewrites corners.
- Waypoint drag + prune on release.
- Wire tap inserts a junction and splits the wire.

## Contrast with SimCPU today

| | Khanin | SimCPU (channel tidy) |
|--|--------|------------------------|
| Default shape | Mid-gap L / single jog + lane | Escape → A\* / pattern catalog + rails |
| Body avoid | No | Yes (host AABB) |
| On create | Bake simple ortho into pts | Smart route / channel |
| One-sided drag | Reflow **only** near stub | Keep far chain + channel/simple repair + tidy on mouseup |
| Parallel buses | `lane * GRID` on mid jog | `assignRibbonRails` / preferRail |

## Takeaway for SimCPU

If the goal is “like Khanin”, the highest-leverage change is **drag reflow**, not a smarter maze:

1. Bake a Khanin-style `_orthoCorners` (+ lane) when committing a pin→pin wire with no bends.
2. On component drag, implement `_capReflowWires` / `_reflowEndSegs` instead of (or before) full local channel repair.
3. Keep far waypoints untouched; drop mouseup full tidy for the common one-sided move case (or make it optional).
4. Keep channel/A\* as an explicit **Tidy** for congested Soft Lab benches where body avoid still matters.

Reference mirror of the site (for local study) was fetched to `/tmp/khanin/` on the analysis machine; do not vendor their full `Workbench.js` into this repo.
