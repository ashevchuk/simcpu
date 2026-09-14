/**
 * Soft echo monitor — real Z80 opcodes loaded at RAM 0x000.
 * Polls KEY_STATUS/KEY_DATA, echoes to the 32×8 framebuffer at 0xE00.
 *
 * Listing (addresses hex):
 *  0000  LD HL,0xE00
 *  0003  LD A,'>'
 *  0005  LD (HL),A
 *  0006  INC HL
 *  0007  poll: LD A,(KEY_STATUS)
 *  000A  CP 1
 *  000C  JR NZ,poll
 *  000E  LD A,(KEY_DATA)
 *  0011  LD B,A
 *  0012  XOR A
 *  0013  LD (KEY_STATUS),A
 *  0016  LD A,B
 *  0017  CP 0x0D
 *  0019  JR Z,do_cr
 *  001B  CP 0x08
 *  001D  JR Z,do_bs
 *  001F  LD (HL),A
 *  0020  INC HL
 *  0021  LD A,H
 *  0022  CP 0x0F          ; wrap when HL reaches 0xF00
 *  0024  JR C,poll
 *  0026  LD HL,0xE00
 *  0029  JR poll
 *  002B  do_cr: LD A,L
 *  002C  AND 0xE0
 *  002E  ADD A,0x20
 *  0030  LD L,A
 *  0031  JR NC,cr_ok
 *  0033  INC H
 *  0034  cr_ok: LD A,H
 *  0035  CP 0x0F
 *  0037  JR C,poll
 *  0039  LD HL,0xE00
 *  003C  JR poll
 *  003E  do_bs: LD A,L
 *  003F  CP 0
 *  0041  JR NZ,bs_do
 *  0043  LD A,H
 *  0044  CP 0x0E
 *  0046  JR Z,poll         ; ignore BS at 0xE00
 *  0048  bs_do: DEC HL
 *  0049  LD (HL),0x20
 *  004B  JR poll
 */

export const MONITOR_BYTES = Uint8Array.from([
  0x21, 0x00, 0x0e, // LD HL,0xE00
  0x3e, 0x3e, // LD A,'>'
  0x77, // LD (HL),A
  0x23, // INC HL
  0x3a, 0x00, 0x0f, // poll: LD A,(KEY_STATUS)
  0xfe, 0x01, // CP 1
  0x20, 0xf9, // JR NZ,poll
  0x3a, 0x01, 0x0f, // LD A,(KEY_DATA)
  0x47, // LD B,A
  0xaf, // XOR A
  0x32, 0x00, 0x0f, // LD (KEY_STATUS),A
  0x78, // LD A,B
  0xfe, 0x0d, // CP CR
  0x28, 0x10, // JR Z,do_cr
  0xfe, 0x08, // CP BS
  0x28, 0x1f, // JR Z,do_bs
  0x77, // LD (HL),A
  0x23, // INC HL
  0x7c, // LD A,H
  0xfe, 0x0f, // CP 0x0F
  0x38, 0xe1, // JR C,poll
  0x21, 0x00, 0x0e, // LD HL,0xE00
  0x18, 0xdc, // JR poll
  0x7d, // do_cr: LD A,L
  0xe6, 0xe0, // AND 0xE0
  0xc6, 0x20, // ADD A,0x20
  0x6f, // LD L,A
  0x30, 0x01, // JR NC,cr_ok
  0x24, // INC H
  0x7c, // cr_ok: LD A,H
  0xfe, 0x0f, // CP 0x0F
  0x38, 0xce, // JR C,poll
  0x21, 0x00, 0x0e, // LD HL,0xE00
  0x18, 0xc9, // JR poll
  0x7d, // do_bs: LD A,L
  0xfe, 0x00, // CP 0
  0x20, 0x05, // JR NZ,bs_do
  0x7c, // LD A,H
  0xfe, 0x0e, // CP 0x0E
  0x28, 0xbf, // JR Z,poll
  0x2b, // bs_do: DEC HL
  0x36, 0x20, // LD (HL),' '
  0x18, 0xba, // JR poll
]);

/** Comma-separated hex for the + Z80CPU program prompt default. */
export function monitorHexPrompt(): string {
  return [...MONITOR_BYTES].map((b) => b.toString(16).padStart(2, '0')).join(',');
}

/** Copy monitor image into the start of a RAM byte array. */
export function loadMonitor(bytes: Uint8Array): void {
  if (bytes.length < MONITOR_BYTES.length) {
    throw new RangeError(`RAM too small for monitor (${bytes.length} < ${MONITOR_BYTES.length})`);
  }
  bytes.set(MONITOR_BYTES, 0);
}
