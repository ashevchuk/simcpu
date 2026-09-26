/**
 * Table-driven Z80 disassembler for the Memory editor.
 *
 * Covers the opcode subset the soft CPU / mini assembler use day-to-day
 * (unprefixed + CB/ED/DD/FD common forms). Unknown / truncated bytes → DB nn.
 */

export interface DisasmLine {
  addr: number;
  size: number;
  bytes: number[];
  text: string;
}

export interface DisasmOptions {
  /** Max instructions to emit (default 32). */
  count?: number;
  /** Stop after this many bytes (default: rest of image). */
  maxBytes?: number;
}

const R8 = ['B', 'C', 'D', 'E', 'H', 'L', '(HL)', 'A'] as const;
const RP = ['BC', 'DE', 'HL', 'SP'] as const;
const RP2 = ['BC', 'DE', 'HL', 'AF'] as const;
const CC = ['NZ', 'Z', 'NC', 'C', 'PO', 'PE', 'P', 'M'] as const;
const ALU = ['ADD A,', 'ADC A,', 'SUB ', 'SBC A,', 'AND ', 'XOR ', 'OR ', 'CP '] as const;
const ROT = ['RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', 'SLL', 'SRL'] as const;

function hex2(n: number): string {
  return (n & 0xff).toString(16).padStart(2, '0');
}

function hex4(n: number): string {
  return (n & 0xffff).toString(16).padStart(4, '0');
}

function imm8(bytes: Uint8Array, i: number): number | null {
  if (i >= bytes.length) return null;
  return bytes[i]!;
}

function imm16(bytes: Uint8Array, i: number): number | null {
  if (i + 1 >= bytes.length) return null;
  return bytes[i]! | (bytes[i + 1]! << 8);
}

function relTarget(addr: number, size: number, off: number): number {
  const d = off > 127 ? off - 256 : off;
  return (addr + size + d) & 0xffff;
}

function dbAt(addr: number, b: number): DisasmLine {
  return { addr, size: 1, bytes: [b], text: `DB ${hex2(b)}h` };
}

function line(addr: number, raw: number[], text: string): DisasmLine {
  return { addr, size: raw.length, bytes: raw, text };
}

function fmtLine(d: DisasmLine): string {
  const hex = d.bytes.map(hex2).join(' ');
  return `${hex4(d.addr)}  ${hex.padEnd(12)}  ${d.text}`;
}

/**
 * Disassemble one instruction at `addr`. Always consumes ≥1 byte if any remain.
 */
export function disassembleOne(bytes: Uint8Array, addr: number): DisasmLine {
  if (addr < 0 || addr >= bytes.length) {
    return { addr: addr & 0xffff, size: 0, bytes: [], text: '' };
  }
  const op = bytes[addr]!;
  const a = addr & 0xffff;

  // --- CB prefix ---
  if (op === 0xcb) {
    const n = imm8(bytes, addr + 1);
    if (n === null) return dbAt(a, op);
    const x = (n >> 6) & 3;
    const y = (n >> 3) & 7;
    const z = n & 7;
    const r = R8[z]!;
    let text: string;
    if (x === 0) text = `${ROT[y]!} ${r}`;
    else if (x === 1) text = `BIT ${y},${r}`;
    else if (x === 2) text = `RES ${y},${r}`;
    else text = `SET ${y},${r}`;
    return line(a, [op, n], text);
  }

  // --- ED prefix ---
  if (op === 0xed) {
    const n = imm8(bytes, addr + 1);
    if (n === null) return dbAt(a, op);
    const x = (n >> 6) & 3;
    const y = (n >> 3) & 7;
    const z = n & 7;
    const p = (y >> 1) & 3;
    const q = y & 1;

    if (x === 1) {
      if (z === 0) {
        if (y === 6) return line(a, [op, n], 'IN 0,(C)');
        return line(a, [op, n], `IN ${R8[y]!},(C)`);
      }
      if (z === 1) {
        if (y === 6) return line(a, [op, n], 'OUT (C),0');
        return line(a, [op, n], `OUT (C),${R8[y]!}`);
      }
      if (z === 2) {
        return line(a, [op, n], q === 0 ? `SBC HL,${RP[p]!}` : `ADC HL,${RP[p]!}`);
      }
      if (z === 3) {
        const nn = imm16(bytes, addr + 2);
        if (nn === null) return dbAt(a, op);
        if (q === 0) return line(a, [op, n, bytes[addr + 2]!, bytes[addr + 3]!], `LD (${hex4(nn)}h),${RP[p]!}`);
        return line(a, [op, n, bytes[addr + 2]!, bytes[addr + 3]!], `LD ${RP[p]!},(${hex4(nn)}h)`);
      }
      if (z === 4) return line(a, [op, n], 'NEG');
      if (z === 5) return line(a, [op, n], y === 1 ? 'RETI' : 'RETN');
      if (z === 6) return line(a, [op, n], `IM ${y === 0 ? 0 : y === 2 ? 1 : y === 3 ? 2 : y}`);
      if (z === 7) {
        const map = ['LD I,A', 'LD R,A', 'LD A,I', 'LD A,R', 'RRD', 'RLD', 'NOP', 'NOP'];
        return line(a, [op, n], map[y]!);
      }
    }
    if (x === 2 && z <= 3 && y >= 4) {
      const blk = [
        ['LDI', 'CPI', 'INI', 'OUTI'],
        ['LDD', 'CPD', 'IND', 'OUTD'],
        ['LDIR', 'CPIR', 'INIR', 'OTIR'],
        ['LDDR', 'CPDR', 'INDR', 'OTDR'],
      ] as const;
      return line(a, [op, n], blk[y - 4]![z]!);
    }
    return line(a, [op, n], `DB EDh,${hex2(n)}h`);
  }

  // --- DD / FD (IX / IY) — common forms ---
  if (op === 0xdd || op === 0xfd) {
    const xy = op === 0xdd ? 'IX' : 'IY';
    const n = imm8(bytes, addr + 1);
    if (n === null) return dbAt(a, op);
    const pref = [op];

    if (n === 0xcb) {
      const d = imm8(bytes, addr + 2);
      const b = imm8(bytes, addr + 3);
      if (d === null || b === null) return dbAt(a, op);
      const x = (b >> 6) & 3;
      const y = (b >> 3) & 7;
      const z = b & 7;
      const disp = d > 127 ? d - 256 : d;
      const mem = `(${xy}${disp >= 0 ? '+' : ''}${disp})`;
      let text: string;
      if (x === 0) {
        text = z === 6 ? `${ROT[y]!} ${mem}` : `${ROT[y]!} ${mem},${R8[z]!}`;
      } else if (x === 1) text = `BIT ${y},${mem}`;
      else if (x === 2) {
        text = z === 6 ? `RES ${y},${mem}` : `RES ${y},${mem},${R8[z]!}`;
      } else {
        text = z === 6 ? `SET ${y},${mem}` : `SET ${y},${mem},${R8[z]!}`;
      }
      return line(a, [op, n, d, b], text);
    }

    // LD IX/IY,nn / LD (nn),IX / ADD IX,rr / LD r,(IX+d) etc.
    if (n === 0x21) {
      const nn = imm16(bytes, addr + 2);
      if (nn === null) return dbAt(a, op);
      return line(a, [...pref, n, bytes[addr + 2]!, bytes[addr + 3]!], `LD ${xy},${hex4(nn)}h`);
    }
    if (n === 0x22 || n === 0x2a) {
      const nn = imm16(bytes, addr + 2);
      if (nn === null) return dbAt(a, op);
      const raw = [...pref, n, bytes[addr + 2]!, bytes[addr + 3]!];
      return line(a, raw, n === 0x22 ? `LD (${hex4(nn)}h),${xy}` : `LD ${xy},(${hex4(nn)}h)`);
    }
    if (n === 0x23) return line(a, [...pref, n], `INC ${xy}`);
    if (n === 0x2b) return line(a, [...pref, n], `DEC ${xy}`);
    if (n === 0xe1) return line(a, [...pref, n], `POP ${xy}`);
    if (n === 0xe5) return line(a, [...pref, n], `PUSH ${xy}`);
    if (n === 0xe3) return line(a, [...pref, n], `EX (SP),${xy}`);
    if (n === 0xe9) return line(a, [...pref, n], `JP (${xy})`);
    if (n === 0xf9) return line(a, [...pref, n], `LD SP,${xy}`);
    if ((n & 0xcf) === 0x09) {
      const p = (n >> 4) & 3;
      const rr = p === 2 ? xy : RP[p]!;
      return line(a, [...pref, n], `ADD ${xy},${rr}`);
    }
    // LD r,(IX+d) / LD (IX+d),r / ALU A,(IX+d) / INC/DEC (IX+d)
    if ((n & 0xc7) === 0x46 || (n & 0xf8) === 0x70 || (n & 0xc7) === 0x86 || n === 0x34 || n === 0x35 || n === 0x36) {
      const d = imm8(bytes, addr + 2);
      if (d === null) return dbAt(a, op);
      const disp = d > 127 ? d - 256 : d;
      const mem = `(${xy}${disp >= 0 ? '+' : ''}${disp})`;
      if (n === 0x34) return line(a, [...pref, n, d], `INC ${mem}`);
      if (n === 0x35) return line(a, [...pref, n, d], `DEC ${mem}`);
      if (n === 0x36) {
        const imm = imm8(bytes, addr + 3);
        if (imm === null) return dbAt(a, op);
        return line(a, [...pref, n, d, imm], `LD ${mem},${hex2(imm)}h`);
      }
      if ((n & 0xf8) === 0x70) {
        const z = n & 7;
        if (z === 6) return line(a, [...pref, n, d], `DB ${hex2(op)}h,${hex2(n)}h`); // HALT clash
        return line(a, [...pref, n, d], `LD ${mem},${R8[z]!}`);
      }
      if ((n & 0xc7) === 0x46) {
        const y = (n >> 3) & 7;
        return line(a, [...pref, n, d], `LD ${R8[y]!},${mem}`);
      }
      if ((n & 0xc7) === 0x86) {
        const y = (n >> 3) & 7;
        return line(a, [...pref, n, d], `${ALU[y]!}${mem}`);
      }
    }
    // H/L → IXH/IXL style 8-bit (undocumented but used)
    if ((n & 0xc0) === 0x40 && (n & 7) !== 6 && ((n >> 3) & 7) !== 6) {
      const y = (n >> 3) & 7;
      const z = n & 7;
      const mapR = (r: number): string =>
        r === 4 ? `${xy}H` : r === 5 ? `${xy}L` : R8[r]!;
      return line(a, [...pref, n], `LD ${mapR(y)},${mapR(z)}`);
    }
    return line(a, [...pref, n], `DB ${hex2(op)}h,${hex2(n)}h`);
  }

  // --- Unprefixed ---
  const x = (op >> 6) & 3;
  const y = (op >> 3) & 7;
  const z = op & 7;
  const p = (y >> 1) & 3;
  const q = y & 1;

  if (op === 0x00) return line(a, [op], 'NOP');
  if (op === 0x08) return line(a, [op], "EX AF,AF'");
  if (op === 0x10) {
    const d = imm8(bytes, addr + 1);
    if (d === null) return dbAt(a, op);
    return line(a, [op, d], `DJNZ ${hex4(relTarget(a, 2, d))}h`);
  }
  if (op === 0x18) {
    const d = imm8(bytes, addr + 1);
    if (d === null) return dbAt(a, op);
    return line(a, [op, d], `JR ${hex4(relTarget(a, 2, d))}h`);
  }
  if (op === 0x20 || op === 0x28 || op === 0x30 || op === 0x38) {
    const d = imm8(bytes, addr + 1);
    if (d === null) return dbAt(a, op);
    const cc = ['NZ', 'Z', 'NC', 'C'][(op >> 3) & 3]!;
    return line(a, [op, d], `JR ${cc},${hex4(relTarget(a, 2, d))}h`);
  }
  if (op === 0x01 || op === 0x11 || op === 0x21 || op === 0x31) {
    const nn = imm16(bytes, addr + 1);
    if (nn === null) return dbAt(a, op);
    return line(a, [op, bytes[addr + 1]!, bytes[addr + 2]!], `LD ${RP[p]!},${hex4(nn)}h`);
  }
  if (op === 0x02) return line(a, [op], 'LD (BC),A');
  if (op === 0x12) return line(a, [op], 'LD (DE),A');
  if (op === 0x0a) return line(a, [op], 'LD A,(BC)');
  if (op === 0x1a) return line(a, [op], 'LD A,(DE)');
  if (op === 0x22 || op === 0x2a) {
    const nn = imm16(bytes, addr + 1);
    if (nn === null) return dbAt(a, op);
    const raw = [op, bytes[addr + 1]!, bytes[addr + 2]!];
    return line(a, raw, op === 0x22 ? `LD (${hex4(nn)}h),HL` : `LD HL,(${hex4(nn)}h)`);
  }
  if (op === 0x32 || op === 0x3a) {
    const nn = imm16(bytes, addr + 1);
    if (nn === null) return dbAt(a, op);
    const raw = [op, bytes[addr + 1]!, bytes[addr + 2]!];
    return line(a, raw, op === 0x32 ? `LD (${hex4(nn)}h),A` : `LD A,(${hex4(nn)}h)`);
  }
  if ((op & 0xcf) === 0x03) return line(a, [op], `INC ${RP[p]!}`);
  if ((op & 0xcf) === 0x0b) return line(a, [op], `DEC ${RP[p]!}`);
  if ((op & 0xcf) === 0x09) return line(a, [op], `ADD HL,${RP[p]!}`);
  if ((op & 0xc7) === 0x04) return line(a, [op], `INC ${R8[y]!}`);
  if ((op & 0xc7) === 0x05) return line(a, [op], `DEC ${R8[y]!}`);
  if ((op & 0xc7) === 0x06) {
    const n = imm8(bytes, addr + 1);
    if (n === null) return dbAt(a, op);
    return line(a, [op, n], `LD ${R8[y]!},${hex2(n)}h`);
  }
  if (op === 0x07) return line(a, [op], 'RLCA');
  if (op === 0x0f) return line(a, [op], 'RRCA');
  if (op === 0x17) return line(a, [op], 'RLA');
  if (op === 0x1f) return line(a, [op], 'RRA');
  if (op === 0x27) return line(a, [op], 'DAA');
  if (op === 0x2f) return line(a, [op], 'CPL');
  if (op === 0x37) return line(a, [op], 'SCF');
  if (op === 0x3f) return line(a, [op], 'CCF');
  if (op === 0x76) return line(a, [op], 'HALT');
  if (x === 1) return line(a, [op], `LD ${R8[y]!},${R8[z]!}`);
  if (x === 2) return line(a, [op], `${ALU[y]!}${R8[z]!}`);
  if (x === 3) {
    if (z === 0) return line(a, [op], `RET ${CC[y]!}`);
    if (z === 1) {
      if (q === 0) return line(a, [op], `POP ${RP2[p]!}`);
      if (p === 0) return line(a, [op], 'RET');
      if (p === 1) return line(a, [op], 'EXX');
      if (p === 2) return line(a, [op], 'JP (HL)');
      return line(a, [op], 'LD SP,HL');
    }
    if (z === 2) {
      const nn = imm16(bytes, addr + 1);
      if (nn === null) return dbAt(a, op);
      return line(a, [op, bytes[addr + 1]!, bytes[addr + 2]!], `JP ${CC[y]!},${hex4(nn)}h`);
    }
    if (z === 3) {
      if (y === 0) {
        const nn = imm16(bytes, addr + 1);
        if (nn === null) return dbAt(a, op);
        return line(a, [op, bytes[addr + 1]!, bytes[addr + 2]!], `JP ${hex4(nn)}h`);
      }
      if (y === 2) {
        const n = imm8(bytes, addr + 1);
        if (n === null) return dbAt(a, op);
        return line(a, [op, n], `OUT (${hex2(n)}h),A`);
      }
      if (y === 3) {
        const n = imm8(bytes, addr + 1);
        if (n === null) return dbAt(a, op);
        return line(a, [op, n], `IN A,(${hex2(n)}h)`);
      }
      if (y === 4) return line(a, [op], 'EX (SP),HL');
      if (y === 5) return line(a, [op], 'EX DE,HL');
      if (y === 6) return line(a, [op], 'DI');
      if (y === 7) return line(a, [op], 'EI');
    }
    if (z === 4) {
      const nn = imm16(bytes, addr + 1);
      if (nn === null) return dbAt(a, op);
      return line(a, [op, bytes[addr + 1]!, bytes[addr + 2]!], `CALL ${CC[y]!},${hex4(nn)}h`);
    }
    if (z === 5) {
      if (q === 0) return line(a, [op], `PUSH ${RP2[p]!}`);
      if (p === 0) {
        const nn = imm16(bytes, addr + 1);
        if (nn === null) return dbAt(a, op);
        return line(a, [op, bytes[addr + 1]!, bytes[addr + 2]!], `CALL ${hex4(nn)}h`);
      }
    }
    if (z === 6) {
      const n = imm8(bytes, addr + 1);
      if (n === null) return dbAt(a, op);
      return line(a, [op, n], `${ALU[y]!}${hex2(n)}h`);
    }
    if (z === 7) return line(a, [op], `RST ${hex2(y * 8)}h`);
  }

  return dbAt(a, op);
}

/** Disassemble a run of instructions starting at `addr`. */
export function disassemble(
  bytes: Uint8Array,
  addr: number,
  opts: DisasmOptions = {},
): DisasmLine[] {
  const maxCount = opts.count ?? 32;
  const maxBytes = opts.maxBytes ?? bytes.length;
  const out: DisasmLine[] = [];
  let pc = Math.max(0, Math.min(addr, bytes.length));
  const end = Math.min(bytes.length, pc + maxBytes);
  while (out.length < maxCount && pc < end) {
    const d = disassembleOne(bytes, pc);
    if (d.size <= 0) break;
    out.push(d);
    pc += d.size;
  }
  return out;
}

/** Format disassembly lines for a textarea / listing. */
export function formatDisassembly(
  bytes: Uint8Array,
  addr: number,
  opts?: DisasmOptions,
): string {
  return disassemble(bytes, addr, opts).map(fmtLine).join('\n');
}

export function formatDisasmLine(d: DisasmLine): string {
  return fmtLine(d);
}
