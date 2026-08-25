import { defineConfig } from 'tsdown'

const EXTERNAL_PEERS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-fs',
  '@deepseek-ai/dsh-jobs',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-user-approval',
]

/** Bundle the plugin entry without bundling its host-provided peers. */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  deps: {
    neverBundle: EXTERNAL_PEERS,
  },
})
