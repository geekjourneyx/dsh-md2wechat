import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { CreatorService } from '../../src/creator/service.ts'
import type { CreatorOperations } from '../../src/creator/service.ts'
import type { CreatorDocumentV1 } from '../../src/creator/types.ts'
import type { CreatorRevision } from '../../src/creator/session.ts'

const agent = { id: 'owner-a' } as never
const signal = new AbortController().signal
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function fixture() {
  const documents = new Map<string, CreatorDocumentV1>()
  const barriers = new Map<string, { kind: 'materials' | 'draft'; token: string }>()
  const revisions = new Map<string, CreatorRevision>()
  let source = '# 文章\n\n正文。'; let failSave = false; let writable = true; let readable = true; let themeAvailable = true
  let externalCalls = 0; let candidateValid = true
  const revision = (markdown: string) => {
    const id = hash(markdown)
    const value = { id, manifestPath: `revisions/${id}/manifest.json`, title: '文章', markdown }
    revisions.set(value.manifestPath, value)
    return value
  }
  const ops: CreatorOperations = {
    documents: {
      deliveryStatus: async id => barriers.get(id),
      beginDelivery: async (id, kind) => { if (barriers.has(id)) throw new Error('核对'); const token = `${kind}-${Date.now()}`; barriers.set(id, { kind, token }); return token },
      completeDelivery: async (id, token) => { if (barriers.get(id)?.token === token) barriers.delete(id) },
      reconcileDelivery: async id => { barriers.delete(id) },
      list: async () => structuredClone([...documents.values()]),
      read: async (id: string) => structuredClone(documents.get(id)),
      save: async (document: CreatorDocumentV1) => { if (failSave) throw new Error('disk full'); documents.set(document.articleId, structuredClone(document)) },
    },
    sourceSnapshot: async () => ({ path: 'a.md', sha256: hash(source) }),
    discoverRevisions: async () => [],
    loadRevision: async path => { const value = revisions.get(path); if (!value) throw new Error('revision missing'); return { ...value } },
    validateCandidates: async (_revision, candidates) => { if (!candidateValid) throw new Error('candidate changed'); return [...candidates] },
    assertReadable: async () => { if (!readable) throw new Error('read denied') },
    assertWritable: async () => { if (!writable) throw new Error('只读') },
    themes: async () => themeAvailable ? [{ name: 'default', description: '默认' }, { name: 'simple', description: '简洁' }] : [{ name: 'default', description: '默认' }],
    start: async () => revision(source),
    restore: async value => value,
    revise: async (_old, markdown) => revision(markdown),
    preview: async () => ({ path: 'preview.html', receipt: 'receipt', sha256: hash('preview') }),
    suggest: async () => { externalCalls++ }, requestImages: async () => { externalCalls++ },
    generateImages: async () => { externalCalls++; return { kind: 'completed', sourcePaths: [] } },
    prepareDelivery: async () => { externalCalls++; throw new Error('not prepared') },
    exportFinal: async () => { externalCalls++; return { path: 'final.html' } },
    exportHtml: async () => { externalCalls++; return { path: 'out.html' } },
    createDraft: async () => { externalCalls++; return { draftId: 'draft' } },
    importImage: async value => ({ id: 'cover', revisionId: value.id, kind: 'cover', path: `revisions/${value.id}/images/c.png`, sha256: hash('image'), contentType: 'image/png', byteSize: 10, alt: '封面' }),
    rebindImages: async (value, candidates) => candidates.map(candidate => ({ ...candidate, revisionId: value.id, path: candidate.path.replace(/^revisions\/[^/]+/u, `revisions/${value.id}`) })),
  }
  const service = () => new CreatorService(() => ops, 'default', '.md2wechat', true)
  return { service, ops, documents, revisions, setSource: (value: string) => { source = value }, failSave: () => { failSave = true }, readonly: () => { writable = false }, denyReads: () => { readable = false }, removeTheme: () => { themeAvailable = false }, invalidateCandidate: () => { candidateValid = false }, calls: () => externalCalls }
}

async function edited(f: ReturnType<typeof fixture>) {
  const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
  const requested = await service.dispatch(agent, opened.articleId, 1, { type: 'request-suggestions', kind: 'polish' }, signal)
  await service.propose(agent, opened.articleId, 1, requested.suggestionRequest!.id, [{ title: '改进', reason: '明确', before: '正文。', after: '新正文。' }])
  const proposed = await service.get(agent, opened.articleId)
  const applied = await service.dispatch(agent, opened.articleId, 1, { type: 'apply-suggestion', suggestionId: proposed.suggestions[0]!.id }, signal)
  return { service, applied }
}

describe('durable creator lifecycle', () => {
  it('restores stable identity, saved text, theme, candidates, cover and undo after rebuilding the service', async () => {
    const f = fixture(); const { service, applied } = await edited(f)
    await service.dispatch(agent, applied.articleId, 2, { type: 'import-local-image', kind: 'cover', anchorId: '', sourcePath: 'c.png', alt: '封面' }, signal)
    await service.dispatch(agent, applied.articleId, 2, { type: 'select-cover', candidateId: 'cover' }, signal)
    const selected = await service.dispatch(agent, applied.articleId, 3, { type: 'select-theme', theme: 'simple' }, signal)
    const restarted = f.service()
    expect(await restarted.list(agent, signal)).toMatchObject([{ articleId: applied.articleId, version: 4 }])
    const restored = await restarted.resume(agent, applied.articleId, signal)
    expect(restored).toMatchObject({ articleId: applied.articleId, version: selected.version, markdown: '# 文章\n\n新正文。', theme: 'simple', coverId: 'cover', canUndo: true, reviewed: false, preparedForDraft: false })
    expect(restored.imageCandidates[0]?.path).toMatch(/^\.md2wechat\/revisions\//u)
    expect((await restarted.dispatch(agent, restored.articleId, 4, { type: 'undo-edit' }, signal)).markdown).toBe('# 文章\n\n正文。')
  })

  it('does not publish new UI state or overwrite the old durable state after a failed save', async () => {
    const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
    f.failSave()
    await expect(service.dispatch(agent, opened.articleId, 1, { type: 'select-theme', theme: 'simple' }, signal)).rejects.toThrow('disk full')
    expect(await service.get(agent, opened.articleId)).toMatchObject({ version: 1, theme: 'default' })
    expect(await f.service().resume(agent, opened.articleId, signal)).toMatchObject({ version: 1, theme: 'default' })
  })

  it('serializes competing commits and rejects a stale version rather than rolling back a newer state', async () => {
    const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
    const results = await Promise.allSettled([
      service.dispatch(agent, opened.articleId, 1, { type: 'select-theme', theme: 'simple' }, signal),
      service.dispatch(agent, opened.articleId, 1, { type: 'select-theme', theme: 'default' }, signal),
    ])
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(await f.service().resume(agent, opened.articleId, signal)).toMatchObject({ version: 2, theme: 'simple' })
  })

  it('never restores pending requests, review or prepared delivery authority or replays effects', async () => {
    const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
    await service.dispatch(agent, opened.articleId, 1, { type: 'refresh-preview' }, signal)
    await service.dispatch(agent, opened.articleId, 1, { type: 'review-current', previewPath: 'preview.html', previewSha256: hash('preview'), publicationTitle: '文章' }, signal)
    await service.dispatch(agent, opened.articleId, 1, { type: 'request-images', kind: 'cover', anchorId: '' }, signal)
    await service.dispatch(agent, opened.articleId, 1, { type: 'request-suggestions', kind: 'title' }, signal)
    const before = f.calls(); const restarted = f.service(); const restored = await restarted.get(agent, opened.articleId)
    expect(restored).toMatchObject({ reviewed: false, preparedForDraft: false, imageRequest: null, suggestionRequest: null, suggestions: [], preview: { status: 'empty' } })
    await expect(restarted.dispatch(agent, opened.articleId, 1, { type: 'create-draft', confirmed: true }, signal)).rejects.toThrow('审阅')
    expect(f.calls()).toBe(before)
    expect(JSON.stringify(f.documents.get(opened.articleId))).not.toMatch(/receipt|reviewed|requestId|controller|proof|promise/iu)
  })

  it('continues an unchanged source but requires an explicit choice when its bytes change', async () => {
    const f = fixture(); const { service, applied } = await edited(f)
    expect((await service.open(agent, 'a.md', '', signal)).articleId).toBe(applied.articleId)
    f.setSource('# Changed source')
    await expect(service.open(agent, 'a.md', '', signal)).rejects.toThrow('原文已变化')
    expect(await service.open(agent, 'a.md', '', signal, { mode: 'continue' })).toMatchObject({ articleId: applied.articleId, markdown: '# 文章\n\n新正文。' })
    const imported = await service.open(agent, 'a.md', '', signal, { mode: 'import-new' })
    expect(imported.articleId).not.toBe(applied.articleId)
    expect(imported.markdown).toBe('# Changed source')
    expect(f.documents.size).toBe(2)
  })

  it('validates current permissions and every restored revision and candidate reference', async () => {
    const f = fixture(); const { service, applied } = await edited(f)
    await service.dispatch(agent, applied.articleId, 2, { type: 'import-local-image', kind: 'cover', anchorId: '', sourcePath: 'c.png', alt: '封面' }, signal)
    f.invalidateCandidate()
    await expect(f.service().resume(agent, applied.articleId, signal)).rejects.toThrow('candidate changed')
    f.denyReads()
    await expect(service.get(agent, applied.articleId)).rejects.toThrow('read denied')
    await expect(f.service().list(agent, signal)).rejects.toThrow('read denied')
  })

  it('falls back from an unavailable saved theme with a visible review warning', async () => {
    const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
    await service.dispatch(agent, opened.articleId, 1, { type: 'select-theme', theme: 'simple' }, signal)
    f.removeTheme()
    const restored = await f.service().resume(agent, opened.articleId, signal)
    expect(restored).toMatchObject({ theme: 'default', reviewed: false })
    expect(restored.recovery?.message).toContain('主题')
  })

  it('lets a committed new theme cancel an old long-running preview without applying its result', async () => {
    const f = fixture(); let finish!: (value: { path: string; receipt: string }) => void; let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve }); let oldSignal: AbortSignal | undefined
    f.ops.preview = async (_revision, _theme, signal) => { oldSignal = signal; started(); return new Promise(resolve => { finish = resolve }) }
    const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
    const preview = service.dispatch(agent, opened.articleId, 1, { type: 'refresh-preview' }, signal); await ready
    await service.dispatch(agent, opened.articleId, 1, { type: 'select-theme', theme: 'simple' }, signal)
    expect(oldSignal?.aborted).toBe(true)
    finish({ path: 'old.html', receipt: 'old' })
    expect(await preview).toMatchObject({ version: 2, theme: 'simple' })
    expect((await service.get(agent, opened.articleId)).preview.path).not.toBe('old.html')
  })
  it('restores saved progress for read-only viewing without trying to write a record', async () => {
    const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
    f.readonly(); f.failSave()
    const restored = await f.service().resume(agent, opened.articleId, signal)
    expect(restored.markdown).toContain('正文。')
    await expect(service.dispatch(agent, opened.articleId, 1, { type: 'select-theme', theme: 'simple' }, signal)).rejects.toThrow('只读')
  })

  it('keeps saved revisions recoverable when the original source is missing', async () => {
    const f = fixture(); const opened = await f.service().open(agent, 'a.md', '', signal)
    f.ops.sourceSnapshot = async () => { throw Object.assign(new Error('missing source'), { code: 'FS_NOT_FOUND' }) }
    const restored = await f.service().resume(agent, opened.articleId, signal)
    expect(restored).toMatchObject({ markdown: '# 文章\n\n正文。', recovery: { sourceChanged: true } })
  })

  it('commits a request before a provider can immediately return its suggestions', async () => {
    const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
    f.ops.suggest = async (_revision, _kind, request) => {
      await service.propose(agent, request.articleId, request.version, request.requestId, [{ title: '明确', reason: '更好', before: '正文。', after: '新正文。' }])
    }
    const returned = await service.dispatch(agent, opened.articleId, 1, { type: 'request-suggestions', kind: 'polish' }, signal)
    expect(returned.suggestions).toHaveLength(1)
  })

  it('retains unknown remote delivery across restart, new preview and theme changes until explicit reconciliation', async () => {
    const { CreatorDeliveryUnknownError } = await import('../../src/creator/delivery.ts')
    const f = fixture(); let prepareCalls = 0
    f.ops.prepareDelivery = async () => { prepareCalls++; throw new CreatorDeliveryUnknownError('unknown') }
    const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
    await service.dispatch(agent, opened.articleId, 1, { type: 'import-local-image', kind: 'cover', anchorId: '', sourcePath: 'c.png', alt: '封面' }, signal)
    await service.dispatch(agent, opened.articleId, 1, { type: 'select-cover', candidateId: 'cover' }, signal)
    await service.dispatch(agent, opened.articleId, 2, { type: 'refresh-preview' }, signal)
    expect((await service.dispatch(agent, opened.articleId, 2, { type: 'prepare-delivery' }, signal)).delivery).toMatchObject({ kind: 'materials', status: 'unknown' })
    const restarted = f.service()
    expect((await restarted.get(agent, opened.articleId)).delivery).toMatchObject({ kind: 'materials', status: 'unknown' })
    expect((await restarted.dispatch(agent, opened.articleId, 2, { type: 'select-theme', theme: 'simple' }, signal)).delivery?.status).toBe('unknown')
    await restarted.dispatch(agent, opened.articleId, 3, { type: 'refresh-preview' }, signal)
    await expect(restarted.dispatch(agent, opened.articleId, 3, { type: 'prepare-delivery' }, signal)).rejects.toThrow('核对')
    await expect(restarted.dispatch(agent, opened.articleId, 3, { type: 'create-draft', confirmed: true }, signal)).rejects.toThrow('核对')
    expect(prepareCalls).toBe(1)
    await expect(restarted.dispatch(agent, opened.articleId, 3, { type: 'reconcile-delivery', confirmed: false }, signal)).rejects.toThrow('确认')
    const reconciled = await restarted.dispatch(agent, opened.articleId, 3, { type: 'reconcile-delivery', confirmed: true }, signal)
    expect(reconciled.delivery).toBeNull()
    expect((await f.service().get(agent, opened.articleId)).delivery).toBeNull()
  })

  it('clears the same attempt barrier on a definite preflight or approval failure before any remote write', async () => {
    const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
    await service.dispatch(agent, opened.articleId, 1, { type: 'import-local-image', kind: 'cover', anchorId: '', sourcePath: 'c.png', alt: '封面' }, signal)
    await service.dispatch(agent, opened.articleId, 1, { type: 'select-cover', candidateId: 'cover' }, signal)
    await service.dispatch(agent, opened.articleId, 2, { type: 'refresh-preview' }, signal)
    f.ops.prepareDelivery = async () => { throw new Error('approval rejected') }
    await expect(service.dispatch(agent, opened.articleId, 2, { type: 'prepare-delivery' }, signal)).rejects.toThrow('approval rejected')
    expect((await f.service().get(agent, opened.articleId)).delivery).toBeNull()
  })

  it('rejects a delivery made stale while its barrier check was awaiting before calling any provider', async () => {
    const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
    await service.dispatch(agent, opened.articleId, 1, { type: 'import-local-image', kind: 'cover', anchorId: '', sourcePath: 'c.png', alt: '封面' }, signal)
    await service.dispatch(agent, opened.articleId, 1, { type: 'select-cover', candidateId: 'cover' }, signal)
    await service.dispatch(agent, opened.articleId, 2, { type: 'refresh-preview' }, signal)
    const status = f.ops.documents.deliveryStatus; let reads = 0; let release!: () => void; let reached!: () => void; let calls = 0
    const waiting = new Promise<void>(resolve => { reached = resolve })
    f.ops.documents.deliveryStatus = async (...args) => { if (++reads === 2) { reached(); await new Promise<void>(resolve => { release = resolve }) }; return status(...args) }
    f.ops.prepareDelivery = async () => { calls++; throw new Error('unexpected stale provider call') }
    const preparing = service.dispatch(agent, opened.articleId, 2, { type: 'prepare-delivery' }, signal).catch(error => error)
    await waiting
    await service.dispatch(agent, opened.articleId, 2, { type: 'select-theme', theme: 'simple' }, signal)
    release()
    expect(await preparing).toBeInstanceOf(Error)
    expect(calls).toBe(0)
    expect(await f.ops.documents.deliveryStatus(opened.articleId)).toBeUndefined()
  })

  it('does not execute fallback image generation after the request was canceled during policy validation', async () => {
    const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
    const requested = await service.dispatch(agent, opened.articleId, 1, { type: 'request-images', kind: 'cover', anchorId: '' }, signal)
    let block = true; let release!: () => void; let reached!: () => void; let calls = 0
    const waiting = new Promise<void>(resolve => { reached = resolve })
    f.ops.assertWritable = async () => { if (block) { block = false; reached(); await new Promise<void>(resolve => { release = resolve }) } }
    f.ops.generateImages = async () => { calls++; return { kind: 'completed', sourcePaths: [] } }
    const generating = service.generateImages(agent, opened.articleId, 1, requested.imageRequest!.id, signal).catch(error => error)
    await waiting
    await service.dispatch(agent, opened.articleId, 1, { type: 'select-theme', theme: 'simple' }, signal)
    release()
    expect(await generating).toBeInstanceOf(Error)
    expect(calls).toBe(0)
  })

  it('merges three simultaneous valid candidate imports without dropping unrelated current suggestions', async () => {
    const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
    const requested = await service.dispatch(agent, opened.articleId, 1, { type: 'request-images', kind: 'cover', anchorId: '' }, signal)
    let count = 0; let reached!: () => void; const releases: Array<() => void> = []
    const waiting = new Promise<void>(resolve => { reached = resolve })
    f.ops.importImage = async (revision, source) => {
      await new Promise<void>(resolve => { releases.push(resolve); if (++count === 3) reached() })
      return { id: source, revisionId: revision.id, kind: 'cover', path: `revisions/${revision.id}/images/${source}.png`, sha256: hash(source), contentType: 'image/png', byteSize: 10, alt: source }
    }
    const imports = Promise.allSettled(['one', 'two', 'three'].map(source => service.importImage(agent, opened.articleId, 1, requested.imageRequest!.id, source, source, signal)))
    await waiting
    const suggested = await service.dispatch(agent, opened.articleId, 1, { type: 'request-suggestions', kind: 'title' }, signal)
    releases.forEach(release => release())
    expect((await imports).map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled'])
    const current = await service.get(agent, opened.articleId)
    expect(current.imageCandidates.map(candidate => candidate.id).sort()).toEqual(['one', 'three', 'two'])
    expect(current.suggestionRequest?.id).toBe(suggested.suggestionRequest!.id)
    expect((await f.service().resume(agent, opened.articleId, signal)).imageCandidates).toHaveLength(3)
  })

  it('never creates a draft from an obsolete reviewed proof after an awaited barrier check', async () => {
    const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
    const revisionId = [...f.revisions.values()][0]!.id
    f.ops.prepareDelivery = async () => ({ id: 'final', revisionId, theme: 'default', path: 'final.html', sha256: hash('final'), assets: [], coverId: 'cover', expiresAt: '2099-01-01T00:00:00Z' })
    await service.dispatch(agent, opened.articleId, 1, { type: 'import-local-image', kind: 'cover', anchorId: '', sourcePath: 'c.png', alt: '封面' }, signal)
    await service.dispatch(agent, opened.articleId, 1, { type: 'select-cover', candidateId: 'cover' }, signal)
    await service.dispatch(agent, opened.articleId, 2, { type: 'refresh-preview' }, signal)
    await service.dispatch(agent, opened.articleId, 2, { type: 'prepare-delivery' }, signal)
    await service.dispatch(agent, opened.articleId, 2, { type: 'review-current', previewPath: 'final.html', previewSha256: hash('final'), publicationTitle: '文章' }, signal)
    const status = f.ops.documents.deliveryStatus; let reads = 0; let release!: () => void; let reached!: () => void; let calls = 0
    const waiting = new Promise<void>(resolve => { reached = resolve })
    f.ops.documents.deliveryStatus = async (...args) => { if (++reads === 2) { reached(); await new Promise<void>(resolve => { release = resolve }) }; return status(...args) }
    f.ops.createDraft = async () => { calls++; return { draftId: 'obsolete' } }
    const creating = service.dispatch(agent, opened.articleId, 2, { type: 'create-draft', confirmed: true }, signal).catch(error => error)
    await waiting
    await service.dispatch(agent, opened.articleId, 2, { type: 'select-theme', theme: 'simple' }, signal)
    release()
    expect(await creating).toBeInstanceOf(Error)
    expect(calls).toBe(0)
    expect(await f.ops.documents.deliveryStatus(opened.articleId)).toBeUndefined()
    expect(await service.get(agent, opened.articleId)).toMatchObject({ theme: 'simple', reviewed: false })
  })

  it('merges only valid request members, deduplicates identical arrivals and rejects conflicts or a fourth candidate', async () => {
    const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
    const requested = await service.dispatch(agent, opened.articleId, 1, { type: 'request-images', kind: 'cover', anchorId: '' }, signal)
    f.ops.importImage = async (revision, source) => ({ id: source === 'conflict' ? 'one' : source, revisionId: revision.id, kind: 'cover', path: `revisions/${revision.id}/images/${source === 'conflict' ? 'one' : source}.png`, sha256: hash(source), contentType: 'image/png', byteSize: 10, alt: source })
    const args = [agent, opened.articleId, 1, requested.imageRequest!.id] as const
    const results = await Promise.allSettled(['one', 'two', 'three', 'four'].map(source => service.importImage(...args, source, source, signal)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3)
    await expect(service.importImage(...args, 'one', 'one', signal)).resolves.toBeUndefined()
    await expect(service.importImage(...args, 'conflict', 'conflict', signal)).rejects.toThrow('内容已经变化')
    expect((await service.get(agent, opened.articleId)).imageCandidates).toHaveLength(3)
  })

  it('rejects a candidate arriving after its current request or revision was canceled', async () => {
    const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
    const requested = await service.dispatch(agent, opened.articleId, 1, { type: 'request-images', kind: 'cover', anchorId: '' }, signal)
    const importImage = f.ops.importImage; let release!: () => void; let reached!: () => void
    const waiting = new Promise<void>(resolve => { reached = resolve })
    f.ops.importImage = async (...args) => { reached(); await new Promise<void>(resolve => { release = resolve }); return importImage(...args) }
    const importing = service.importImage(agent, opened.articleId, 1, requested.imageRequest!.id, 'cover.png', '封面', signal).catch(error => error)
    await waiting
    await service.dispatch(agent, opened.articleId, 1, { type: 'select-theme', theme: 'simple' }, signal)
    release()
    expect(await importing).toBeInstanceOf(Error)
    expect((await service.get(agent, opened.articleId)).imageCandidates).toEqual([])
  })

  it('keeps an in-flight reviewed draft reservation intact when an obsolete canceled preview rejects late', async () => {
    const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
    const revisionId = [...f.revisions.values()][0]!.id
    await service.dispatch(agent, opened.articleId, 1, { type: 'import-local-image', kind: 'cover', anchorId: '', sourcePath: 'c.png', alt: '封面' }, signal)
    await service.dispatch(agent, opened.articleId, 1, { type: 'select-cover', candidateId: 'cover' }, signal)
    let rejectOld!: (error: Error) => void; let previewStarted!: () => void; let draftStarted!: () => void; let finishDraft!: () => void; let draftCalls = 0
    const oldStarted = new Promise<void>(resolve => { previewStarted = resolve })
    const draftWaiting = new Promise<void>(resolve => { draftStarted = resolve })
    f.ops.preview = async (_revision, theme) => {
      if (theme === 'default') { previewStarted(); return new Promise((_resolve, reject) => { rejectOld = reject }) }
      return { path: 'simple.html', receipt: 'simple', sha256: hash('simple') }
    }
    f.ops.prepareDelivery = async (_revision, theme) => ({ id: 'final', revisionId, theme, path: 'final.html', sha256: hash('final'), assets: [], coverId: 'cover', expiresAt: '2099-01-01T00:00:00Z' })
    f.ops.createDraft = async () => { draftCalls++; draftStarted(); await new Promise<void>(resolve => { finishDraft = resolve }); return { draftId: 'saved-draft' } }
    const oldPreview = service.dispatch(agent, opened.articleId, 2, { type: 'refresh-preview' }, signal)
    await oldStarted
    await service.dispatch(agent, opened.articleId, 2, { type: 'select-theme', theme: 'simple' }, signal)
    await service.dispatch(agent, opened.articleId, 3, { type: 'refresh-preview' }, signal)
    await service.dispatch(agent, opened.articleId, 3, { type: 'prepare-delivery' }, signal)
    await service.dispatch(agent, opened.articleId, 3, { type: 'review-current', previewPath: 'final.html', previewSha256: hash('final'), publicationTitle: '文章' }, signal)
    const creating = service.dispatch(agent, opened.articleId, 3, { type: 'create-draft', confirmed: true }, signal).then(view => ({ view }), error => ({ error }))
    await draftWaiting
    rejectOld(new Error('late canceled preview'))
    await oldPreview
    finishDraft()
    expect(await creating).toMatchObject({ view: { theme: 'simple', version: 3, delivery: { kind: 'draft', status: 'completed', path: 'saved-draft' } } })
    expect(draftCalls).toBe(1)
    expect((await service.get(agent, opened.articleId)).delivery).toMatchObject({ status: 'completed', path: 'saved-draft' })
  })

  it('still publishes the error from a genuinely active failed preview', async () => {
    const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
    f.ops.preview = async () => { throw new Error('active preview failure') }
    const failed = await service.dispatch(agent, opened.articleId, 1, { type: 'refresh-preview' }, signal)
    expect(failed.preview.status).toBe('error')
    expect(failed.preview.message).toContain('预览未完成')
  })

})

it('marks failed imports as errors while retaining earlier successful candidates', async () => {
  const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
  const requested = await service.dispatch(agent, opened.articleId, 1, { type: 'request-images', kind: 'cover', anchorId: '' }, signal)
  await service.importImage(agent, opened.articleId, 1, requested.imageRequest!.id, 'cover.png', '封面', signal)
  const failure = new Error('image import failed')
  f.ops.importImage = async () => { throw failure }
  await expect(service.importImage(agent, opened.articleId, 1, requested.imageRequest!.id, 'bad.png', '', signal)).rejects.toBe(failure)
  expect(await service.get(agent, opened.articleId)).toMatchObject({ imageRequest: { status: 'error', completed: 1 }, imageCandidates: [{ id: 'cover' }] })
})

it('marks rejected fallback generation as error even after caller cancellation without writing storage', async () => {
  const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
  const requested = await service.dispatch(agent, opened.articleId, 1, { type: 'request-images', kind: 'cover', anchorId: '' }, signal)
  const abort = new AbortController(); const failure = new Error('provider canceled')
  f.ops.generateImages = async () => { abort.abort(); throw failure }
  f.ops.documents.save = async () => { throw new Error('cleanup must not write') }
  await expect(service.generateImages(agent, opened.articleId, 1, requested.imageRequest!.id, abort.signal)).rejects.toBe(failure)
  expect((await service.get(agent, opened.articleId)).imageRequest).toMatchObject({ status: 'error', completed: 0 })
})

it.each(['import', 'generate'] as const)('does not let a late %s failure poison a replacement request', async kind => {
  const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
  const requested = await service.dispatch(agent, opened.articleId, 1, { type: 'request-images', kind: 'cover', anchorId: '' }, signal)
  let reject!: (error: Error) => void; let started!: () => void
  const reached = new Promise<void>(resolve => { started = resolve })
  const pending = () => { started(); return new Promise<never>((_, fail) => { reject = fail }) }
  f.ops.importImage = pending; f.ops.generateImages = pending
  const args = [agent, opened.articleId, 1, requested.imageRequest!.id] as const
  const running = (kind === 'import' ? service.importImage(...args, 'cover.png', '', signal) : service.generateImages(...args, signal)).catch(error => error)
  await reached
  const next = await service.dispatch(agent, opened.articleId, 1, { type: 'request-images', kind: 'cover', anchorId: '' }, signal)
  const failure = new Error('old request failed'); reject(failure)
  expect(await running).toBe(failure)
  expect((await service.get(agent, opened.articleId)).imageRequest).toMatchObject({ id: next.imageRequest!.id, status: 'pending', completed: 0 })
})

it.each([false, true])('handles delayed background failure without affecting a newer request (%s)', async restart => {
  const f = fixture(); const service = f.service(); const opened = await service.open(agent, 'a.md', '', signal)
  const requested = await service.dispatch(agent, opened.articleId, 1, { type: 'request-images', kind: 'cover', anchorId: '' }, signal)
  let fail!: (error: Error) => void
  const completion = new Promise<void>((_, reject) => { fail = reject })
  f.ops.generateImages = async () => ({ kind: 'background', jobId: 'background-job', sourcePaths: [], completion })
  const response = await service.generateImages(agent, opened.articleId, 1, requested.imageRequest!.id, signal)
  expect(response).not.toHaveProperty('completion')
  await service.importImage(agent, opened.articleId, 1, requested.imageRequest!.id, 'cover.png', '封面', signal)
  const current = restart ? await service.dispatch(agent, opened.articleId, 1, { type: 'request-images', kind: 'cover', anchorId: '' }, signal) : requested
  fail(new Error('worker failed later'))
  await vi.waitFor(async () => {
    const view = await service.get(agent, opened.articleId)
    expect(view.imageRequest).toMatchObject({ id: current.imageRequest!.id, status: restart ? 'pending' : 'error', completed: restart ? 0 : 1 })
    expect(view.imageCandidates).toHaveLength(1)
  })
})
