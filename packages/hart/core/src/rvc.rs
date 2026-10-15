//! The C extension: 16-bit compressed instructions (RV64C, with the
//! double-precision loads and stores).
//!
//! Every compressed instruction is a short form of a 32-bit one, so it's
//! executed by expanding it into that and running the regular decoder; only
//! the next pc differs (pc + 2).

use core::cell::UnsafeCell;

/// Every 16-bit instruction's 32-bit equivalent, by encoding (0: illegal; no
/// expansion is 0, they all end in binary 11), so executing one is a lookup.
/// Zero-initialized, so it takes no space in the .wasm file.
struct Table(UnsafeCell<[u32; 1 << 16]>);
// SAFETY: WebAssembly instances are single-threaded.
unsafe impl Sync for Table {}
static TABLE: Table = Table(UnsafeCell::new([0; 1 << 16]));

/// Fill the table (once per instance, before running anything).
pub fn fill_table() {
    // SAFETY: single-threaded, and nothing else holds a reference to it.
    let table = unsafe { &mut *TABLE.0.get() };
    for c in 0..1 << 16 {
        table[c as usize] = expand(c).unwrap_or(0);
    }
}

/// The 32-bit equivalent of compressed instruction `c`, or 0 if illegal.
#[inline(always)]
pub fn expanded(c: u32) -> u32 {
    // SAFETY: only written by fill_table, never while this runs.
    unsafe { (*TABLE.0.get())[c as usize & 0xffff] }
}

/// Expand a 16-bit instruction (low two bits not 11) into its 32-bit
/// equivalent. None for illegal and reserved encodings.
pub fn expand(c: u32) -> Option<u32> {
    let funct3 = c >> 13;
    // Register fields: full 5-bit ones, and the 3-bit ones that name x8..x15.
    let rd = (c >> 7) & 0x1f;
    let rs2 = (c >> 2) & 0x1f;
    let rd_ = 8 + ((c >> 2) & 7); // rd' / rs2' in bits 4:2
    let rs1_ = 8 + ((c >> 7) & 7); // rs1' / rd' in bits 9:7

    Some(match (c & 3, funct3) {
        // Quadrant 0
        (0, 0b000) => {
            // C.ADDI4SPN: addi rd', x2, nzuimm (0 is illegal, which also makes 0x0000 illegal)
            let imm = bits(c, 10, 7) << 6 | bits(c, 12, 11) << 4 | bits(c, 5, 5) << 3 | bits(c, 6, 6) << 2;
            if imm == 0 {
                return None;
            }
            i_type(OP_IMM, rd_, 0, 2, imm as i32)
        }
        (0, 0b010) => i_type(LOAD, rd_, 0b010, rs1_, lw_offset(c)),          // C.LW
        (0, 0b110) => s_type(STORE, 0b010, rs1_, rd_, lw_offset(c)),         // C.SW
        (0, 0b011) => i_type(LOAD, rd_, 0b011, rs1_, ld_offset(c)),          // C.LD
        (0, 0b111) => s_type(STORE, 0b011, rs1_, rd_, ld_offset(c)),         // C.SD
        (0, 0b001) => i_type(LOAD_FP, rd_, 0b011, rs1_, ld_offset(c)),       // C.FLD
        (0, 0b101) => s_type(STORE_FP, 0b011, rs1_, rd_, ld_offset(c)),      // C.FSD

        // Quadrant 1
        (1, 0b000) => i_type(OP_IMM, rd, 0, rd, ci_imm(c)), // C.ADDI (C.NOP for rd = 0)
        (1, 0b001) => {
            // C.ADDIW (rd = 0 is reserved)
            if rd == 0 {
                return None;
            }
            i_type(OP_IMM_32, rd, 0, rd, ci_imm(c))
        }
        (1, 0b010) => i_type(OP_IMM, rd, 0, 0, ci_imm(c)),  // C.LI
        (1, 0b011) if rd == 2 => {
            // C.ADDI16SP: addi x2, x2, nzimm
            let imm = sext(
                bits(c, 12, 12) << 9 | bits(c, 4, 3) << 7 | bits(c, 5, 5) << 6 | bits(c, 2, 2) << 5 | bits(c, 6, 6) << 4,
                10,
            );
            if imm == 0 {
                return None;
            }
            i_type(OP_IMM, 2, 0, 2, imm)
        }
        (1, 0b011) => {
            // C.LUI: lui rd, nzimm
            let imm = ci_imm(c);
            if imm == 0 {
                return None;
            }
            (imm as u32) << 12 | rd << 7 | LUI
        }
        (1, 0b100) => match bits(c, 11, 10) {
            // C.SRLI / C.SRAI
            0b00 | 0b01 => {
                let funct = if bits(c, 11, 10) == 0b01 { 0x400 } else { 0 }; // SRAI: imm[10]
                i_type(OP_IMM, rs1_, 0b101, rs1_, (funct | shamt(c)) as i32)
            }
            0b10 => i_type(OP_IMM, rs1_, 0b111, rs1_, ci_imm(c)), // C.ANDI
            0b11 if bits(c, 12, 12) == 0 => {
                let (funct7, funct3) = match bits(c, 6, 5) {
                    0b00 => (0x20, 0b000), // C.SUB
                    0b01 => (0, 0b100),    // C.XOR
                    0b10 => (0, 0b110),    // C.OR
                    _ => (0, 0b111),       // C.AND
                };
                r_type(OP, funct7, rd_, rs1_, funct3, rs1_)
            }
            0b11 if bits(c, 6, 6) == 0 => {
                let funct7 = if bits(c, 5, 5) == 0 { 0x20 } else { 0 }; // C.SUBW / C.ADDW
                r_type(OP_32, funct7, rd_, rs1_, 0, rs1_)
            }
            _ => return None, // reserved encodings
        },
        (1, 0b101) => j_type(0, cj_offset(c)),          // C.J
        (1, 0b110) => b_type(0b000, rs1_, 0, cb_offset(c)), // C.BEQZ
        (1, 0b111) => b_type(0b001, rs1_, 0, cb_offset(c)), // C.BNEZ

        // Quadrant 2
        (2, 0b000) => i_type(OP_IMM, rd, 0b001, rd, shamt(c) as i32),                // C.SLLI
        (2, 0b010) if rd != 0 => i_type(LOAD, rd, 0b010, 2, lwsp_offset(c)),         // C.LWSP
        (2, 0b011) if rd != 0 => i_type(LOAD, rd, 0b011, 2, ldsp_offset(c)),         // C.LDSP
        (2, 0b001) => i_type(LOAD_FP, rd, 0b011, 2, ldsp_offset(c)),                 // C.FLDSP
        (2, 0b100) => match (bits(c, 12, 12), rd, rs2) {
            (0, 0, 0) => return None,                  // reserved
            (0, _, 0) => i_type(JALR, 0, 0, rd, 0),    // C.JR
            (0, _, _) => r_type(OP, 0, rs2, 0, 0, rd), // C.MV
            (_, 0, 0) => EBREAK,                       // C.EBREAK
            (_, _, 0) => i_type(JALR, 1, 0, rd, 0),    // C.JALR
            (_, _, _) => r_type(OP, 0, rs2, rd, 0, rd), // C.ADD
        },
        (2, 0b110) => s_type(STORE, 0b010, 2, rs2, swsp_offset(c)),          // C.SWSP
        (2, 0b111) => s_type(STORE, 0b011, 2, rs2, sdsp_offset(c)),          // C.SDSP
        (2, 0b101) => s_type(STORE_FP, 0b011, 2, rs2, sdsp_offset(c)),       // C.FSDSP

        _ => return None,
    })
}

const LOAD: u32 = 0x03;
const LOAD_FP: u32 = 0x07;
const OP_IMM: u32 = 0x13;
const OP_IMM_32: u32 = 0x1b;
const STORE: u32 = 0x23;
const STORE_FP: u32 = 0x27;
const OP: u32 = 0x33;
const OP_32: u32 = 0x3b;
const LUI: u32 = 0x37;
const BRANCH: u32 = 0x63;
const JALR: u32 = 0x67;
const JAL: u32 = 0x6f;
const EBREAK: u32 = 0x00100073;

/// Bits hi..=lo of `c`, shifted down.
const fn bits(c: u32, hi: u32, lo: u32) -> u32 {
    (c >> lo) & ((1 << (hi - lo + 1)) - 1)
}

/// Sign-extend the low `width` bits.
const fn sext(value: u32, width: u32) -> i32 {
    ((value << (32 - width)) as i32) >> (32 - width)
}

// Immediates of the compressed formats.

/// CI: imm[5] in bit 12, imm[4:0] in bits 6:2 (signed).
const fn ci_imm(c: u32) -> i32 {
    sext(bits(c, 12, 12) << 5 | bits(c, 6, 2), 6)
}

/// Shift amount: shamt[5] in bit 12 (RV64 only), shamt[4:0] in bits 6:2.
const fn shamt(c: u32) -> u32 {
    bits(c, 12, 12) << 5 | bits(c, 6, 2)
}

/// C.LD / C.SD: uimm[5:3] in bits 12:10, uimm[7:6] in bits 6:5.
const fn ld_offset(c: u32) -> i32 {
    (bits(c, 6, 5) << 6 | bits(c, 12, 10) << 3) as i32
}

/// C.LWSP / C.FLWSP: uimm[5] in bit 12, uimm[4:2] in bits 6:4, uimm[7:6] in bits 3:2.
const fn lwsp_offset(c: u32) -> i32 {
    (bits(c, 3, 2) << 6 | bits(c, 12, 12) << 5 | bits(c, 6, 4) << 2) as i32
}

/// C.LDSP / C.FLDSP: uimm[5] in bit 12, uimm[4:3] in bits 6:5, uimm[8:6] in bits 4:2.
const fn ldsp_offset(c: u32) -> i32 {
    (bits(c, 4, 2) << 6 | bits(c, 12, 12) << 5 | bits(c, 6, 5) << 3) as i32
}

/// C.SWSP / C.FSWSP: uimm[5:2] in bits 12:9, uimm[7:6] in bits 8:7.
const fn swsp_offset(c: u32) -> i32 {
    (bits(c, 8, 7) << 6 | bits(c, 12, 9) << 2) as i32
}

/// C.SDSP / C.FSDSP: uimm[5:3] in bits 12:10, uimm[8:6] in bits 9:7.
const fn sdsp_offset(c: u32) -> i32 {
    (bits(c, 9, 7) << 6 | bits(c, 12, 10) << 3) as i32
}

/// C.LW / C.SW: uimm[5:3] in bits 12:10, uimm[2] in bit 6, uimm[6] in bit 5.
const fn lw_offset(c: u32) -> i32 {
    (bits(c, 5, 5) << 6 | bits(c, 12, 10) << 3 | bits(c, 6, 6) << 2) as i32
}

/// CJ: offset[11|4|9:8|10|6|7|3:1|5] in bits 12:2.
const fn cj_offset(c: u32) -> i32 {
    sext(
        bits(c, 12, 12) << 11
            | bits(c, 8, 8) << 10
            | bits(c, 10, 9) << 8
            | bits(c, 6, 6) << 7
            | bits(c, 7, 7) << 6
            | bits(c, 2, 2) << 5
            | bits(c, 11, 11) << 4
            | bits(c, 5, 3) << 1,
        12,
    )
}

/// CB: offset[8|4:3] in bits 12:10, offset[7:6|2:1|5] in bits 6:2.
const fn cb_offset(c: u32) -> i32 {
    sext(
        bits(c, 12, 12) << 8 | bits(c, 6, 5) << 6 | bits(c, 2, 2) << 5 | bits(c, 11, 10) << 3 | bits(c, 4, 3) << 1,
        9,
    )
}

// Encoders of the 32-bit formats.

const fn i_type(opcode: u32, rd: u32, funct3: u32, rs1: u32, imm: i32) -> u32 {
    (imm as u32) << 20 | rs1 << 15 | funct3 << 12 | rd << 7 | opcode
}

const fn s_type(opcode: u32, funct3: u32, rs1: u32, rs2: u32, imm: i32) -> u32 {
    let imm = imm as u32;
    (imm >> 5 & 0x7f) << 25 | rs2 << 20 | rs1 << 15 | funct3 << 12 | (imm & 0x1f) << 7 | opcode
}

const fn r_type(opcode: u32, funct7: u32, rs2: u32, rs1: u32, funct3: u32, rd: u32) -> u32 {
    funct7 << 25 | rs2 << 20 | rs1 << 15 | funct3 << 12 | rd << 7 | opcode
}

const fn b_type(funct3: u32, rs1: u32, rs2: u32, imm: i32) -> u32 {
    let imm = imm as u32;
    (imm >> 12 & 1) << 31
        | (imm >> 5 & 0x3f) << 25
        | rs2 << 20
        | rs1 << 15
        | funct3 << 12
        | (imm >> 1 & 0xf) << 8
        | (imm >> 11 & 1) << 7
        | BRANCH
}

const fn j_type(rd: u32, imm: i32) -> u32 {
    let imm = imm as u32;
    (imm >> 20 & 1) << 31 | (imm >> 1 & 0x3ff) << 21 | (imm >> 11 & 1) << 20 | (imm >> 12 & 0xff) << 12 | rd << 7 | JAL
}

#[cfg(test)]
mod tests {
    use super::expand;

    /// (compressed, expanded) as encoded by GNU as 2.47: each line assembled
    /// once with `.option rvc` and once, spelled as the 32-bit instruction it
    /// stands for, with `.option norvc`. Covers every instruction and the
    /// extremes of every immediate.
    const GNU_AS: &[(u32, u32, &str)] = &[
        (0x0040, 0x00410413, "c.addi4spn s0, sp, 4"),
        (0x1ffc, 0x3fc10793, "c.addi4spn a5, sp, 1020"),
        (0x0408, 0x20010513, "c.addi4spn a0, sp, 512"),
        (0x4088, 0x0004a503, "c.lw a0, 0(s1)"),
        (0x5ffc, 0x07c7a783, "c.lw a5, 124(a5)"),
        (0x4220, 0x04062403, "c.lw s0, 64(a2)"),
        (0x414c, 0x00452583, "c.lw a1, 4(a0)"),
        (0xc088, 0x00a4a023, "c.sw a0, 0(s1)"),
        (0xdffc, 0x06f7ae23, "c.sw a5, 124(a5)"),
        (0xc220, 0x04862023, "c.sw s0, 64(a2)"),
        (0xc14c, 0x00b52223, "c.sw a1, 4(a0)"),
        (0x0001, 0x00000013, "c.nop"),
        (0x1501, 0xfe050513, "c.addi a0, -32"),
        (0x057d, 0x01f50513, "c.addi a0, 31"),
        (0x0085, 0x00108093, "c.addi ra, 1"),
        (0x117d, 0xfff10113, "c.addi sp, -1"),
        (0x5501, 0xfe000513, "c.li a0, -32"),
        (0x4ffd, 0x01f00f93, "c.li t6, 31"),
        (0x4005, 0x00100013, "c.li zero, 1"),
        (0x7101, 0xe0010113, "c.addi16sp sp, -512"),
        (0x617d, 0x1f010113, "c.addi16sp sp, 496"),
        (0x6141, 0x01010113, "c.addi16sp sp, 16"),
        (0x717d, 0xff010113, "c.addi16sp sp, -16"),
        (0x6505, 0x00001537, "c.lui a0, 1"),
        (0x7281, 0xfffe02b7, "c.lui t0, 0xfffe0"),
        (0x64fd, 0x0001f4b7, "c.lui s1, 31"),
        (0x7ffd, 0xffffffb7, "c.lui t6, 0xfffff"),
        (0x8005, 0x00145413, "c.srli s0, 1"),
        (0x83fd, 0x01f7d793, "c.srli a5, 31"),
        (0x857d, 0x41f55513, "c.srai a0, 31"),
        (0x849d, 0x4074d493, "c.srai s1, 7"),
        (0x9881, 0xfe04f493, "c.andi s1, -32"),
        (0x897d, 0x01f57513, "c.andi a0, 31"),
        (0x8c05, 0x40940433, "c.sub s0, s1"),
        (0x8f3d, 0x00f74733, "c.xor a4, a5"),
        (0x8e55, 0x00d66633, "c.or a2, a3"),
        (0x8d6d, 0x00b57533, "c.and a0, a1"),
        (0xb001, 0x801ff06f, "c.j .-2048"),
        (0xaffd, 0x7fe0006f, "c.j .+2046"),
        (0xa009, 0x0020006f, "c.j .+2"),
        (0xd001, 0xf00400e3, "c.beqz s0, .-256"),
        (0xcc7d, 0x0e040f63, "c.beqz s0, .+254"),
        (0xe389, 0x00079163, "c.bnez a5, .+2"),
        (0xfffd, 0xfe079fe3, "c.bnez a5, .-2"),
        (0x0506, 0x00151513, "c.slli a0, 1"),
        (0x0ffe, 0x01ff9f93, "c.slli t6, 31"),
        (0x0096, 0x00509093, "c.slli ra, 5"),
        (0x4502, 0x00012503, "c.lwsp a0, 0(sp)"),
        (0x50fe, 0x0fc12083, "c.lwsp ra, 252(sp)"),
        (0x4f92, 0x00412f83, "c.lwsp t6, 4(sp)"),
        (0x8082, 0x00008067, "c.jr ra"),
        (0x8282, 0x00028067, "c.jr t0"),
        (0x852e, 0x00b00533, "c.mv a0, a1"),
        (0x8fa2, 0x00800fb3, "c.mv t6, s0"),
        (0x9002, 0x00100073, "c.ebreak"),
        (0x9502, 0x000500e7, "c.jalr a0"),
        (0x9f82, 0x000f80e7, "c.jalr t6"),
        (0x952e, 0x00b50533, "c.add a0, a1"),
        (0x917e, 0x01f10133, "c.add sp, t6"),
        (0xc02a, 0x00a12023, "c.swsp a0, 0(sp)"),
        (0xdf86, 0x0e112e23, "c.swsp ra, 252(sp)"),
        (0xc27e, 0x01f12223, "c.swsp t6, 4(sp)"),
    ];

    /// More from GNU as: immediates with one bit set at a time (positive and
    /// negative), so that each bit of every scrambled immediate field is
    /// checked to land in its place. (With all bits set at once, as above,
    /// two swapped bits would go unnoticed.)
    const GNU_AS_BITS: &[(u32, u32, &str)] = &[
        (0xa009, 0x0020006f, "c.j .+2"),
        (0xbffd, 0xfffff06f, "c.j .-2"),
        (0xa011, 0x0040006f, "c.j .+4"),
        (0xbff5, 0xffdff06f, "c.j .-4"),
        (0xa021, 0x0080006f, "c.j .+8"),
        (0xbfe5, 0xff9ff06f, "c.j .-8"),
        (0xa801, 0x0100006f, "c.j .+16"),
        (0xbfc5, 0xff1ff06f, "c.j .-16"),
        (0xa005, 0x0200006f, "c.j .+32"),
        (0xb7c5, 0xfe1ff06f, "c.j .-32"),
        (0xa081, 0x0400006f, "c.j .+64"),
        (0xb7c1, 0xfc1ff06f, "c.j .-64"),
        (0xa041, 0x0800006f, "c.j .+128"),
        (0xb741, 0xf81ff06f, "c.j .-128"),
        (0xa201, 0x1000006f, "c.j .+256"),
        (0xb701, 0xf01ff06f, "c.j .-256"),
        (0xa401, 0x2000006f, "c.j .+512"),
        (0xb501, 0xe01ff06f, "c.j .-512"),
        (0xa101, 0x4000006f, "c.j .+1024"),
        (0xb101, 0xc01ff06f, "c.j .-1024"),
        (0xc109, 0x00050163, "c.beqz a0, .+2"),
        (0xe089, 0x00049163, "c.bnez s1, .+2"),
        (0xdd7d, 0xfe050fe3, "c.beqz a0, .-2"),
        (0xfcfd, 0xfe049fe3, "c.bnez s1, .-2"),
        (0xc111, 0x00050263, "c.beqz a0, .+4"),
        (0xe091, 0x00049263, "c.bnez s1, .+4"),
        (0xdd75, 0xfe050ee3, "c.beqz a0, .-4"),
        (0xfcf5, 0xfe049ee3, "c.bnez s1, .-4"),
        (0xc501, 0x00050463, "c.beqz a0, .+8"),
        (0xe481, 0x00049463, "c.bnez s1, .+8"),
        (0xdd65, 0xfe050ce3, "c.beqz a0, .-8"),
        (0xfce5, 0xfe049ce3, "c.bnez s1, .-8"),
        (0xc901, 0x00050863, "c.beqz a0, .+16"),
        (0xe881, 0x00049863, "c.bnez s1, .+16"),
        (0xd965, 0xfe0508e3, "c.beqz a0, .-16"),
        (0xf8e5, 0xfe0498e3, "c.bnez s1, .-16"),
        (0xc105, 0x02050063, "c.beqz a0, .+32"),
        (0xe085, 0x02049063, "c.bnez s1, .+32"),
        (0xd165, 0xfe0500e3, "c.beqz a0, .-32"),
        (0xf0e5, 0xfe0490e3, "c.bnez s1, .-32"),
        (0xc121, 0x04050063, "c.beqz a0, .+64"),
        (0xe0a1, 0x04049063, "c.bnez s1, .+64"),
        (0xd161, 0xfc0500e3, "c.beqz a0, .-64"),
        (0xf0e1, 0xfc0490e3, "c.bnez s1, .-64"),
        (0xc141, 0x08050063, "c.beqz a0, .+128"),
        (0xe0c1, 0x08049063, "c.bnez s1, .+128"),
        (0xd141, 0xf80500e3, "c.beqz a0, .-128"),
        (0xf0c1, 0xf80490e3, "c.bnez s1, .-128"),
        (0x0050, 0x00410613, "c.addi4spn a2, sp, 4"),
        (0x0030, 0x00810613, "c.addi4spn a2, sp, 8"),
        (0x0810, 0x01010613, "c.addi4spn a2, sp, 16"),
        (0x1010, 0x02010613, "c.addi4spn a2, sp, 32"),
        (0x0090, 0x04010613, "c.addi4spn a2, sp, 64"),
        (0x0110, 0x08010613, "c.addi4spn a2, sp, 128"),
        (0x0210, 0x10010613, "c.addi4spn a2, sp, 256"),
        (0x0410, 0x20010613, "c.addi4spn a2, sp, 512"),
        (0x4354, 0x00472683, "c.lw a3, 4(a4)"),
        (0xc354, 0x00d72223, "c.sw a3, 4(a4)"),
        (0x4714, 0x00872683, "c.lw a3, 8(a4)"),
        (0xc714, 0x00d72423, "c.sw a3, 8(a4)"),
        (0x4b14, 0x01072683, "c.lw a3, 16(a4)"),
        (0xcb14, 0x00d72823, "c.sw a3, 16(a4)"),
        (0x5314, 0x02072683, "c.lw a3, 32(a4)"),
        (0xd314, 0x02d72023, "c.sw a3, 32(a4)"),
        (0x4334, 0x04072683, "c.lw a3, 64(a4)"),
        (0xc334, 0x04d72023, "c.sw a3, 64(a4)"),
        (0x4812, 0x00412803, "c.lwsp a6, 4(sp)"),
        (0xc242, 0x01012223, "c.swsp a6, 4(sp)"),
        (0x4822, 0x00812803, "c.lwsp a6, 8(sp)"),
        (0xc442, 0x01012423, "c.swsp a6, 8(sp)"),
        (0x4842, 0x01012803, "c.lwsp a6, 16(sp)"),
        (0xc842, 0x01012823, "c.swsp a6, 16(sp)"),
        (0x5802, 0x02012803, "c.lwsp a6, 32(sp)"),
        (0xd042, 0x03012023, "c.swsp a6, 32(sp)"),
        (0x4806, 0x04012803, "c.lwsp a6, 64(sp)"),
        (0xc0c2, 0x05012023, "c.swsp a6, 64(sp)"),
        (0x480a, 0x08012803, "c.lwsp a6, 128(sp)"),
        (0xc142, 0x09012023, "c.swsp a6, 128(sp)"),
        (0x6141, 0x01010113, "c.addi16sp sp, 16"),
        (0x717d, 0xff010113, "c.addi16sp sp, -16"),
        (0x6105, 0x02010113, "c.addi16sp sp, 32"),
        (0x713d, 0xfe010113, "c.addi16sp sp, -32"),
        (0x6121, 0x04010113, "c.addi16sp sp, 64"),
        (0x7139, 0xfc010113, "c.addi16sp sp, -64"),
        (0x6109, 0x08010113, "c.addi16sp sp, 128"),
        (0x7119, 0xf8010113, "c.addi16sp sp, -128"),
        (0x6111, 0x10010113, "c.addi16sp sp, 256"),
        (0x7111, 0xf0010113, "c.addi16sp sp, -256"),
        (0x7101, 0xe0010113, "c.addi16sp sp, -512"),
        (0x0305, 0x00130313, "c.addi t1, 1"),
        (0x4385, 0x00100393, "c.li t2, 1"),
        (0x8985, 0x0015f593, "c.andi a1, 1"),
        (0x6405, 0x00001437, "c.lui s0, 0x1"),
        (0x137d, 0xfff30313, "c.addi t1, -1"),
        (0x53fd, 0xfff00393, "c.li t2, -1"),
        (0x99fd, 0xfff5f593, "c.andi a1, -1"),
        (0x747d, 0xfffff437, "c.lui s0, 0xfffff"),
        (0x0309, 0x00230313, "c.addi t1, 2"),
        (0x4389, 0x00200393, "c.li t2, 2"),
        (0x8989, 0x0025f593, "c.andi a1, 2"),
        (0x6409, 0x00002437, "c.lui s0, 0x2"),
        (0x1379, 0xffe30313, "c.addi t1, -2"),
        (0x53f9, 0xffe00393, "c.li t2, -2"),
        (0x99f9, 0xffe5f593, "c.andi a1, -2"),
        (0x7479, 0xffffe437, "c.lui s0, 0xffffe"),
        (0x0311, 0x00430313, "c.addi t1, 4"),
        (0x4391, 0x00400393, "c.li t2, 4"),
        (0x8991, 0x0045f593, "c.andi a1, 4"),
        (0x6411, 0x00004437, "c.lui s0, 0x4"),
        (0x1371, 0xffc30313, "c.addi t1, -4"),
        (0x53f1, 0xffc00393, "c.li t2, -4"),
        (0x99f1, 0xffc5f593, "c.andi a1, -4"),
        (0x7471, 0xffffc437, "c.lui s0, 0xffffc"),
        (0x0321, 0x00830313, "c.addi t1, 8"),
        (0x43a1, 0x00800393, "c.li t2, 8"),
        (0x89a1, 0x0085f593, "c.andi a1, 8"),
        (0x6421, 0x00008437, "c.lui s0, 0x8"),
        (0x1361, 0xff830313, "c.addi t1, -8"),
        (0x53e1, 0xff800393, "c.li t2, -8"),
        (0x99e1, 0xff85f593, "c.andi a1, -8"),
        (0x7461, 0xffff8437, "c.lui s0, 0xffff8"),
        (0x0341, 0x01030313, "c.addi t1, 16"),
        (0x43c1, 0x01000393, "c.li t2, 16"),
        (0x89c1, 0x0105f593, "c.andi a1, 16"),
        (0x6441, 0x00010437, "c.lui s0, 0x10"),
        (0x1341, 0xff030313, "c.addi t1, -16"),
        (0x53c1, 0xff000393, "c.li t2, -16"),
        (0x99c1, 0xff05f593, "c.andi a1, -16"),
        (0x7441, 0xffff0437, "c.lui s0, 0xffff0"),
        (0x0886, 0x00189893, "c.slli a7, 1"),
        (0x8305, 0x00175713, "c.srli a4, 1"),
        (0x8785, 0x4017d793, "c.srai a5, 1"),
        (0x088a, 0x00289893, "c.slli a7, 2"),
        (0x8309, 0x00275713, "c.srli a4, 2"),
        (0x8789, 0x4027d793, "c.srai a5, 2"),
        (0x0892, 0x00489893, "c.slli a7, 4"),
        (0x8311, 0x00475713, "c.srli a4, 4"),
        (0x8791, 0x4047d793, "c.srai a5, 4"),
        (0x08a2, 0x00889893, "c.slli a7, 8"),
        (0x8321, 0x00875713, "c.srli a4, 8"),
        (0x87a1, 0x4087d793, "c.srai a5, 8"),
        (0x08c2, 0x01089893, "c.slli a7, 16"),
        (0x8341, 0x01075713, "c.srli a4, 16"),
        (0x87c1, 0x4107d793, "c.srai a5, 16"),
    ];

    /// The 64-bit loads, stores and arithmetic, and shifts by 32..63, from GNU as.
    const GNU_AS_RV64: &[(u32, u32, &str)] = &[
        (0x6714, 0x00873683, "c.ld a3, 8(a4)"),
        (0xe714, 0x00d73423, "c.sd a3, 8(a4)"),
        (0x6b14, 0x01073683, "c.ld a3, 16(a4)"),
        (0xeb14, 0x00d73823, "c.sd a3, 16(a4)"),
        (0x7314, 0x02073683, "c.ld a3, 32(a4)"),
        (0xf314, 0x02d73023, "c.sd a3, 32(a4)"),
        (0x6334, 0x04073683, "c.ld a3, 64(a4)"),
        (0xe334, 0x04d73023, "c.sd a3, 64(a4)"),
        (0x6354, 0x08073683, "c.ld a3, 128(a4)"),
        (0xe354, 0x08d73023, "c.sd a3, 128(a4)"),
        (0x7fe0, 0x0f87b403, "c.ld s0, 248(a5)"),
        (0xffe0, 0x0e87bc23, "c.sd s0, 248(a5)"),
        (0x6822, 0x00813803, "c.ldsp a6, 8(sp)"),
        (0xe442, 0x01013423, "c.sdsp a6, 8(sp)"),
        (0x6842, 0x01013803, "c.ldsp a6, 16(sp)"),
        (0xe842, 0x01013823, "c.sdsp a6, 16(sp)"),
        (0x7802, 0x02013803, "c.ldsp a6, 32(sp)"),
        (0xf042, 0x03013023, "c.sdsp a6, 32(sp)"),
        (0x6806, 0x04013803, "c.ldsp a6, 64(sp)"),
        (0xe0c2, 0x05013023, "c.sdsp a6, 64(sp)"),
        (0x680a, 0x08013803, "c.ldsp a6, 128(sp)"),
        (0xe142, 0x09013023, "c.sdsp a6, 128(sp)"),
        (0x6812, 0x10013803, "c.ldsp a6, 256(sp)"),
        (0xe242, 0x11013023, "c.sdsp a6, 256(sp)"),
        (0x70fe, 0x1f813083, "c.ldsp ra, 504(sp)"),
        (0xff86, 0x1e113c23, "c.sdsp ra, 504(sp)"),
        (0x6082, 0x00013083, "c.ldsp ra, 0(sp)"),
        (0x2305, 0x0013031b, "c.addiw t1, 1"),
        (0x337d, 0xfff3031b, "c.addiw t1, -1"),
        (0x2309, 0x0023031b, "c.addiw t1, 2"),
        (0x3379, 0xffe3031b, "c.addiw t1, -2"),
        (0x2311, 0x0043031b, "c.addiw t1, 4"),
        (0x3371, 0xffc3031b, "c.addiw t1, -4"),
        (0x2321, 0x0083031b, "c.addiw t1, 8"),
        (0x3361, 0xff83031b, "c.addiw t1, -8"),
        (0x2341, 0x0103031b, "c.addiw t1, 16"),
        (0x3341, 0xff03031b, "c.addiw t1, -16"),
        (0x2501, 0x0005051b, "c.addiw a0, 0"),
        (0x9c05, 0x4094043b, "c.subw s0, s1"),
        (0x9f3d, 0x00f7073b, "c.addw a4, a5"),
        (0x0886, 0x00189893, "c.slli a7, 1"),
        (0x8305, 0x00175713, "c.srli a4, 1"),
        (0x8785, 0x4017d793, "c.srai a5, 1"),
        (0x088a, 0x00289893, "c.slli a7, 2"),
        (0x8309, 0x00275713, "c.srli a4, 2"),
        (0x8789, 0x4027d793, "c.srai a5, 2"),
        (0x0892, 0x00489893, "c.slli a7, 4"),
        (0x8311, 0x00475713, "c.srli a4, 4"),
        (0x8791, 0x4047d793, "c.srai a5, 4"),
        (0x08a2, 0x00889893, "c.slli a7, 8"),
        (0x8321, 0x00875713, "c.srli a4, 8"),
        (0x87a1, 0x4087d793, "c.srai a5, 8"),
        (0x08c2, 0x01089893, "c.slli a7, 16"),
        (0x8341, 0x01075713, "c.srli a4, 16"),
        (0x87c1, 0x4107d793, "c.srai a5, 16"),
        (0x1882, 0x02089893, "c.slli a7, 32"),
        (0x9301, 0x02075713, "c.srli a4, 32"),
        (0x9781, 0x4207d793, "c.srai a5, 32"),
        (0x1ffe, 0x03ff9f93, "c.slli t6, 63"),
        (0x94fd, 0x43f4d493, "c.srai s1, 63"),
        (0x90fd, 0x03f4d493, "c.srli s1, 63"),
    ];

    /// Floating-point loads and stores, from GNU as.
    const GNU_AS_FP: &[(u32, u32, &str)] = &[
        (0x2714, 0x00873687, "c.fld fa3, 8(a4)"),
        (0xa714, 0x00d73427, "c.fsd fa3, 8(a4)"),
        (0x2b14, 0x01073687, "c.fld fa3, 16(a4)"),
        (0xab14, 0x00d73827, "c.fsd fa3, 16(a4)"),
        (0x3314, 0x02073687, "c.fld fa3, 32(a4)"),
        (0xb314, 0x02d73027, "c.fsd fa3, 32(a4)"),
        (0x2334, 0x04073687, "c.fld fa3, 64(a4)"),
        (0xa334, 0x04d73027, "c.fsd fa3, 64(a4)"),
        (0x2354, 0x08073687, "c.fld fa3, 128(a4)"),
        (0xa354, 0x08d73027, "c.fsd fa3, 128(a4)"),
        (0x3fe0, 0x0f87b407, "c.fld fs0, 248(a5)"),
        (0xa004, 0x00943027, "c.fsd fs1, 0(s0)"),
        (0x2022, 0x00813007, "c.fldsp ft0, 8(sp)"),
        (0xa47e, 0x01f13427, "c.fsdsp ft11, 8(sp)"),
        (0x2042, 0x01013007, "c.fldsp ft0, 16(sp)"),
        (0xa87e, 0x01f13827, "c.fsdsp ft11, 16(sp)"),
        (0x3002, 0x02013007, "c.fldsp ft0, 32(sp)"),
        (0xb07e, 0x03f13027, "c.fsdsp ft11, 32(sp)"),
        (0x2006, 0x04013007, "c.fldsp ft0, 64(sp)"),
        (0xa0fe, 0x05f13027, "c.fsdsp ft11, 64(sp)"),
        (0x200a, 0x08013007, "c.fldsp ft0, 128(sp)"),
        (0xa17e, 0x09f13027, "c.fsdsp ft11, 128(sp)"),
        (0x2012, 0x10013007, "c.fldsp ft0, 256(sp)"),
        (0xa27e, 0x11f13027, "c.fsdsp ft11, 256(sp)"),
        (0x2002, 0x00013007, "c.fldsp ft0, 0(sp)"),
        (0x3dfe, 0x1f813d87, "c.fldsp fs11, 504(sp)"),
    ];

    #[test]
    fn expands_like_gnu_as() {
        for &(c, expected, asm) in GNU_AS.iter().chain(GNU_AS_BITS).chain(GNU_AS_RV64).chain(GNU_AS_FP) {
            assert_eq!(expand(c), Some(expected), "{asm}: 0x{c:04x}");
        }
    }

    #[test]
    fn rejects_illegal_and_reserved_encodings() {
        for (c, what) in [
            (0x0000, "all zeros"),
            (0x0004, "C.ADDI4SPN with nzuimm = 0"),
            (0x6101, "C.ADDI16SP with nzimm = 0"),
            (0x6081, "C.LUI with nzimm = 0"),
            (0x4002, "C.LWSP with rd = 0"),
            (0x6002, "C.LDSP with rd = 0"),
            (0x8002, "C.JR with rs1 = 0"),
            (0x2001, "C.ADDIW with rd = 0"),
            (0x8000, "reserved quadrant 0 funct3 100"),
            (0x9c41, "reserved quadrant 1 funct6 100111, 10"),
            (0x9c61, "reserved quadrant 1 funct6 100111, 11"),
        ] {
            assert_eq!(expand(c), None, "{what}: 0x{c:04x}");
        }
    }

    #[test]
    fn hints_are_legal() {
        // Encodings the spec reserves as HINTs execute as no-ops.
        assert_eq!(expand(0x0501), Some(0x00050513), "C.ADDI with imm = 0");
        assert_eq!(expand(0x4001), Some(0x00000013), "C.LI with rd = 0");
        assert_eq!(expand(0x6005), Some(0x00001037), "C.LUI with rd = 0");
        assert_eq!(expand(0x0002), Some(0x00001013), "C.SLLI with rd = 0, shamt = 0");
        assert_eq!(expand(0x802e), Some(0x00b00033), "C.MV with rd = 0");
        assert_eq!(expand(0x902e), Some(0x00b00033), "C.ADD with rd = 0");
    }
}
