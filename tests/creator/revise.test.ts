import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { reviseCreatorArticle } from '../../src/creator/revise.ts'
import type { CreatorRevision } from '../../src/creator/session.ts'
import { createStartArticleOperation } from '../../src/tools/start-article.ts'
import { loadCurrentArticleRevision } from '../../src/tools/improve-article.ts'
import { preparePreviewInputs } from '../../src/tools/preview.ts'
import { ArtifactStore } from '../../src/workspace/artifact-store.ts'

interface Target { targetKey: string; displayPath: string }
const roots: string[] = []
const encoder = new TextEncoder()
const signal = new AbortController().signal
const original = '# Original\r\n\r\nKeep these exact spaces.  \r\n'
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(markdown = original, title = 'Original') {
  const root = await mkdtemp(join(tmpdir(), 'creator-revise-')); roots.push(root)
  const hooks: { beforeWrite?: (path: string) => Promise<void> } = {}
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
    contains(parent: Target, child: Target) {
      const path = relative(parent.targetKey, child.targetKey)
      return path === '' || (!path.startsWith('..') && !isAbsolute(path))
    },
    async stat(target: Target) {
      try {
        const info = await stat(target.targetKey)
        return { type: info.isFile() ? 'file' : 'directory', size: info.size, version: `${info.mtimeMs}:${info.size}` }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
        throw error
      }
    },
    async readBytes(target: Target, readSignal: AbortSignal | undefined, maxBytes: number) {
      readSignal?.throwIfAborted()
      try {
        const bytes = await readFile(target.targetKey)
        if (bytes.byteLength > maxBytes) throw new Error('file exceeds read limit')
        return bytes
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw Object.assign(new Error('missing file'), { code: 'FS_NOT_FOUND' })
        throw error
      }
    },
  }
  const beforeWrite = ({ destinationPath }: { destinationPath: string }) => hooks.beforeWrite?.(destinationPath)
  const store = new ArtifactStore(fs as never, root, '.articles', { beforeNativeStage: beforeWrite, afterExclusiveStage: beforeWrite })
  await mkdir(join(root, 'images'))
  await writeFile(join(root, 'source.md'), markdown)
  await writeFile(join(root, 'images', 'keep.png'), 'verified local image')
  await writeFile(join(root, 'images', 'remove.png'), 'removed image')
  const started = await createStartArticleOperation({ fs: fs as never, workspace: root, store, importImages: true })(
    { sourcePath: 'source.md', title }, { signal, agent: {} as never, callId: 'start' as never },
  )
  const previous: CreatorRevision = { id: started.revisionId, manifestPath: started.manifestPath, title, markdown }
  return { root, store, previous, hooks }
}

async function manifests(store: ArtifactStore): Promise<string[]> {
  const entries = await readdir(store.resolve('revisions'), { recursive: true })
  return entries.filter(path => path.endsWith('manifest.json'))
}

describe('immutable creator revisions', () => {
  it('persists the exact edited Markdown as a new authenticated child, without changing source or parent', async () => {
    const { root, store, previous } = await fixture()
    const oldManifest = await store.read(previous.manifestPath)
    const markdown = '# Revised 中文\r\n\r\nKeep these exact spaces.  \r\n\r\n'
    const next = await reviseCreatorArticle(store, previous, markdown, signal)
    expect(next).toEqual({ id: expect.any(String), manifestPath: `revisions/${next.id}/manifest.json`, title: 'Revised 中文', markdown })
    expect(next.id).not.toBe(previous.id)
    const loaded = await loadCurrentArticleRevision(store, next.manifestPath, signal)
    expect(loaded.manifest).toMatchObject({ parentRevisionId: previous.id, title: 'Revised 中文' })
    expect(Buffer.from(loaded.articleBytes)).toEqual(Buffer.from(markdown, 'utf8'))
    expect(await store.read(previous.manifestPath)).toEqual(oldManifest)
    expect(Buffer.from(await store.read(`revisions/${previous.id}/article.md`))).toEqual(Buffer.from(original, 'utf8'))
    expect(await readFile(join(root, 'source.md'), 'utf8')).toBe(original)
  })

  it.each([
    ['# Original\n\nNew body', 'Custom title'],
    ['New body without a heading', 'Custom title'],
    ['```md\n# Not the title\n```\nNew body', 'Custom title'],
    ['# Changed title ###\n\nNew body', 'Changed title'],
  ])('keeps the previous title unless a real H1 changes: %s', async (markdown, title) => {
    const { store, previous } = await fixture(original, 'Custom title')
    const next = await reviseCreatorArticle(store, previous, markdown, signal)
    expect(next.title).toBe(title)
    expect((await loadCurrentArticleRevision(store, next.manifestPath, signal)).manifest.title).toBe(title)
  })

  it('copies only retained local images, not preview receipts, results, or removed images', async () => {
    const markdown = '# Original\n![keep](images/keep.png)\n![remove](images/remove.png)\n![online](https://example.test/original.png)\n'
    const { store, previous } = await fixture(markdown)
    await store.writeAtomic(`revisions/${previous.id}/previews/current.json`, encoder.encode('{"receipt":"old"}'))
    await store.writeAtomic(`revisions/${previous.id}/image-results/old.json`, encoder.encode('{"result":"old"}'))
    const next = await reviseCreatorArticle(store, previous, markdown.replace('![remove](images/remove.png)\n', ''), signal)
    const prepared = await preparePreviewInputs(store, next.manifestPath, signal)
    expect(prepared.localImages.map(image => image.source)).toEqual(['images/keep.png'])
    expect(Buffer.from(prepared.localImages[0]!.bytes)).toEqual(Buffer.from('verified local image', 'utf8'))
    expect(prepared.assets.map(asset => asset.kind)).toEqual(['local', 'online'])
    expect((await readdir(store.resolve(`revisions/${next.id}`), { recursive: true })).sort()).toEqual(['article.md', 'images', join('images', 'keep.png'), 'manifest.json'])
  })

  it.each([
    '![new](images/remove.png)',
    '![new](https://example.test/new.png)',
    '![new](../outside.png)',
    '![new](__generate:new image__)',
    '<img src="https://example.test/new.png">',
  ])('rejects a newly introduced unapproved image destination: %s', async image => {
    const { store, previous } = await fixture()
    await expect(reviseCreatorArticle(store, previous, `${original}\n${image}`, signal)).rejects.toThrow(/image|图片/iu)
    expect(await manifests(store)).toEqual([join(previous.id, 'manifest.json')])
  })

  it.each(['id', 'markdown'] as const)('rejects stale caller revision %s before publication', async field => {
    const { store, previous } = await fixture()
    const stale = { ...previous, [field]: field === 'id' ? 'a'.repeat(64) : '# Changed on client' }
    await expect(reviseCreatorArticle(store, stale, '# Edited', signal)).rejects.toThrow(/changed|stale|变化|更新/iu)
    expect(await manifests(store)).toEqual([join(previous.id, 'manifest.json')])
  })

  it('rejects a modified immutable parent before starting a new revision', async () => {
    const { store, previous } = await fixture()
    await writeFile(store.resolve(`revisions/${previous.id}/article.md`), 'tampered')
    await expect(reviseCreatorArticle(store, previous, '# Edited', signal)).rejects.toThrow(/stale|changed/iu)
    expect(await manifests(store)).toEqual([join(previous.id, 'manifest.json')])
  })

  it.each(['article.md', 'manifest.json', 'images/keep.png'])('rechecks immutable %s before publishing the child manifest', async path => {
    const { store, previous, hooks } = await fixture('# Original\n![keep](images/keep.png)\n')
    let changed = false
    hooks.beforeWrite = async destination => {
      if (changed || destination.includes(previous.id)) return
      changed = true
      const target = store.resolve(`revisions/${previous.id}/${path}`)
      await writeFile(`${target}.replacement`, await readFile(target))
      await rename(`${target}.replacement`, target)
    }
    await expect(reviseCreatorArticle(store, previous, '# Edited\n![keep](images/keep.png)\n', signal)).rejects.toThrow(/changed|变化/iu)
    expect(changed).toBe(true)
    expect(await manifests(store)).toEqual([join(previous.id, 'manifest.json')])
  })

  it('rejects Markdown over 8 MiB by UTF-8 bytes, without publishing a child', async () => {
    const { store, previous } = await fixture()
    await expect(reviseCreatorArticle(store, previous, '界'.repeat(Math.floor(8 * 1024 * 1024 / 3) + 1), signal)).rejects.toThrow(/8.?MiB|8.?Mi?B|8.?MiB|8.*limit/iu)
    expect(await manifests(store)).toEqual([join(previous.id, 'manifest.json')])
  })

  it('rejects a leading BOM instead of silently changing bytes or publishing an unreadable revision', async () => {
    const { store, previous } = await fixture()
    await expect(reviseCreatorArticle(store, previous, '\uFEFF# Edited', signal)).rejects.toThrow(/BOM/u)
    expect(await manifests(store)).toEqual([join(previous.id, 'manifest.json')])
  })

  it('honors cancellation before writes and before the final manifest', async () => {
    const { store, previous, hooks } = await fixture()
    const before = AbortSignal.abort(new Error('cancelled before'))
    await expect(reviseCreatorArticle(store, previous, '# Edited', before)).rejects.toThrow('cancelled before')
    const controller = new AbortController()
    hooks.beforeWrite = async () => { controller.abort(new Error('cancelled during')) }
    await expect(reviseCreatorArticle(store, previous, '# Edited', controller.signal)).rejects.toThrow('cancelled during')
    expect(await manifests(store)).toEqual([join(previous.id, 'manifest.json')])
  })
})
