#!/usr/bin/env bash
#
# Checks the FPU (core/src/fpu.rs) against Berkeley TestFloat: builds
# SoftFloat with its RISC-V specialization and TestFloat's testfloat_gen
# (into build/testfloat/, pinned commits; downloaded the first time), then
# runs core/src/testfloat.rs, which executes a couple of million generated
# cases as instructions and compares results and exception flags.
#
#   npm run test:float
#
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIR=$ROOT/build/testfloat
SOFTFLOAT_REV=a0c6494cdc11865811dec815d5c0049fba9d82a8
TESTFLOAT_REV=a9c849f1b0eb0264b626d9686ffae167d996e3be

fetch() { # <repo> <dir> <rev>
  if [ ! -d "$DIR/$2/.git" ]; then
    git init -q "$DIR/$2"
    git -C "$DIR/$2" remote add origin "https://github.com/ucb-bar/$1.git"
  fi
  if [ "$(git -C "$DIR/$2" rev-parse HEAD 2>/dev/null)" != "$3" ]; then
    git -C "$DIR/$2" fetch -q --depth 1 origin "$3"
    git -C "$DIR/$2" checkout -q FETCH_HEAD
  fi
}
mkdir -p "$DIR"
fetch berkeley-softfloat-3 berkeley-softfloat-3 "$SOFTFLOAT_REV"
fetch berkeley-testfloat-3 berkeley-testfloat-3 "$TESTFLOAT_REV"

# The generic 64-bit little-endian build, with RISC-V's NaN and
# conversion-overflow rules (SPECIALIZE_TYPE=RISCV).
PLATFORM=Linux-x86_64-GCC
make -s -C "$DIR/berkeley-softfloat-3/build/$PLATFORM" SPECIALIZE_TYPE=RISCV \
  COMPILE_C="cc -c -DSOFTFLOAT_FAST_INT64 -DSOFTFLOAT_ROUND_ODD -DINLINE_LEVEL=5 -DSOFTFLOAT_FAST_DIV32TO16 -DSOFTFLOAT_FAST_DIV64TO32 -I. -I../../source/RISCV -I../../source/include -O2 -o \$@"
make -s -C "$DIR/berkeley-testfloat-3/build/$PLATFORM" testfloat_gen \
  COMPILE_C="cc -c -DFLOAT16 -DFLOAT64 -DEXTFLOAT80 -DFLOAT128 -DFLOAT_ROUND_ODD -DLONG_DOUBLE_IS_EXTFLOAT80 -I. -I../../source/subj-C -I../../source -I../../../berkeley-softfloat-3/source/include -O2 -o \$@" \
  2>&1 | grep -v -i warning || true

TESTFLOAT_GEN="$DIR/berkeley-testfloat-3/build/$PLATFORM/testfloat_gen" \
  node "$ROOT/scripts/build-wasm.ts" test --release testfloat -- --nocapture
