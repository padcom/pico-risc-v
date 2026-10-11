//! Checks the F and D extensions against Berkeley TestFloat: `testfloat_gen`
//! (built with SoftFloat's RISC-V specialization) generates operands with
//! the expected results and exception flags, for every rounding mode; each
//! case runs as an instruction on a hart, so decoding, NaN-boxing, rounding
//! mode selection and fflags are all checked, not just the arithmetic.
//!
//! Runs only when TESTFLOAT_GEN names the testfloat_gen program (see
//! hart/testfloat.sh, which builds it, or `npm run test:float`).

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

use crate::csr::MSTATUS_FS;
use crate::hart::Hart;

const OP_FP: u32 = 0x53;
const FMADD: u32 = 0x43;

/// What a TestFloat function is on RISC-V.
#[derive(Clone, Copy)]
enum Kind {
    /// FP operands in f1, f2, f3; FP result in f4.
    Float { operands: usize, single: bool },
    /// Integer operand in x1; FP result in f4.
    FromInt { single: bool },
    /// FP operand in f1; integer result in x4, `bits` wide.
    ToInt { single: bool, bits: u32 },
    /// FP operands in f1, f2; 0/1 in x4.
    Compare { single: bool },
}

/// (TestFloat function, instruction without its rm field, kind, takes a rounding mode)
fn functions() -> Vec<(&'static str, u32, Kind, bool)> {
    let r = |funct5: u32, fmt: u32, rs2: u32, funct3: u32| funct5 << 27 | fmt << 25 | rs2 << 20 | 1 << 15 | funct3 << 12 | 4 << 7 | OP_FP;
    let rr = |funct5: u32, fmt: u32, funct3: u32| r(funct5, fmt, 2, funct3); // rs2 = f2
    let fma = |fmt: u32| 3 << 27 | fmt << 25 | 2 << 20 | 1 << 15 | 4 << 7 | FMADD;
    let mut list = Vec::new();
    for (name, fmt, single) in [("f32", 0, true), ("f64", 1, false)] {
        let float2 = Kind::Float { operands: 2, single };
        list.push((leak(format!("{name}_add")), rr(0, fmt, 0), float2, true));
        list.push((leak(format!("{name}_sub")), rr(1, fmt, 0), float2, true));
        list.push((leak(format!("{name}_mul")), rr(2, fmt, 0), float2, true));
        list.push((leak(format!("{name}_div")), rr(3, fmt, 0), float2, true));
        list.push((leak(format!("{name}_sqrt")), r(11, fmt, 0, 0), Kind::Float { operands: 1, single }, true));
        list.push((leak(format!("{name}_mulAdd")), fma(fmt), Kind::Float { operands: 3, single }, true));
        list.push((leak(format!("{name}_eq")), rr(0x14, fmt, 2), Kind::Compare { single }, false));
        list.push((leak(format!("{name}_lt")), rr(0x14, fmt, 1), Kind::Compare { single }, false));
        list.push((leak(format!("{name}_le")), rr(0x14, fmt, 0), Kind::Compare { single }, false));
        for (int, rs2, bits) in [("i32", 0, 32), ("ui32", 1, 32), ("i64", 2, 64), ("ui64", 3, 64)] {
            list.push((leak(format!("{int}_to_{name}")), r(0x1a, fmt, rs2, 0), Kind::FromInt { single }, true));
            list.push((leak(format!("{name}_to_{int}")), r(0x18, fmt, rs2, 0), Kind::ToInt { single, bits }, true));
        }
    }
    list.push(("f32_to_f64", r(8, 1, 0, 0), Kind::Float { operands: 1, single: true }, true));
    list.push(("f64_to_f32", r(8, 0, 1, 0), Kind::Float { operands: 1, single: false }, true));
    list
}

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

const ROUNDING_MODES: [(&str, u32); 5] =
    [("near_even", 0), ("minMag", 1), ("min", 2), ("max", 3), ("near_maxMag", 4)];

fn boxed(bits: u64, single: bool) -> u64 {
    if single { 0xffff_ffff_0000_0000 | bits } else { bits }
}

#[test]
fn testfloat() {
    let Ok(generator) = std::env::var("TESTFLOAT_GEN") else {
        eprintln!("TESTFLOAT_GEN not set: skipping the TestFloat check (npm run test:float runs it)");
        return;
    };
    let mut hart = Box::new(Hart::new());
    hart.xlen64 = true;
    hart.reset(0);

    let mut failures = 0;
    let mut total = 0;
    for (function, inst, kind, rounds) in functions() {
        let modes: &[(&str, u32)] = if rounds { &ROUNDING_MODES } else { &ROUNDING_MODES[..1] };
        for &(mode, rm) in modes {
            let mut args = vec!["-tininessafter".to_string()];
            if rounds {
                args.push(format!("-r{mode}"));
            }
            if matches!(kind, Kind::ToInt { .. }) {
                args.push("-exact".into()); // RISC-V conversions signal inexact
            }
            if function.ends_with("mulAdd") {
                args.extend(["-n".into(), "2000000".into()]); // level 1 has 6 million
            }
            args.push(function.into());
            let mut child = Command::new(&generator).args(&args).stdout(Stdio::piped()).spawn().expect("testfloat_gen");
            let reader = BufReader::new(child.stdout.take().unwrap());
            let inst = inst | if rounds { rm << 12 } else { 0 };
            let mut shown = 0;
            for line in reader.lines() {
                let line = line.unwrap();
                let fields: Vec<u64> = line.split_whitespace().map(|f| u64::from_str_radix(f, 16).unwrap()).collect();
                let (inputs, expected, flags) = (&fields[..fields.len() - 2], fields[fields.len() - 2], fields[fields.len() - 1]);

                hart.mstatus |= MSTATUS_FS;
                hart.fflags = 0;
                let actual = match kind {
                    Kind::Float { operands, single } => {
                        // Inputs in the source format (f32_to_f64: single; f64_to_f32: double).
                        for (i, &value) in inputs.iter().enumerate().take(operands) {
                            hart.f[1 + i] = boxed(value, single);
                        }
                        hart.execute_fp::<true>(inst).unwrap();
                        let result_single = match function {
                            "f32_to_f64" => false,
                            "f64_to_f32" => true,
                            _ => single,
                        };
                        if result_single {
                            assert_eq!(hart.f[4] >> 32, 0xffff_ffff, "{function}: result not NaN-boxed");
                            hart.f[4] & 0xffff_ffff
                        } else {
                            hart.f[4]
                        }
                    }
                    Kind::FromInt { single } => {
                        hart.x[1] = inputs[0];
                        hart.execute_fp::<true>(inst).unwrap();
                        if single { hart.f[4] & 0xffff_ffff } else { hart.f[4] }
                    }
                    Kind::ToInt { single, bits } => {
                        hart.f[1] = boxed(inputs[0], single);
                        hart.execute_fp::<true>(inst).unwrap();
                        if bits == 32 { hart.x[4] & 0xffff_ffff } else { hart.x[4] }
                    }
                    Kind::Compare { single } => {
                        hart.f[1] = boxed(inputs[0], single);
                        hart.f[2] = boxed(inputs[1], single);
                        hart.execute_fp::<true>(inst).unwrap();
                        hart.x[4]
                    }
                };
                total += 1;
                if actual != expected || hart.fflags as u64 != flags {
                    failures += 1;
                    if shown < 5 {
                        shown += 1;
                        eprintln!(
                            "{function} -r{mode}: {line}  →  got {actual:X} flags {:02X}",
                            hart.fflags
                        );
                    }
                }
            }
            child.wait().unwrap();
        }
    }
    eprintln!("TestFloat: {total} cases, {failures} failures");
    assert_eq!(failures, 0);
}
