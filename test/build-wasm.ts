import { buildWasm } from '../scripts/build-wasm.ts'

/** Compile the CPU core (hart/, Rust → build/hart.wasm) before the test run. */
export default function setup() {
  buildWasm()
}
