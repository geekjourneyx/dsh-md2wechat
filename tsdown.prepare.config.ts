import { defineConfig } from 'tsdown'

/** Transpile the npm prepare hook without publishing declarations. */
export default defineConfig({
  entry: ['src/prepare.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
})
