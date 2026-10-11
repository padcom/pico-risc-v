//! The F and D extensions: single- and double-precision floating point.
//!
//! The arithmetic is IEEE 754 in software (the softfp crate): every rounding
//! mode and exception flag, which WebAssembly's own floats can't provide.
//! The RISC-V specifics are here:
//!
//! - f0..f31 are 64 bits wide. A single-precision value is NaN-boxed: its
//!   upper 32 bits are all ones. A single-precision operand that isn't
//!   properly boxed reads as the canonical NaN.
//! - NaN results are always the canonical NaN (softfp does that).
//! - mstatus.FS: with it Off, FP instructions and CSRs are illegal; anything
//!   that changes FP state (registers, fflags) sets it Dirty, so the OS knows
//!   to save it on a context switch.

use core::cell::UnsafeCell;
use core::cmp::Ordering;
use softfp::{ExceptionFlags, F32, F32Desc, F64, F64Desc, Fp, FpDesc, RoundingMode};

use crate::csr::*;
use crate::hart::{Hart, Result, illegal, imm_i, imm_s, sext32};

const LOAD_FP: u32 = 0x07;
const STORE_FP: u32 = 0x27;
const FMADD: u32 = 0x43;
const FMSUB: u32 = 0x47;
const FNMSUB: u32 = 0x4b;
const FNMADD: u32 = 0x4f;
const OP_FP: u32 = 0x53;

/// fflags: invalid operation. (softfp's flags have the same bits as fflags.)
const NV: u32 = 0x10;

// softfp asks for the rounding mode, and reports exception flags, through
// these two functions; the operation in progress sets them up (see `ieee`).
struct Env(UnsafeCell<Status>);
// SAFETY: WebAssembly instances are single-threaded.
unsafe impl Sync for Env {}
#[derive(Clone, Copy)]
struct Status {
    rounding_mode: u32,
    flags: u32,
}
static ENV: Env = Env(UnsafeCell::new(Status { rounding_mode: 0, flags: 0 }));

#[unsafe(no_mangle)]
fn softfp_get_rounding_mode() -> RoundingMode {
    // SAFETY: single-threaded; only `ieee` writes it.
    let rm = unsafe { (*ENV.0.get()).rounding_mode };
    RoundingMode::try_from(rm).unwrap_or(RoundingMode::TiesToEven)
}

#[unsafe(no_mangle)]
fn softfp_set_exception_flags(flags: ExceptionFlags) {
    raise(flags.bits());
}

fn raise(flags: u32) {
    // SAFETY: single-threaded.
    unsafe { (*ENV.0.get()).flags |= flags }
}

/// How a format's values sit in the 64-bit f registers.
trait Format: FpDesc + Sized {
    fn read(bits: u64) -> Fp<Self>;
    fn write(value: Fp<Self>) -> u64;
}

impl Format for F32Desc {
    fn read(bits: u64) -> F32 {
        if bits >> 32 == 0xffff_ffff { F32::new(bits as u32) } else { F32::quiet_nan() }
    }
    fn write(value: F32) -> u64 {
        nan_box(value.0)
    }
}

impl Format for F64Desc {
    fn read(bits: u64) -> F64 {
        F64::new(bits)
    }
    fn write(value: F64) -> u64 {
        value.0
    }
}

const fn nan_box(single: u32) -> u64 {
    0xffff_ffff_0000_0000 | single as u64
}

impl Hart {
    /// Run a softfp operation with rounding mode `rm`, adding the exception
    /// flags it raises to fflags.
    fn ieee<T>(&mut self, rm: u32, op: impl FnOnce() -> T) -> T {
        // SAFETY: single-threaded.
        unsafe { *ENV.0.get() = Status { rounding_mode: rm, flags: 0 } };
        let result = op();
        self.fflags |= unsafe { (*ENV.0.get()).flags };
        result
    }

    /// The instruction's rounding mode (its rm field, or frm for "dynamic").
    /// Reserved values make the instruction illegal.
    fn rounding_mode(&self, inst: u32) -> Result<u32> {
        let rm = match (inst >> 12) & 7 {
            7 => self.frm,
            rm => rm,
        };
        if rm > 4 { Err(illegal(inst)) } else { Ok(rm) }
    }

    pub(crate) fn fp_enabled(&self) -> bool {
        self.mstatus & MSTATUS_FS != 0
    }

    /// Execute an F/D instruction (LOAD-FP, STORE-FP, FMADD..FNMADD, OP-FP).
    pub(crate) fn execute_fp(&mut self, inst: u32) -> Result<()> {
        if !self.fp_enabled() {
            return Err(illegal(inst));
        }
        let rd = ((inst >> 7) & 0x1f) as usize;
        let funct3 = (inst >> 12) & 7;
        let rs1 = ((inst >> 15) & 0x1f) as usize;
        let rs2 = ((inst >> 20) & 0x1f) as usize;
        let rs3 = (inst >> 27) as usize;
        let fmt = (inst >> 25) & 3;

        match inst & 0x7f {
            LOAD_FP => {
                let address = self.x[rs1].wrapping_add(imm_i(inst));
                let value = match funct3 {
                    0b010 => nan_box(self.load(address, 4)? as u32), // FLW
                    0b011 => self.load(address, 8)?,                 // FLD
                    _ => return Err(illegal(inst)),
                };
                self.f[rd] = value;
            }
            STORE_FP => {
                let address = self.x[rs1].wrapping_add(imm_s(inst));
                match funct3 {
                    0b010 => self.store(address, 4, self.f[rs2])?, // FSW
                    0b011 => self.store(address, 8, self.f[rs2])?, // FSD
                    _ => return Err(illegal(inst)),
                }
                return Ok(()); // FP state unchanged
            }
            opcode @ (FMADD | FMSUB | FNMSUB | FNMADD) => {
                let rm = self.rounding_mode(inst)?;
                // FMSUB: a·b − c, FNMSUB: −(a·b) + c, FNMADD: −(a·b) − c
                let negate_product = opcode == FNMSUB || opcode == FNMADD;
                let negate_addend = opcode == FMSUB || opcode == FNMADD;
                let (a, b, c) = (self.f[rs1], self.f[rs2], self.f[rs3]);
                self.f[rd] = match fmt {
                    0 => self.fma::<F32Desc>(rm, a, b, c, negate_product, negate_addend),
                    1 => self.fma::<F64Desc>(rm, a, b, c, negate_product, negate_addend),
                    _ => return Err(illegal(inst)),
                };
            }
            OP_FP => match fmt {
                0 => self.op_fp::<F32Desc>(inst, rd, funct3, rs1, rs2)?,
                1 => self.op_fp::<F64Desc>(inst, rd, funct3, rs1, rs2)?,
                _ => return Err(illegal(inst)),
            },
            _ => return Err(illegal(inst)),
        }
        self.mstatus |= MSTATUS_FS; // dirty
        Ok(())
    }

    fn fma<D: Format>(&mut self, rm: u32, a: u64, b: u64, c: u64, negate_product: bool, negate_addend: bool) -> u64 {
        let (mut a, b, mut c) = (D::read(a), D::read(b), D::read(c));
        if negate_product {
            a = a.negate();
        }
        if negate_addend {
            c = c.negate();
        }
        // softfp gives a zero product plus a zero the sign of an exact
        // cancellation (+0, or -0 when rounding down) even when both are
        // zeros of the same sign, which keep it: 0 × -1 + -0 = -0.
        if c.is_zero() && ((a.is_zero() && b.is_finite()) || (b.is_zero() && a.is_finite())) {
            // The zero operand, with the product's sign.
            let product = if a.is_zero() { a.copy_sign_xored(b) } else { b.copy_sign_xored(a) };
            if D::write(product) == D::write(c) {
                return D::write(c);
            }
        }
        D::write(self.ieee(rm, || Fp::fused_multiply_add(a, b, c)))
    }

    /// OP-FP for one format: arithmetic, sign injection, min/max,
    /// comparisons, classification, conversions and moves.
    fn op_fp<D: Format>(&mut self, inst: u32, rd: usize, funct3: u32, rs1: usize, rs2: usize) -> Result<()>
    where
        Self: Convert<D>,
    {
        let a = D::read(self.f[rs1]);
        let b = D::read(self.f[rs2]);
        match inst >> 27 {
            funct5 @ 0b00000..=0b00011 => {
                let rm = self.rounding_mode(inst)?;
                let result = self.ieee(rm, || match funct5 {
                    0 => a + b, // FADD
                    1 => a - b, // FSUB
                    2 => a * b, // FMUL
                    _ => a / b, // FDIV
                });
                self.f[rd] = D::write(result);
            }
            0b01011 if rs2 == 0 => {
                let rm = self.rounding_mode(inst)?;
                self.f[rd] = D::write(self.ieee(rm, || square_root(a))); // FSQRT
            }
            0b00100 => {
                self.f[rd] = D::write(match funct3 {
                    0 => a.copy_sign(b),         // FSGNJ
                    1 => a.copy_sign_negated(b), // FSGNJN
                    2 => a.copy_sign_xored(b),   // FSGNJX
                    _ => return Err(illegal(inst)),
                });
            }
            0b00101 if funct3 < 2 => {
                let max = funct3 == 1;
                self.f[rd] = D::write(self.ieee(0, || min_max(a, b, max))); // FMIN / FMAX
            }
            0b10100 => {
                let result = match funct3 {
                    // FEQ is a quiet comparison: only signaling NaNs are invalid.
                    2 => self.ieee(0, || {
                        if a.is_signaling() || b.is_signaling() {
                            raise(NV);
                        }
                        Fp::compare_quiet(a, b) == Some(Ordering::Equal)
                    }),
                    // FLT / FLE signal on any NaN.
                    1 => self.ieee(0, || Fp::compare_signaling(a, b) == Some(Ordering::Less)),
                    0 => self.ieee(0, || matches!(Fp::compare_signaling(a, b), Some(Ordering::Less | Ordering::Equal))),
                    _ => return Err(illegal(inst)),
                };
                self.x[rd] = result as u64;
            }
            0b11100 if rs2 == 0 && funct3 == 1 => self.x[rd] = 1 << a.classify() as u32, // FCLASS
            0b11100 if rs2 == 0 && funct3 == 0 => {
                // FMV.X.W / FMV.X.D: the raw bits (FMV.X.W sign-extends them)
                self.x[rd] = match D::SIGNIFICAND_WIDTH {
                    23 => sext32(self.f[rs1] as u32 as u64),
                    _ => self.f[rs1],
                };
            }
            0b11110 if rs2 == 0 && funct3 == 0 => {
                // FMV.W.X / FMV.D.X
                self.f[rd] = match D::SIGNIFICAND_WIDTH {
                    23 => nan_box(self.x[rs1] as u32),
                    _ => self.x[rs1],
                };
            }
            0b01000 => {
                // FCVT.S.D / FCVT.D.S
                let rm = self.rounding_mode(inst)?;
                self.f[rd] = match (D::SIGNIFICAND_WIDTH, rs2) {
                    (23, 1) => {
                        let source = F64Desc::read(self.f[rs1]);
                        F32Desc::write(self.ieee(rm, || source.convert_format::<F32Desc>()))
                    }
                    (52, 0) => {
                        let source = F32Desc::read(self.f[rs1]);
                        F64Desc::write(self.ieee(rm, || source.convert_format::<F64Desc>()))
                    }
                    _ => return Err(illegal(inst)),
                };
            }
            0b11000 => {
                // FCVT.W/WU/L/LU from this format; 32-bit results are sign-extended.
                let rm = self.rounding_mode(inst)?;
                self.x[rd] = match rs2 {
                    0 => sext32(self.ieee(rm, || Self::to_i32(a)) as u64),
                    1 => sext32(self.ieee(rm, || Self::to_u32(a)) as u64),
                    2 => self.ieee(rm, || Self::to_i64(a)),
                    3 => self.ieee(rm, || Self::to_u64(a)),
                    _ => return Err(illegal(inst)),
                };
            }
            0b11010 => {
                // FCVT to this format from W/WU/L/LU
                let rm = self.rounding_mode(inst)?;
                let x = self.x[rs1];
                let result = match rs2 {
                    0 => self.ieee(rm, || Self::from_i32(x as u32)),
                    1 => self.ieee(rm, || Self::from_u32(x as u32)),
                    2 => self.ieee(rm, || Self::from_i64(x)),
                    3 => self.ieee(rm, || Self::from_u64(x)),
                    _ => return Err(illegal(inst)),
                };
                self.f[rd] = D::write(result);
            }
            _ => return Err(illegal(inst)),
        }
        Ok(())
    }

    /// fflags / frm / fcsr; None if FP is off (then they're illegal).
    pub(crate) fn read_fcsr(&self, csr: u32) -> Option<u64> {
        if !self.fp_enabled() {
            return None;
        }
        Some(match csr {
            FFLAGS => self.fflags,
            FRM => self.frm,
            _ => self.frm << 5 | self.fflags,
        } as u64)
    }

    pub(crate) fn write_fcsr(&mut self, csr: u32, value: u64) {
        let value = value as u32;
        match csr {
            FFLAGS => self.fflags = value & 0x1f,
            FRM => self.frm = value & 7,
            _ => {
                self.fflags = value & 0x1f;
                self.frm = (value >> 5) & 7;
            }
        }
        self.mstatus |= MSTATUS_FS; // dirty
    }
}

/// Square root. (softfp flags a signaling NaN operand as division by zero
/// rather than invalid; the result, the canonical NaN, is right.)
fn square_root<D: FpDesc>(a: Fp<D>) -> Fp<D> {
    if a.is_signaling() {
        raise(NV);
        return Fp::quiet_nan();
    }
    a.square_root()
}

/// FMIN / FMAX (IEEE 754-2019 minimumNumber / maximumNumber): a NaN operand
/// yields the other one (both: the canonical NaN), −0 is less than +0, and
/// signaling NaNs are invalid even when the result isn't a NaN.
fn min_max<D: FpDesc>(a: Fp<D>, b: Fp<D>, max: bool) -> Fp<D> {
    if a.is_signaling() || b.is_signaling() {
        raise(NV);
    }
    match (a.is_nan(), b.is_nan()) {
        (true, true) => Fp::quiet_nan(),
        (true, false) => b,
        (false, true) => a,
        _ => {
            let a_first = Fp::total_order(a, b) == Ordering::Less;
            if a_first != max { a } else { b }
        }
    }
}

/// Conversions between integers and one format (softfp's are generic over
/// the integer type, which needs the concrete formats).
///
/// To integers: a finite value of 2^bits or more must saturate (and be
/// invalid), but softfp's conversion shifts it out of range instead; those
/// are caught first. (Infinities and NaNs it handles.)
trait Convert<D: FpDesc> {
    fn to_i32(value: Fp<D>) -> u32;
    fn to_u32(value: Fp<D>) -> u32;
    fn to_i64(value: Fp<D>) -> u64;
    fn to_u64(value: Fp<D>) -> u64;
    fn from_i32(value: u32) -> Fp<D>;
    fn from_u32(value: u32) -> Fp<D>;
    fn from_i64(value: u64) -> Fp<D>;
    fn from_u64(value: u64) -> Fp<D>;
}

macro_rules! convert {
    ($desc:ty, $format:expr) => {
        impl Convert<$desc> for Hart {
            fn to_i32(value: Fp<$desc>) -> u32 {
                saturated(value.0 as u64, $format, value.is_finite(), 32, true).map_or_else(|| value.convert_to_sint::<u32>(), |v| v as u32)
            }
            fn to_u32(value: Fp<$desc>) -> u32 {
                saturated(value.0 as u64, $format, value.is_finite(), 32, false).map_or_else(|| value.convert_to_uint::<u32>(), |v| v as u32)
            }
            fn to_i64(value: Fp<$desc>) -> u64 {
                saturated(value.0 as u64, $format, value.is_finite(), 64, true).unwrap_or_else(|| value.convert_to_sint::<u64>())
            }
            fn to_u64(value: Fp<$desc>) -> u64 {
                saturated(value.0 as u64, $format, value.is_finite(), 64, false).unwrap_or_else(|| value.convert_to_uint::<u64>())
            }
            fn from_i32(value: u32) -> Fp<$desc> {
                Fp::convert_from_sint::<u32>(value)
            }
            fn from_u32(value: u32) -> Fp<$desc> {
                Fp::convert_from_uint::<u32>(value)
            }
            fn from_i64(value: u64) -> Fp<$desc> {
                Fp::convert_from_sint::<u64>(value)
            }
            fn from_u64(value: u64) -> Fp<$desc> {
                Fp::convert_from_uint::<u64>(value)
            }
        }

    };
}
convert!(F32Desc, SINGLE);
convert!(F64Desc, DOUBLE);

/// A format's layout: significand bits, exponent mask, exponent bias, total bits.
struct Layout(u32, u64, i32, u32);
const SINGLE: Layout = Layout(23, 0xff, 127, 32);
const DOUBLE: Layout = Layout(52, 0x7ff, 1023, 64);

/// The saturated result (and the invalid flag) of converting a finite value
/// of magnitude 2^bits or more to a `bits`-wide integer; None for anything else.
fn saturated(raw: u64, format: Layout, finite: bool, bits: u32, signed: bool) -> Option<u64> {
    let Layout(significand_bits, exponent_mask, bias, width) = format;
    let exponent = ((raw >> significand_bits) & exponent_mask) as i32 - bias;
    if !finite || exponent < bits as i32 {
        return None;
    }
    raise(NV);
    let negative = raw >> (width - 1) != 0;
    Some(match (signed, negative) {
        (true, true) => 1 << (bits - 1),        // most negative
        (true, false) => (1 << (bits - 1)) - 1, // most positive
        (false, true) => 0,
        (false, false) => u64::MAX >> (64 - bits),
    })
}
