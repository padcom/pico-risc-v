import { defaultServerConditions } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The packages (packages/*) as their TypeScript sources: their exports'
  // "source" condition, not dist/.
  resolve: { conditions: ['source', ...defaultServerConditions] },
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions] } },
  test: {
    include: ['src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    globalSetup: ['./test/build-wasm.ts', './test/build-examples.ts', './test/build-riscv-tests.ts'],
  },
})
