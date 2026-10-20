import { mkdtemp, rm, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '../../src/workspace/artifact-store.ts'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(allow: () => boolean) {
  const root = await mkdtemp(join(tmpdir(), 'creator-policy-')); roots.push(root)
  const fs = {
    resolve: async (path: string) => ({ targetKey: resolve(path), displayPath: resolve(path) }),
    processPath: (target: { targetKey: string }) => target.targetKey,
    contains: (a: { targetKey: string }, b: { targetKey: string }) => { const r = relative(a.targetKey, b.targetKey); return !r.startsWith('..') && !isAbsolute(r) },
    stat: async (t: { targetKey: string }) => { try { const s = await stat(t.targetKey); return { type: s.isFile() ? 'file' : 'directory', version: String(s.mtimeMs), size: s.size } } catch { return undefined } },
    readBytes: async (t: { targetKey: string }) => readFile(t.targetKey),
  }
  return { root, store: new ArtifactStore(fs as never, root, '.articles', {}, async () => { if (!allow()) throw new Error('只读') }) }
}
describe('creator raw publication policy', () => {
  it('checks policy before native article and CLI staging writes', async () => {
    const { root, store } = await fixture(() => false)
    await expect(store.writeAtomic('a.md', new TextEncoder().encode('a'))).rejects.toThrow('只读')
    await expect(store.createExclusive('b.md', new TextEncoder().encode('b'))).rejects.toThrow('只读')
    await expect(store.stageOutput('preview.html')).rejects.toThrow('只读')
    await expect(stat(join(root, '.articles'))).rejects.toThrow()
  })
})
