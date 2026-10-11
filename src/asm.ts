/**
 * Minimal RV32I instruction encoder — just enough to hand-assemble small test
 * programs until we hook up a real toolchain. Registers are plain numbers (x0..x31).
 */

const r = (f7: number, rs2: number, rs1: number, f3: number, rd: number, op: number) =>
  ((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op) >>> 0

const i = (imm: number, rs1: number, f3: number, rd: number, op: number) =>
  (((imm & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op) >>> 0

const s = (imm: number, rs2: number, rs1: number, f3: number, op: number) =>
  ((((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((imm & 0x1f) << 7) | op) >>> 0

const b = (imm: number, rs2: number, rs1: number, f3: number) =>
  ((((imm >> 12) & 1) << 31) |
    (((imm >> 5) & 0x3f) << 25) |
    (rs2 << 20) |
    (rs1 << 15) |
    (f3 << 12) |
    (((imm >> 1) & 0xf) << 8) |
    (((imm >> 11) & 1) << 7) |
    0x63) >>>
  0

const u = (imm: number, rd: number, op: number) => ((imm & 0xfffff000) | (rd << 7) | op) >>> 0

const j = (imm: number, rd: number) =>
  ((((imm >> 20) & 1) << 31) |
    (((imm >> 1) & 0x3ff) << 21) |
    (((imm >> 11) & 1) << 20) |
    (((imm >> 12) & 0xff) << 12) |
    (rd << 7) |
    0x6f) >>>
  0

export const asm = {
  lui: (rd: number, imm: number) => u(imm, rd, 0x37),
  auipc: (rd: number, imm: number) => u(imm, rd, 0x17),
  jal: (rd: number, off: number) => j(off, rd),
  jalr: (rd: number, rs1: number, off: number) => i(off, rs1, 0, rd, 0x67),

  beq: (rs1: number, rs2: number, off: number) => b(off, rs2, rs1, 0),
  bne: (rs1: number, rs2: number, off: number) => b(off, rs2, rs1, 1),
  blt: (rs1: number, rs2: number, off: number) => b(off, rs2, rs1, 4),
  bge: (rs1: number, rs2: number, off: number) => b(off, rs2, rs1, 5),
  bltu: (rs1: number, rs2: number, off: number) => b(off, rs2, rs1, 6),
  bgeu: (rs1: number, rs2: number, off: number) => b(off, rs2, rs1, 7),

  lb: (rd: number, rs1: number, off: number) => i(off, rs1, 0, rd, 0x03),
  lh: (rd: number, rs1: number, off: number) => i(off, rs1, 1, rd, 0x03),
  lw: (rd: number, rs1: number, off: number) => i(off, rs1, 2, rd, 0x03),
  lbu: (rd: number, rs1: number, off: number) => i(off, rs1, 4, rd, 0x03),
  lhu: (rd: number, rs1: number, off: number) => i(off, rs1, 5, rd, 0x03),
  sb: (rs2: number, rs1: number, off: number) => s(off, rs2, rs1, 0, 0x23),
  sh: (rs2: number, rs1: number, off: number) => s(off, rs2, rs1, 1, 0x23),
  sw: (rs2: number, rs1: number, off: number) => s(off, rs2, rs1, 2, 0x23),

  addi: (rd: number, rs1: number, imm: number) => i(imm, rs1, 0, rd, 0x13),
  slti: (rd: number, rs1: number, imm: number) => i(imm, rs1, 2, rd, 0x13),
  sltiu: (rd: number, rs1: number, imm: number) => i(imm, rs1, 3, rd, 0x13),
  xori: (rd: number, rs1: number, imm: number) => i(imm, rs1, 4, rd, 0x13),
  ori: (rd: number, rs1: number, imm: number) => i(imm, rs1, 6, rd, 0x13),
  andi: (rd: number, rs1: number, imm: number) => i(imm, rs1, 7, rd, 0x13),
  slli: (rd: number, rs1: number, sh: number) => i(sh, rs1, 1, rd, 0x13),
  srli: (rd: number, rs1: number, sh: number) => i(sh, rs1, 5, rd, 0x13),
  srai: (rd: number, rs1: number, sh: number) => i(0x400 | sh, rs1, 5, rd, 0x13),

  add: (rd: number, rs1: number, rs2: number) => r(0x00, rs2, rs1, 0, rd, 0x33),
  sub: (rd: number, rs1: number, rs2: number) => r(0x20, rs2, rs1, 0, rd, 0x33),
  sll: (rd: number, rs1: number, rs2: number) => r(0x00, rs2, rs1, 1, rd, 0x33),
  slt: (rd: number, rs1: number, rs2: number) => r(0x00, rs2, rs1, 2, rd, 0x33),
  sltu: (rd: number, rs1: number, rs2: number) => r(0x00, rs2, rs1, 3, rd, 0x33),
  xor: (rd: number, rs1: number, rs2: number) => r(0x00, rs2, rs1, 4, rd, 0x33),
  srl: (rd: number, rs1: number, rs2: number) => r(0x00, rs2, rs1, 5, rd, 0x33),
  sra: (rd: number, rs1: number, rs2: number) => r(0x20, rs2, rs1, 5, rd, 0x33),
  or: (rd: number, rs1: number, rs2: number) => r(0x00, rs2, rs1, 6, rd, 0x33),
  and: (rd: number, rs1: number, rs2: number) => r(0x00, rs2, rs1, 7, rd, 0x33),

  // RV32M
  mul: (rd: number, rs1: number, rs2: number) => r(0x01, rs2, rs1, 0, rd, 0x33),
  mulh: (rd: number, rs1: number, rs2: number) => r(0x01, rs2, rs1, 1, rd, 0x33),
  mulhsu: (rd: number, rs1: number, rs2: number) => r(0x01, rs2, rs1, 2, rd, 0x33),
  mulhu: (rd: number, rs1: number, rs2: number) => r(0x01, rs2, rs1, 3, rd, 0x33),
  div: (rd: number, rs1: number, rs2: number) => r(0x01, rs2, rs1, 4, rd, 0x33),
  divu: (rd: number, rs1: number, rs2: number) => r(0x01, rs2, rs1, 5, rd, 0x33),
  rem: (rd: number, rs1: number, rs2: number) => r(0x01, rs2, rs1, 6, rd, 0x33),
  remu: (rd: number, rs1: number, rs2: number) => r(0x01, rs2, rs1, 7, rd, 0x33),

  // RV32A (aq/rl bits clear). Operand order follows assembly: rd, rs2, (rs1).
  lrw: (rd: number, rs1: number) => r(0b00010 << 2, 0, rs1, 2, rd, 0x2f),
  scw: (rd: number, rs2: number, rs1: number) => r(0b00011 << 2, rs2, rs1, 2, rd, 0x2f),
  amoswapw: (rd: number, rs2: number, rs1: number) => r(0b00001 << 2, rs2, rs1, 2, rd, 0x2f),
  amoaddw: (rd: number, rs2: number, rs1: number) => r(0b00000 << 2, rs2, rs1, 2, rd, 0x2f),
  amoxorw: (rd: number, rs2: number, rs1: number) => r(0b00100 << 2, rs2, rs1, 2, rd, 0x2f),
  amoandw: (rd: number, rs2: number, rs1: number) => r(0b01100 << 2, rs2, rs1, 2, rd, 0x2f),
  amoorw: (rd: number, rs2: number, rs1: number) => r(0b01000 << 2, rs2, rs1, 2, rd, 0x2f),
  amominw: (rd: number, rs2: number, rs1: number) => r(0b10000 << 2, rs2, rs1, 2, rd, 0x2f),
  amomaxw: (rd: number, rs2: number, rs1: number) => r(0b10100 << 2, rs2, rs1, 2, rd, 0x2f),
  amominuw: (rd: number, rs2: number, rs1: number) => r(0b11000 << 2, rs2, rs1, 2, rd, 0x2f),
  amomaxuw: (rd: number, rs2: number, rs1: number) => r(0b11100 << 2, rs2, rs1, 2, rd, 0x2f),

  // Zicsr
  csrrw: (rd: number, csr: number, rs1: number) => i(csr, rs1, 1, rd, 0x73),
  csrrs: (rd: number, csr: number, rs1: number) => i(csr, rs1, 2, rd, 0x73),
  csrrc: (rd: number, csr: number, rs1: number) => i(csr, rs1, 3, rd, 0x73),
  csrrwi: (rd: number, csr: number, uimm: number) => i(csr, uimm, 5, rd, 0x73),
  csrrsi: (rd: number, csr: number, uimm: number) => i(csr, uimm, 6, rd, 0x73),
  csrrci: (rd: number, csr: number, uimm: number) => i(csr, uimm, 7, rd, 0x73),

  fence: () => 0x0ff0000f,
  ecall: () => 0x00000073,
  ebreak: () => 0x00100073,
  mret: () => 0x30200073,
  sret: () => 0x10200073,
  wfi: () => 0x10500073,
  sfenceVma: (rs1 = 0, rs2 = 0) => r(0x09, rs2, rs1, 0, 0, 0x73),
}

/** Serialize instruction words to little-endian bytes, ready for RAM.load(). */
export function toBytes(words: number[]): Uint8Array {
  const out = new Uint8Array(words.length * 4)
  const view = new DataView(out.buffer)
  words.forEach((w, n) => view.setUint32(n * 4, w, true))
  return out
}

/**
 * Like toBytes, for a mix of 32-bit and compressed (16-bit) instructions: each
 * takes as many bytes as its low two bits say (11: four, otherwise two).
 */
export function toCode(insts: number[]): Uint8Array {
  const out: number[] = []
  for (const inst of insts) {
    const length = (inst & 3) === 3 ? 4 : 2
    for (let i = 0; i < length; i++) out.push((inst >>> (8 * i)) & 0xff)
  }
  return Uint8Array.from(out)
}
