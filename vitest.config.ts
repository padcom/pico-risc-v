import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./test/build-wasm.ts', './test/build-examples.ts', './test/build-riscv-tests.ts'],
  },
})
