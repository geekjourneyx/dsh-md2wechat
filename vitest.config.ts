import ts from 'typescript'
import { defineConfig } from 'vitest/config'

/** Resolve published host contracts and lower standard decorators for Node. */
export default defineConfig({
  plugins: [{
    name: 'standard-decorators', enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.ts') || !/^\s*@Remote/mu.test(code)) return
      return ts.transpileModule(code, {
        fileName: id,
        compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
      }).outputText
    },
  }],
  test: { include: ['tests/**/*.test.ts'] },
})
