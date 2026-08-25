import { mkdir, mkdtemp, readFile, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises'
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
    'CON:stream',
    'CON .txt',
    'NUL::$DATA',
    'aux.txt',
    'aux ',
    'file.txt:secret',
    'trailing.',
    'nested/trailing. ',
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

  it('revalidates a contained directory replaced by an outside symlink before staging', async () => {
    await store.writeAtomic('race/article.md', new TextEncoder().encode('old article'))
    const raceDirectory = dirname(store.resolve('race/article.md'))
    const movedDirectory = join(workspace, 'race-before-stage-backup')
    const outside = join(temporary, 'outside-before-stage')
    await mkdir(outside)
    const racing = new ArtifactStore(store.fs, workspace, '.dsh/md2wechat', {
      async beforeNativeStage() {
        await rename(raceDirectory, movedDirectory)
        await symlink(outside, raceDirectory)
      },
    })

    await expect(racing.writeAtomic('race/article.md', new TextEncoder().encode('new article')))
      .rejects.toThrow('changed')
    await expect(readFile(join(movedDirectory, 'article.md'), 'utf8')).resolves.toBe('old article')
    await expect(readFile(join(outside, 'article.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await import('node:fs/promises').then(fs => fs.readdir(outside))).toEqual([])
  })

  it('revalidates target and temp identities before commit without cleaning through a replacement symlink', async () => {
    await store.writeAtomic('race/article.md', new TextEncoder().encode('old article'))
    const raceDirectory = dirname(store.resolve('race/article.md'))
    const movedDirectory = join(workspace, 'race-before-commit-backup')
    const outside = join(temporary, 'outside-before-commit')
    await mkdir(outside)
    let outsideTemp = ''
    const racing = new ArtifactStore(store.fs, workspace, '.dsh/md2wechat', {
      async beforeNativeCommit(paths) {
        await rename(raceDirectory, movedDirectory)
        await symlink(outside, raceDirectory)
        outsideTemp = join(outside, basename(paths.tempPath))
        await writeFile(outsideTemp, 'outside sentinel')
        await writeFile(join(outside, 'article.md'), 'outside final')
      },
    })

    await expect(racing.writeAtomic('race/article.md', new TextEncoder().encode('new article')))
      .rejects.toThrow('changed')
    await expect(readFile(join(movedDirectory, 'article.md'), 'utf8')).resolves.toBe('old article')
    await expect(readFile(outsideTemp, 'utf8')).resolves.toBe('outside sentinel')
    await expect(readFile(join(outside, 'article.md'), 'utf8')).resolves.toBe('outside final')
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

  it('stages private CLI output and atomically commits it to the final artifact', async () => {
    const staged = await store.stageOutput('preview/article.html')
    expect((await stat(dirname(staged.processPath))).mode & 0o777).toBe(0o700)
    await writeFile(staged.processPath, Uint8Array.from([0, 255, 65]))

    await staged.commit()

    expect(Array.from(await store.read('preview/article.html'))).toEqual([0, 255, 65])
    await expect(readFile(staged.processPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans an uncommitted CLI output without publishing its final artifact', async () => {
    const staged = await store.stageOutput('preview/article.html')
    await writeFile(staged.processPath, 'uncommitted')

    await staged.cleanup()
    await staged.cleanup()

    await expect(store.read('preview/article.html')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(readFile(staged.processPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects staged CLI output replaced by an escaping symlink', async () => {
    const outside = join(temporary, 'outside-stage.html')
    await writeFile(outside, 'outside')
    const staged = await store.stageOutput('preview/article.html')
    await symlink(outside, staged.processPath)

    await expect(staged.commit()).rejects.toThrow('staging')
    await expect(staged.cleanup()).rejects.toThrow()
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside')
    await expect(store.read('preview/article.html')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('retains staged CLI output when final atomic publication fails', async () => {
    const rename = vi.fn(async () => { throw new Error('injected final publication failure') })
    const failing = new ArtifactStore(store.fs, workspace, '.dsh/md2wechat', { rename })
    const staged = await failing.stageOutput('preview/article.html')
    await writeFile(staged.processPath, 'retryable output')

    await expect(staged.commit()).rejects.toThrow('injected final publication failure')
    await expect(readFile(staged.processPath, 'utf8')).resolves.toBe('retryable output')
    await expect(store.read('preview/article.html')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await staged.cleanup()
  })
})
