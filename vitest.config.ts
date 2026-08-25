import { defineConfig } from 'vitest/config'

/** Run this plugin's standalone test suite. */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
