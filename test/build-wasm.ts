import { buildWasm } from '../packages/hart/scripts/build-wasm.ts'

/** Compile the CPU core (packages/hart/core/, Rust → packages/hart/build/hart.wasm) before the test run. */
export default function setup() {
  buildWasm()
}
