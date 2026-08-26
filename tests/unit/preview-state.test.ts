import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '../../src/workspace/artifact-store.ts'
import {
  cleanupPreviewSnapshot,
  createPreviewPublicationOwnership,
  createPreviewReceipt,
  createPreviewSnapshot,
  publishPreviewSnapshot,
  validateCurrentPreview,
} from '../../src/workspace/preview.ts'
import type { PreviewSnapshotInput, PreviewTransaction } from '../../src/workspace/preview.ts'

interface TestTarget {
  targetKey: string
  displayPath: string
}

const encoder = new TextEncoder()

function canonicalBytes(value: unknown): Uint8Array {
  const sort = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object') return item
    if (Array.isArray(item)) return item.map(sort)
    return Object.fromEntries(Object.keys(item as Record<string, unknown>).sort().map(key => [key, sort((item as Record<string, unknown>)[key])]))
  }
  return encoder.encode(`${JSON.stringify(sort(value))}\n`)
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
    processPath(target: TestTarget): string { return target.targetKey },
    contains(parent: TestTarget, child: TestTarget): boolean {
      const candidate = relative(parent.targetKey, child.targetKey)
      return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate))
    },
    async stat(target: TestTarget) {
      try {
        const info = await stat(target.targetKey)
        return {
          version: `${info.mtimeMs}:${info.size}`,
          type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
          size: info.size,
        }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
        throw error
      }
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

function baseInput(overrides: Partial<PreviewSnapshotInput> = {}): PreviewSnapshotInput {
  return {
    revisionId: 'a'.repeat(64),
    articlePath: `revisions/${'a'.repeat(64)}/article.md`,
    articleBytes: encoder.encode('# Article\n\n![second](images/z.png)\n![first](images/a.png)\n'),
    localImages: [
      { path: `revisions/${'a'.repeat(64)}/images/z.png`, bytes: Uint8Array.from([2]) },
      { path: `revisions/${'a'.repeat(64)}/images/a.png`, bytes: Uint8Array.from([1]) },
    ],
    layoutBaseUrl: 'https://www.md2wechat.cn',
    previewSettings: {
      mode: 'api',
      theme: 'default',
      fontSize: 'medium',
      backgroundType: 'none',
      output: 'standalone-html',
    },
    credentialReference: 'MD2WECHAT_API_KEY',
    credentialValue: 'secret-one',
    pluginVersion: '1.0.0',
    cliVersion: '3.3.0',
    ...overrides,
  }
}

function receiptProjection(input: PreviewSnapshotInput) {
  return {
    metadata: { title: 'Article', author: '', digest: '' },
    assets: input.localImages.map((image, index) => ({ index, kind: 'local' as const, source: image.path.split('/').slice(-2).join('/'), path: image.path, sha256: createHash('sha256').update(image.bytes).digest('hex') })),
  }
}

describe('signed preview state', () => {
  let temporary: string
  let workspace: string
  let store: ArtifactStore

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-preview-state-'))
    workspace = join(temporary, 'workspace')
    await mkdir(workspace)
    store = new ArtifactStore(createTestFileSystem(workspace) as never, workspace, '.dsh/md2wechat')
  })

  afterEach(async () => {
    await import('node:fs/promises').then(fs => fs.rm(temporary, { recursive: true, force: true }))
  })

  it('changes snapshot identity for every freshness input without retaining credentials', () => {
    const base = createPreviewSnapshot(baseInput())
    const cases = [
      baseInput({ articleBytes: encoder.encode('# Changed\n') }),
      baseInput({ localImages: [
        { path: `revisions/${'a'.repeat(64)}/images/z.png`, bytes: Uint8Array.from([3]) },
        { path: `revisions/${'a'.repeat(64)}/images/a.png`, bytes: Uint8Array.from([1]) },
      ] }),
      baseInput({ layoutBaseUrl: 'https://layout.example' }),
      baseInput({ previewSettings: { ...baseInput().previewSettings, theme: 'grace' } }),
      baseInput({ previewSettings: { ...baseInput().previewSettings, fontSize: 'large' } }),
      baseInput({ previewSettings: { ...baseInput().previewSettings, backgroundType: 'grid' } }),
      baseInput({ previewSettings: { ...baseInput().previewSettings, output: 'different-html' } }),
      baseInput({ credentialReference: 'MD2WECHAT_PREVIEW_KEY' }),
      baseInput({ credentialValue: 'secret-two' }),
      baseInput({ pluginVersion: '1.0.1' }),
      baseInput({ cliVersion: '3.3.1' }),
    ]
    for (const input of cases) expect(createPreviewSnapshot(input).id).not.toBe(base.id)
    const serialized = JSON.stringify(base)
    expect(serialized).not.toContain('secret-one')
    expect(serialized).not.toContain('MD2WECHAT_API_KEY')
    expect(base.articleSha256).toBe(createHash('sha256').update(baseInput().articleBytes).digest('hex'))
  })

  it('signs strict draft metadata and ordered asset inventory without machine paths', () => {
    const snapshot = createPreviewSnapshot(baseInput({ localImages: [{ path: `revisions/${'a'.repeat(64)}/images/a.png`, bytes: Uint8Array.from([1]) }] }))
    const receipt = createPreviewReceipt({
      snapshot,
      previewHtmlPath: `revisions/${snapshot.revisionId}/previews/html/${snapshot.id}.html`,
      previewHtmlBytes: encoder.encode('<article><img src="images/a.png"></article>'),
      credentialValue: 'secret-one',
      issuedAt: '2026-08-25T00:00:00.000Z',
      expiresAt: '2026-08-25T00:10:00.000Z',
      metadata: { title: '文章标题', author: '作者', digest: '摘要' },
      assets: [
        { index: 0, kind: 'local', source: 'images/a.png', path: `revisions/${'a'.repeat(64)}/images/a.png`, sha256: createHash('sha256').update(Uint8Array.from([1])).digest('hex') },
        { index: 1, kind: 'online', source: 'https://mmbiz.qpic.cn/existing.png' },
      ],
    })
    expect(receipt.metadata).toEqual({ title: '文章标题', author: '作者', digest: '摘要' })
    expect(receipt.assets.map(asset => asset.kind)).toEqual(['local', 'online'])
    expect(JSON.stringify(receipt)).not.toContain('/private/')
    for (const title of ['', '   ', '\u3000']) expect(() => createPreviewReceipt({
      snapshot,
      previewHtmlPath: `revisions/${snapshot.revisionId}/previews/html/${snapshot.id}.html`,
      previewHtmlBytes: encoder.encode('x'), credentialValue: 'secret-one', issuedAt: '2026-08-25T00:00:00.000Z', expiresAt: '2026-08-25T00:10:00.000Z',
      metadata: { title, author: '', digest: '' }, assets: [{ index: 0, kind: 'local', source: 'images/a.png', path: `revisions/${'a'.repeat(64)}/images/a.png`, sha256: createHash('sha256').update(Uint8Array.from([1])).digest('hex') }],
    })).toThrow('title')
  })

  it('sorts artifact-relative images canonically and is independent of machine paths and input order', () => {
    const first = createPreviewSnapshot(baseInput())
    const reversed = createPreviewSnapshot(baseInput({ localImages: [...baseInput().localImages].reverse() }))
    expect(reversed).toEqual(first)
    expect(first.localImages.map(image => image.path)).toEqual([
      `revisions/${'a'.repeat(64)}/images/a.png`,
      `revisions/${'a'.repeat(64)}/images/z.png`,
    ])
    expect(() => createPreviewSnapshot(baseInput({ articlePath: '/private/machine/article.md' }))).toThrow('artifact')
    expect(() => createPreviewSnapshot(baseInput({ localImages: [
      { path: '/private/machine/image.png', bytes: Uint8Array.from([1]) },
    ] }))).toThrow('artifact')
    expect(() => createPreviewSnapshot(baseInput({ localImages: [
      { path: `revisions/${'a'.repeat(64)}/images/a.png`, bytes: Uint8Array.from([1]) },
      { path: `revisions/${'a'.repeat(64)}/images/A.png`, bytes: Uint8Array.from([1]) },
    ] }))).toThrow('duplicate')
    expect(() => createPreviewSnapshot(baseInput({ localImages: [
      { path: `revisions/${'a'.repeat(64)}/images/control\u0001.png`, bytes: Uint8Array.from([1]) },
    ] }))).toThrow('safe')
  })

  it('validates a current signed receipt and rejects every changed or missing binding as stale', async () => {
    const input = baseInput()
    const snapshot = createPreviewSnapshot(input)
    const html = encoder.encode('<article>ready</article>')
    const previewHtmlPath = `revisions/${snapshot.revisionId}/previews/html/${snapshot.id}.html`
    const receipt = createPreviewReceipt({
      snapshot,
      previewHtmlPath,
      previewHtmlBytes: html,
      credentialValue: input.credentialValue,
      issuedAt: '2026-08-25T00:00:00.000Z',
      expiresAt: '2026-08-25T00:10:00.000Z',
      ...receiptProjection(input),
    })
    await store.writeAtomic(previewHtmlPath, html)
    const committed = await publishPreviewSnapshot(store, { state: 'published', snapshot, receipt, ownership: createPreviewPublicationOwnership() })
    const verified = await validateCurrentPreview(store, {
      snapshotInput: input,
      credentialValue: input.credentialValue,
      now: new Date('2026-08-25T00:05:00.000Z'),
    })
    expect(verified).toMatchObject({ snapshot, receipt, manifestPath: committed.manifestPath, htmlPath: previewHtmlPath })
    expect(Array.from(verified.htmlBytes)).toEqual(Array.from(html))

    const staleInputs = [
      baseInput({ articleBytes: encoder.encode('# Changed\n') }),
      baseInput({ localImages: input.localImages.map((image, index) => index === 0 ? { ...image, bytes: Uint8Array.from([9]) } : image) }),
      baseInput({ credentialValue: 'different-account' }),
      baseInput({ layoutBaseUrl: 'https://changed.example' }),
      baseInput({ previewSettings: { ...baseInput().previewSettings, output: 'changed' } }),
      baseInput({ pluginVersion: '2.0.0' }),
      baseInput({ cliVersion: '4.0.0' }),
    ]
    for (const snapshotInput of staleInputs) {
      await expect(validateCurrentPreview(store, {
        snapshotInput,
        credentialValue: snapshotInput.credentialValue,
        now: new Date('2026-08-25T00:05:00.000Z'),
      })).rejects.toThrow('stale preview')
    }
    await expect(validateCurrentPreview(store, {
      snapshotInput: input,
      credentialValue: input.credentialValue,
      now: new Date('2026-08-25T00:10:00.001Z'),
    })).rejects.toThrow('stale preview')
    await expect(validateCurrentPreview(store, {
      snapshotInput: input,
      credentialValue: input.credentialValue,
      now: new Date('2026-08-24T23:59:59.999Z'),
    })).rejects.toThrow('stale preview')
    await expect(validateCurrentPreview(store, {
      snapshotInput: input,
      credentialValue: input.credentialValue,
      now: new Date(Number.NaN),
    })).rejects.toThrow('stale preview')

    const receiptPath = `revisions/${snapshot.revisionId}/previews/receipts/${receipt.id}.json`
    const originalReceipt = await store.read(receiptPath)
    const mutatedReceipt = JSON.parse(new TextDecoder().decode(originalReceipt)) as Record<string, unknown>
    mutatedReceipt.signature = '0'.repeat(64)
    await store.writeAtomic(receiptPath, encoder.encode(`${JSON.stringify(mutatedReceipt)}\n`))
    await expect(validateCurrentPreview(store, {
      snapshotInput: input, credentialValue: input.credentialValue, now: new Date('2026-08-25T00:05:00.000Z'),
    })).rejects.toThrow('stale preview')
    await store.writeAtomic(receiptPath, originalReceipt)

    await store.writeAtomic(previewHtmlPath, encoder.encode('<article>changed</article>'))
    await expect(validateCurrentPreview(store, {
      snapshotInput: input, credentialValue: input.credentialValue, now: new Date('2026-08-25T00:05:00.000Z'),
    })).rejects.toThrow('stale preview')
  })

  it('returns fixed safe stale and cancellation errors without causes, paths, or raw signal reasons', async () => {
    const raw = `raw-provider ${workspace} credential-reference`
    const failingStore = Object.create(store) as ArtifactStore
    failingStore.read = () => Promise.reject(new Error(raw))
    const stale = await validateCurrentPreview(failingStore, {
      snapshotInput: baseInput(), credentialValue: 'secret-one', now: new Date('2026-08-25T00:05:00.000Z'),
    }).catch((error: unknown) => error)
    expect(stale).toBeInstanceOf(Error)
    expect((stale as Error).message).toBe('stale preview')
    expect(stale).not.toHaveProperty('cause')
    expect((stale as Error).stack).toBe('Error: stale preview')
    expect(String(stale)).not.toContain(raw)
    expect(String((stale as Error).stack)).not.toContain(workspace)

    const controller = new AbortController()
    controller.abort(new Error(raw))
    const cancelled = await validateCurrentPreview(store, {
      snapshotInput: baseInput(), credentialValue: 'secret-one', now: new Date('2026-08-25T00:05:00.000Z'), signal: controller.signal,
    }).catch((error: unknown) => error)
    expect(cancelled).toBeInstanceOf(Error)
    expect((cancelled as Error).message).toBe('preview validation cancelled')
    expect(cancelled).not.toHaveProperty('cause')
    expect((cancelled as Error).stack).toBe('Error: preview validation cancelled')
    expect(String(cancelled)).not.toContain(raw)
  })

  it('rejects deleted snapshot, receipt, HTML, pointer path changes, and a consistently addressed invalid signature', async () => {
    const input = baseInput()
    const snapshot = createPreviewSnapshot(input)
    const html = encoder.encode('<article>ready</article>')
    const previewHtmlPath = `revisions/${snapshot.revisionId}/previews/html/${snapshot.id}.html`
    const receipt = createPreviewReceipt({
      snapshot, previewHtmlPath, previewHtmlBytes: html, credentialValue: input.credentialValue,
      issuedAt: '2026-08-25T00:00:00.000Z', expiresAt: '2026-08-25T00:10:00.000Z',
      ...receiptProjection(input),
    })
    await store.writeAtomic(previewHtmlPath, html)
    const committed = await publishPreviewSnapshot(store, { state: 'published', snapshot, receipt, ownership: createPreviewPublicationOwnership() })
    const snapshotPath = `revisions/${snapshot.revisionId}/previews/snapshots/${snapshot.id}.json`
    const receiptPath = `revisions/${snapshot.revisionId}/previews/receipts/${receipt.id}.json`
    const snapshotBytes = await store.read(snapshotPath)
    const receiptBytes = await store.read(receiptPath)
    const pointerBytes = await store.read(committed.manifestPath)
    const assertStale = async (): Promise<void> => {
      await expect(validateCurrentPreview(store, {
        snapshotInput: input, credentialValue: input.credentialValue, now: new Date('2026-08-25T00:05:00.000Z'),
      })).rejects.toThrow('stale preview')
    }

    const snapshotValue = JSON.parse(new TextDecoder().decode(snapshotBytes)) as Record<string, unknown>
    await store.writeAtomic(snapshotPath, encoder.encode(`${JSON.stringify(snapshotValue, undefined, 2)}\n`))
    await assertStale()
    await store.writeAtomic(snapshotPath, snapshotBytes)

    await import('node:fs/promises').then(fs => fs.rm(store.resolve(snapshotPath)))
    await assertStale()
    await store.writeAtomic(snapshotPath, snapshotBytes)
    await import('node:fs/promises').then(fs => fs.rm(store.resolve(receiptPath)))
    await assertStale()
    await store.writeAtomic(receiptPath, receiptBytes)
    await import('node:fs/promises').then(fs => fs.rm(store.resolve(previewHtmlPath)))
    await assertStale()
    await store.writeAtomic(previewHtmlPath, html)

    const pointer = JSON.parse(new TextDecoder().decode(pointerBytes)) as Record<string, unknown>
    pointer.previewHtmlPath = `revisions/${snapshot.revisionId}/previews/html/${'b'.repeat(64)}.html`
    await store.writeAtomic(committed.manifestPath, canonicalBytes(pointer))
    await assertStale()

    const invalidSignature = createPreviewReceipt({
      snapshot, previewHtmlPath, previewHtmlBytes: html, credentialValue: 'wrong-proof-key',
      issuedAt: '2026-08-25T00:00:00.000Z', expiresAt: '2026-08-25T00:10:00.000Z',
      ...receiptProjection(input),
    })
    await publishPreviewSnapshot(store, { state: 'published', snapshot, receipt: invalidSignature, ownership: createPreviewPublicationOwnership() })
    await assertStale()
  })

  it('cleans only matching uncommitted artifacts and retains committed state idempotently', async () => {
    const input = baseInput()
    const snapshot = createPreviewSnapshot(input)
    const html = encoder.encode('<article>ready</article>')
    const previewHtmlPath = `revisions/${snapshot.revisionId}/previews/html/${snapshot.id}.html`
    const receipt = createPreviewReceipt({
      snapshot, previewHtmlPath, previewHtmlBytes: html, credentialValue: input.credentialValue,
      issuedAt: '2026-08-25T00:00:00.000Z', expiresAt: '2026-08-25T00:10:00.000Z',
      ...receiptProjection(input),
    })
    const ownership = createPreviewPublicationOwnership()
    ownership.html.created = true
    ownership.snapshot.created = true
    ownership.receipt.created = true
    const published: PreviewTransaction = { state: 'published', snapshot, receipt, ownership }
    await store.writeAtomic(previewHtmlPath, html)
    await store.writeAtomic(`revisions/${snapshot.revisionId}/previews/snapshots/${snapshot.id}.json`, canonicalBytes(snapshot))
    await store.writeAtomic(`revisions/${snapshot.revisionId}/previews/receipts/${receipt.id}.json`, canonicalBytes(receipt))

    await cleanupPreviewSnapshot(store, published)
    await cleanupPreviewSnapshot(store, published)
    await expect(store.read(previewHtmlPath)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })

    await store.writeAtomic(previewHtmlPath, html)
    const committed = await publishPreviewSnapshot(store, published)
    await cleanupPreviewSnapshot(store, committed)
    expect(Array.from(await store.read(previewHtmlPath))).toEqual(Array.from(html))
  })

  it('retains a prepared snapshot referenced by current and retains it when current is malformed', async () => {
    const input = baseInput()
    const snapshot = createPreviewSnapshot(input)
    const html = encoder.encode('<article>ready</article>')
    const previewHtmlPath = `revisions/${snapshot.revisionId}/previews/html/${snapshot.id}.html`
    const snapshotPath = `revisions/${snapshot.revisionId}/previews/snapshots/${snapshot.id}.json`
    const receipt = createPreviewReceipt({
      snapshot, previewHtmlPath, previewHtmlBytes: html, credentialValue: input.credentialValue,
      issuedAt: '2026-08-25T00:00:00.000Z', expiresAt: '2026-08-25T00:10:00.000Z',
      ...receiptProjection(input),
    })
    await store.writeAtomic(previewHtmlPath, html)
    await publishPreviewSnapshot(store, { state: 'published', snapshot, receipt, ownership: createPreviewPublicationOwnership() })

    await cleanupPreviewSnapshot(store, { state: 'prepared', snapshot })
    expect(Array.from(await store.read(snapshotPath))).toEqual(Array.from(canonicalBytes(snapshot)))

    await store.writeAtomic(`revisions/${snapshot.revisionId}/previews/current.json`, encoder.encode('{}\n'))
    await cleanupPreviewSnapshot(store, { state: 'prepared', snapshot })
    expect(Array.from(await store.read(snapshotPath))).toEqual(Array.from(canonicalBytes(snapshot)))
  })
})
