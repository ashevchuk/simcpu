# CP/M disk images (research)

| File | Source | Notes |
|------|--------|--------|
| `cpm22-1.dsk` | [udo-munk/z80pack](https://github.com/udo-munk/z80pack) `cpmsim/disks/library/` | Bootable CP/M 2.2 system |
| `rogue.dsk` | z80pack `ftp/rogue.tgz` | Games: `ROGUE-VT.COM`, `WANDERER.COM` (VT-100) |

Geometry: raw IBM 8" SS SD (77×26×128 = 256256 bytes).

## License

- **z80pack** tooling/BIOS: BSD-style (Udo Munk).
- **CP/M binaries** on `cpm22-1.dsk`: Digital Research / Caldera heritage.
  Caldera historically allowed free personal, non-commercial, educational,
  and evaluation use of CP/M 2.2. This project redistributes the image for
  **research / educational** use only.
- **Rogue / Wanderer** on `rogue.dsk`: redistributed as packaged by z80pack for
  educational use; see upstream docs for game-specific terms.

Boot layout (64K): CCP @ E400, BDOS @ EC06, CBIOS @ FA00 (z80pack CBIOS).

In the TTY panel: **Boot CP/M** loads A: only; **Boot CP/M+games** also mounts
`rogue.dsk` as B:. After `A>`, type `B:` then `ROGUE-VT` (needs VT100 console).
