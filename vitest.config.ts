import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['./test/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      enabled: true,
      include: ['src/**/*.ts'],
    },
  },
})
