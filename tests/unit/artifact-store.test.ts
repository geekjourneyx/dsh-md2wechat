import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactStore } from '../../src/workspace/artifact-store.ts'

interface TestTarget {
  targetKey: string
  displayPath: string
}

function createTestFileSystem(cwd: string) {
  return {
    async resolve(path: string): Promise<TestTarget> {
      const displayPath = resolve(cwd, path)
      let ancestor = displayPath
      const missing: string[] = []
      while (true) {
        try {
          return { displayPath, targetKey: join(await realpath(ancestor), ...missing) }
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
          missing.unshift(basename(ancestor))
          const parent = dirname(ancestor)
          if (parent === ancestor) return { displayPath, targetKey: displayPath }
          ancestor = parent
        }
      }
    },
    processPath(target: TestTarget): string {
      return target.targetKey
    },
    contains(parent: TestTarget, child: TestTarget): boolean {
      const candidate = relative(parent.targetKey, child.targetKey)
      return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate))
    },
    async readBytes(target: TestTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
      signal?.throwIfAborted()
      try {
        const bytes = await readFile(target.targetKey)
        if (bytes.byteLength > maxBytes) throw new Error('file is too large')
        return bytes
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          const missing = new Error('file not found') as Error & { code: string }
          missing.code = 'FS_NOT_FOUND'
          throw missing
        }
        throw error
      }
    },
  }
}

describe('ArtifactStore', () => {
  let temporary: string
  let workspace: string
  let store: ArtifactStore

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-artifacts-'))
    workspace = join(temporary, 'workspace')
    await mkdir(workspace, { recursive: true })
    store = new ArtifactStore(createTestFileSystem(workspace) as never, workspace, '.dsh/md2wechat')
  })

  afterEach(async () => {
    await import('node:fs/promises').then(fs => fs.rm(temporary, { recursive: true, force: true }))
  })

  it.each([
    '/absolute.md',
    '../escape.md',
    'nested/../escape.md',
    'nested//empty.md',
    'nested/./dot.md',
    'nul\0byte.md',
    'CON',
    'aux.txt',
    'nested/LPT9.json',
  ])('rejects unsafe relative artifact path %j', (relative) => {
    expect(() => store.resolve(relative)).toThrow()
  })

  it('writes and reads arbitrary bytes without UTF-8 conversion', async () => {
    const bytes = Uint8Array.from([0, 255, 128, 10, 65])
    await store.writeAtomic('images/picture.bin', bytes)
    expect(Array.from(await store.read('images/picture.bin'))).toEqual([0, 255, 128, 10, 65])
  })

  it('rejects a canonical path that escapes through a symlinked directory', async () => {
    const outside = join(temporary, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.md'), 'outside')
    const artifactRoot = store.resolve('links')
    await mkdir(join(artifactRoot, '..'), { recursive: true })
    await symlink(outside, artifactRoot)

    await expect(store.read('links/secret.md')).rejects.toThrow('workspace')
  })

  it('rejects a symlink that leaves the configured artifact root but stays in the workspace', async () => {
    const sibling = join(workspace, 'sibling')
    await mkdir(sibling)
    await writeFile(join(sibling, 'secret.md'), 'workspace sibling')
    const artifactLink = store.resolve('links')
    await mkdir(dirname(artifactLink), { recursive: true })
    await symlink(sibling, artifactLink)

    await expect(store.read('links/secret.md')).rejects.toThrow('artifact root')
  })

  it('keeps the complete old file when atomic publication fails', async () => {
    await store.writeAtomic('article.md', new TextEncoder().encode('old article'))
    const rename = vi.fn(async () => { throw new Error('injected rename failure') })
    const failing = new ArtifactStore(store.fs, workspace, '.dsh/md2wechat', { rename })

    await expect(failing.writeAtomic('article.md', new TextEncoder().encode('new article')))
      .rejects.toThrow('injected rename failure')
    await expect(readFile(store.resolve('article.md'), 'utf8')).resolves.toBe('old article')
  })

  it('copies bytes in and out only across explicit absolute external paths', async () => {
    const input = join(temporary, 'input.bin')
    const output = join(temporary, 'output.bin')
    const bytes = Uint8Array.from([222, 173, 190, 239])
    await writeFile(input, bytes)

    await store.copyIn(input, 'imports/input.bin')
    await store.copyOut('imports/input.bin', output)

    await expect(readFile(output)).resolves.toEqual(Buffer.from(bytes))
    await expect(store.copyIn('relative.bin', 'imports/relative.bin')).rejects.toThrow('absolute')
    await expect(store.copyOut('imports/input.bin', 'relative.bin')).rejects.toThrow('absolute')
  })

  it('rejects copying a canonical source onto itself', async () => {
    await store.writeAtomic('article.md', new TextEncoder().encode('article'))
    await expect(store.copyOut('article.md', store.resolve('article.md'))).rejects.toThrow('same')
  })
})
