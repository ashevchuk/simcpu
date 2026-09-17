# Wire routing stand

Headless harness for the next schematic router (escape → channel A\*).
Production still uses `src/ui/geometry.ts`; merge only after fixtures pass.

```bash
npm run test:routing
# optional SVG dump for a fixture:
npx vite-node stands/wire-routing/src/dump.ts face-to-face
# drag a part in a real example and audit every wire on it:
npx vite-node stands/wire-routing/src/dragRepro.ts examples/lab-counter-7seg.json COUNTER4 90 0
```

## Layout

| Path | Role |
|------|------|
| `src/route.ts` | Escape-then-channel A\* |
| `src/score.ts` | Length / bends / body hits |
| `src/types.ts` | Shared geometry types |
| `src/dragRepro.ts` | Move a part in an example, tidy, audit the wires |
| `fixtures/*.json` | Pin pairs + AABBs + acceptance |
| `test/*.test.ts` | Golden checks |

## Acceptance (per fixture)

- Zero segment midpoints inside obstacle interiors
- `maxBends` / `maxLength` ceilings when declared
- Ribbon: distinct Y (or X) trunks — no stacked overlap
