import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { importCreatorImage } from '../../src/creator/import-image.ts'
import { ArtifactStore } from '../../src/workspace/artifact-store.ts'

interface Target { targetKey: string; displayPath: string }
const roots: string[] = []
const revision = 'a'.repeat(64)
const signal = new AbortController().signal
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'creator-import-')); roots.push(parent)
  const root = join(parent, 'workspace'); await mkdir(root)
  const hooks: { afterRead?: (path: string) => Promise<void>; beforePublish?: () => Promise<void> } = {}
  const fs = {
    async resolve(path: string, options?: { cwd?: string }): Promise<Target> {
      const displayPath = resolve(options?.cwd ?? root, path)
      let ancestor = displayPath
      const missing: string[] = []
      while (true) {
        try { return { displayPath, targetKey: join(await realpath(ancestor), ...missing) } }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
          missing.unshift(basename(ancestor)); ancestor = dirname(ancestor)
        }
      }
    },
    processPath: (target: Target) => target.targetKey,
    contains(a: Target, b: Target) { const r = relative(a.targetKey, b.targetKey); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) },
    async stat(target: Target) {
      try {
        const info = await stat(target.targetKey)
        return { type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.size, version: `${info.ino}:${info.mtimeMs}:${info.size}` }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
        throw error
      }
    },
    async readBytes(target: Target, readSignal: AbortSignal | undefined, maxBytes: number) {
      readSignal?.throwIfAborted()
      const bytes = await readFile(target.targetKey)
      if (bytes.byteLength > maxBytes) throw new Error('read limit exceeded')
      await hooks.afterRead?.(target.targetKey)
      return bytes
    },
  }
  const store = new ArtifactStore(fs as never, root, '.articles', { afterExclusiveStage: async () => hooks.beforePublish?.() })
  await writeFile(join(root, 'source.bin'), png)
  return { root, parent, store, hooks, fs, dependencies: { fs: fs as never, workspace: root, store } }
}

describe('authorized local creator image import', () => {
  it('derives a revision-local candidate from actual raster bytes, not a filename extension', async () => {
    const { dependencies, store, root } = await fixture()
    const image = await importCreatorImage(dependencies, revision, 'source.bin', 'cover', '封面', signal)
    expect(image).toEqual({
      id: `creator-cover-${hash(png)}`, revisionId: revision, kind: 'cover',
      path: `revisions/${revision}/images/creator-${hash(png)}.png`,
      sha256: hash(png), byteSize: png.byteLength, contentType: 'image/png', alt: '封面',
    })
    expect(await store.read(image.path)).toEqual(Buffer.from(png))
    expect(await readFile(join(root, 'source.bin'))).toEqual(Buffer.from(png))
    expect(image).not.toHaveProperty('mediaId')
  })

  it.each([
    ['image/jpeg', '.jpg', Uint8Array.from([255, 216, 255, 1])],
    ['image/gif', '.gif', new TextEncoder().encode('GIF89a123')],
    ['image/webp', '.webp', Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80])],
  ] as const)('recognizes %s bytes and produces the canonical extension', async (contentType, extension, bytes) => {
    const { dependencies, root } = await fixture()
    await writeFile(join(root, 'source.bin'), bytes)
    const image = await importCreatorImage(dependencies, revision, 'source.bin', 'body', '正文', signal)
    expect(image.contentType).toBe(contentType)
    expect(image.path.endsWith(extension)).toBe(true)
  })

  it('is idempotent for identical imported bytes and keeps cover and body identities distinct', async () => {
    const { dependencies } = await fixture()
    const first = await importCreatorImage(dependencies, revision, 'source.bin', 'cover', '封面', signal)
    expect(await importCreatorImage(dependencies, revision, 'source.bin', 'cover', '封面', signal)).toEqual(first)
    const body = await importCreatorImage(dependencies, revision, 'source.bin', 'body', '正文', signal)
    expect(body.path).toBe(first.path)
    expect(body.id).not.toBe(first.id)
  })

  it('rejects workspace escapes and symlinks to outside without reading the target', async () => {
    const { dependencies, parent, root, hooks } = await fixture()
    await writeFile(join(parent, 'outside.png'), png)
    await symlink(join(parent, 'outside.png'), join(root, 'escape.png'))
    let reads = 0; hooks.afterRead = async () => { reads++ }
    for (const source of ['../outside.png', join(parent, 'outside.png'), 'escape.png', 'https://example.test/image.png']) {
      await expect(importCreatorImage(dependencies, revision, source, 'cover', '', signal)).rejects.toThrow(/工作区|本地/u)
    }
    expect(reads).toBe(0)
  })

  it('rejects non-files, unsupported content and oversized input', async () => {
    const { dependencies, root } = await fixture()
    await mkdir(join(root, 'directory.png'))
    await expect(importCreatorImage(dependencies, revision, 'directory.png', 'cover', '', signal)).rejects.toThrow('普通文件')
    await writeFile(join(root, 'not-image.png'), '<svg><script>alert(1)</script></svg>')
    await expect(importCreatorImage(dependencies, revision, 'not-image.png', 'cover', '', signal)).rejects.toThrow('格式')
    await writeFile(join(root, 'large.png'), Buffer.alloc(8 * 1024 * 1024 + 1))
    await expect(importCreatorImage(dependencies, revision, 'large.png', 'cover', '', signal)).rejects.toThrow('8')
  })

  it.each(['bytes', 'identity', 'symlink'] as const)('rejects source %s changes after the first read', async change => {
    const { dependencies, root, parent, hooks } = await fixture()
    const path = join(root, 'source.bin')
    let changed = false
    hooks.afterRead = async target => {
      if (target !== path || changed) return
      changed = true
      if (change === 'bytes') await writeFile(path, Uint8Array.from([...png, 1]))
      if (change === 'identity') { await writeFile(`${path}.replacement`, png); await rename(`${path}.replacement`, path) }
      if (change === 'symlink') {
        await writeFile(join(parent, 'outside.png'), png)
        await rm(path); await symlink(join(parent, 'outside.png'), path)
      }
    }
    await expect(importCreatorImage(dependencies, revision, 'source.bin', 'cover', '', signal)).rejects.toThrow(/变化|工作区/u)
    expect(changed).toBe(true)
    await expect(stat(join(root, '.articles', 'revisions', revision))).rejects.toThrow()
  })

  it('does not report a candidate if source changes during publication', async () => {
    const { dependencies, root, hooks, store } = await fixture()
    hooks.beforePublish = async () => { await writeFile(join(root, 'source.bin'), Uint8Array.from([...png, 1])) }
    await expect(importCreatorImage(dependencies, revision, 'source.bin', 'cover', '', signal)).rejects.toThrow('变化')
    // Content-addressed bytes may already be used by another import. Do not delete shared bytes on failure.
    expect(await store.read(`revisions/${revision}/images/creator-${hash(png)}.png`)).toEqual(Buffer.from(png))
  })

  it('never overwrites conflicting bytes at the content-addressed destination', async () => {
    const { dependencies, store } = await fixture()
    const path = `revisions/${revision}/images/creator-${hash(png)}.png`
    const conflict = Uint8Array.from([...png, 1])
    await store.createExclusive(path, conflict, signal)
    await expect(importCreatorImage(dependencies, revision, 'source.bin', 'cover', '', signal)).rejects.toThrow('different bytes')
    expect(await store.read(path)).toEqual(Buffer.from(conflict))
  })

  it('bounds and sanitizes alt text and rejects cancellation before reads or writes', async () => {
    const { dependencies, hooks } = await fixture()
    const image = await importCreatorImage(dependencies, revision, 'source.bin', 'body', `  标题\n${'\u0000'}${'字'.repeat(1000)}`, signal)
    expect(image.alt).not.toMatch(/[\r\n]/u)
    expect(image.alt).not.toContain('\u0000')
    expect(image.alt.length).toBeLessThanOrEqual(500)
    let reads = 0; hooks.afterRead = async () => { reads++ }
    await expect(importCreatorImage(dependencies, revision, 'source.bin', 'body', '', AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
    expect(reads).toBe(0)
  })
})
