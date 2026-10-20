import { dirname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

const EXTERNAL_PEERS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-fs',
  '@deepseek-ai/dsh-jobs',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-user-approval',
]

/** Bundle the plugin entry without bundling its host-provided peers. */
export default defineConfig([{
  entry: ['src/index.ts'],
  plugins: [{ ...typertPlugin(), buildStart() {}, writeBundle() { return Promise.resolve() } }],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: EXTERNAL_PEERS,
  },
}, {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib', format: 'cjs', platform: 'browser', target: 'es2024',
  dts: false, clean: false, minify: true,
  plugins: [{ name: 'creator-css', resolveId(source, importer) { if (source.endsWith('.css') && importer) return '\0creator-css:' + resolve(dirname(importer), source) + '.mjs' }, async load(id) { if (id.startsWith('\0creator-css:')) return 'export default ' + JSON.stringify(await readFile(id.slice(13, -4), 'utf8')) } }],
  deps: {
    neverBundle: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis'],
    alwaysBundle: id => !['react', 'react/jsx-runtime', '@deepseek-ai/cordis'].includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js', codeSplitting: false,
    banner: 'window.__ModuleLoader__.load({ id: "@geekjourneyx/dsh-md2wechat", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}])
