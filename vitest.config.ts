import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const dshRoot = fileURLToPath(new URL('../../web/deepseek-harness/', import.meta.url))
const peerAliases = {
  '@deepseek-ai/cordis': 'vendor/cordis/src/index.ts',
  '@deepseek-ai/dsh-credentials': 'packages/credentials/credentials/src/index.ts',
  '@deepseek-ai/dsh-fs': 'packages/fs/fs/src/index.ts',
  '@deepseek-ai/dsh-jobs': 'packages/jobs/jobs/src/index.ts',
  '@deepseek-ai/dsh-subprocess': 'packages/subprocess/subprocess/src/index.ts',
  '@deepseek-ai/dsh-system-prompt': 'packages/core/system-prompt/src/index.ts',
  '@deepseek-ai/dsh-tools': 'packages/core/tools/src/index.ts',
  '@deepseek-ai/dsh-user-approval': 'packages/interaction/user-approval/src/index.ts',
} as const

/** Run this plugin's standalone test suite. */
export default defineConfig({
  resolve: {
    alias: Object.entries(peerAliases).map(([name, path]) => ({
      find: new RegExp(`^${name}$`, 'u'),
      replacement: resolve(dshRoot, path),
    })),
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
