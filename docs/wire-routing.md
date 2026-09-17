# Wire routing algorithms (stand / future rewrite)

Status: **draft for a simplified routing stand**. Production code lives in
`src/ui/geometry.ts`. Current smart ortho is usable but still picks awkward
paths around bodies; do **not** treat this doc as the shipped behavior contract.

Goal for the stand: pin→pin orthogonal routes that

1. leave each pin along its natural exit direction,
2. avoid component body AABBs,
3. prefer few bends and short total length,
4. never introduce 45° segments,
5. play well with explicit waypoints and T-junction nodes.

---

## Current pipeline (what ships today)

```
raw polyline (pin → waypoints → pin)
        │
        ▼
routeWirePoints()
  ├─ pinExitDir(start/end) from body center
  ├─ per segment: routeSegmentSmart()
  │     ├─ collectPatternCandidates()  // L / Z / exit stubs
  │     ├─ pickBestPath(score)
  │     └─ if still hits bodies → routeAStar() on GRID
  └─ simplifyOrthoPath()
```

| Piece | Role |
|-------|------|
| `pinExitDir` | Unit axis away from component center through the pin |
| `orthogonalPoints` / HV·VH | Single-corner L between two points |
| `collectPatternCandidates` | Catalog of L/Z + stub escapes for start/end dirs |
| `pickBestPath` | Score length, bends, obstacle penetration |
| `routeAStar` | Coarse grid maze; null if window too big / blocked |
| `simplifyOrthoPath` | Drop colinear / duplicate verts |
| `routingObstacles` | Body AABBs for the active circuit |
| `findWireCrossings` | Cosmetic H×V solder dots (not topology) |

**Pain points observed in lab tutorials**

- Stub catalog often wins over A* even when a cleaner maze path exists.
- Obstacles are axis-aligned boxes only — no “channel” preference between chips.
- Multi-waypoint wires only smart-route first/last legs; middle stays crude L.
- Commit-time auto-tidy can fight manual bends the user just placed.

---

## Proposed stand algorithms

Build a **headless** harness: pins + AABBs in, polyline out, golden fixtures,
visual HTML dump optional. Iterate here before touching the editor again.

### A. Pattern-first with hard obstacle veto (small change)

1. Generate the same L/Z/stub catalog.
2. **Reject** any candidate that intersects an obstacle interior (not merely score higher).
3. If none remain → A*.
4. If A* fails → longest clear stub + L to the other pin (always succeeds topologically if pins are outside boxes).

Acceptance: no segment midpoint inside a body AABB.

### B. Escape-then-channel (recommended next)

1. **Escape:** from each pin, walk `exitDir` by `k·GRID` until clear of own body (+ margin).
2. **Channel graph:** on a GRID, nodes = free cells; edges = 4-neighbor ortho.
3. **A\*** from escape(start) to escape(end) with costs:
   - unit length = 1
   - bend (direction change) = `B` (try 1.5–3)
   - running alongside an existing wire of same net = small bonus (optional later)
4. **Simplify** colinear points; attach pin→escape stubs.

Acceptance fixtures: latch example, counter→7seg ribbon, two chips face-to-face with pins on facing edges.

### C. Visibility / rectilinear visibility graph

1. Inflate obstacles by half-wire clearance.
2. Steiner candidates: pin escapes + obstacle corners (rectilinear).
3. Connect mutually visible ortho pairs; shortest path + bend penalty.
4. Good for sparse boards; can explode with many chips — cap corner set.

Use when B’s grid is too coarse or too slow on dense netlists.

### D. Incremental / local repair (editor UX)

On drag of a waypoint or component:

1. Freeze unrelated wires.
2. Re-route only segments that intersect moved AABB or that shared the dragged node.
3. Prefer keeping user’s explicit waypoints unless they become collinear.

Junction delete already heals through-wires — keep that contract.

---

## Scoring sketch (shared by A/B)

```
cost = length
     + bendPenalty * (#corners)
     + obstaclePenalty * (penetration depth or binary hit)
     + viaPenalty * (optional layer changes — N/A today)
```

Prefer binary obstacle rejection over soft penetration when teaching/lab clarity matters more than “almost misses.”

---

## Stand file layout (suggested)

```
stands/wire-routing/
  README.md          # how to run
  fixtures/*.json    # pins, obstacles, expected path class
  src/route.ts       # candidates under test (copy/adapt from geometry.ts)
  src/score.ts
  src/viz.html       # optional polyline overlay
  test/*.test.ts
```

Do not import the full Editor — keep the stand free of canvas/DOM so algorithms stay honest.

---

## Exit criteria before merging back to geometry.ts

- [ ] All fixtures: zero body intersections
- [ ] Latch + counter examples: no wire through chip body at default zoom
- [ ] Pin→pin with facing exits uses ≤ 3 bends in the common case
- [ ] Explicit waypoint in the middle is preserved under tidy of other legs
- [ ] T-junction branch still commits with smart first/last legs only
- [ ] Perf: &lt; 2 ms per route on a 50-obstacle board (desktop)

When those pass, replace `routeSegmentSmart` / `routeWirePoints` internals and keep the public signatures stable.
