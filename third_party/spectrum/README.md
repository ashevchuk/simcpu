# ZX Spectrum ROMs & games (research / educational)

| File | Notes |
|------|--------|
| `48.rom` | 16 KiB ZX Spectrum 48K BASIC/firmware ROM |
| `128-0.rom` / `128-1.rom` | 16 KiB each — Spectrum 128 editor + 48 BASIC (Fuse) |
| `128.rom` | Concatenation of `128-0` + `128-1` (32 KiB) for soft 128 |
| `trdos.rom` | 16 KiB TR-DOS 5.03 ROM for soft Beta Disk (**ROM paging only** — disk sector I/O is stubbed) |
| `games/` | Freeware `.tap` / `.sna` fixtures — see [`games/README.md`](games/README.md). Sole source for bundled demos (no duplicate TAP at this folder root). |

SHA-1:
- `48.rom`: `5ea7c2b824672e914525d1d5c419d71b84a426a2` (standard Fuse 48.rom)
- `128-0.rom`: `4f4b11ec22326280bdb96e3baf9db4b4cb1d02c5`
- `128-1.rom`: `80080644289ed93d71a1103992a154cc9802b2fa`
- `trdos.rom`: `0a74bd34538a03d0e1d214b425d95c14ad10c8c4` (TR-DOS 5.03)

## License

The Spectrum ROMs are copyright **Amstrad plc** (formerly Sinclair).
Amstrad has kindly given permission for redistribution of their copyrighted
ROM images with emulators provided copyright messages are not altered.
Amstrad retains copyright. See Amstrad ROM permissions (Cliff Lawson, 1999).

This project redistributes the unmodified ROM for **non-commercial research /
educational** use only.

Game images under `games/` keep their authors' licenses (MIT / freeware /
explicit redistribution notices).
