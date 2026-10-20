import { describe, expect, it } from 'vitest'
import type { CreatorDocumentV1 } from '../../src/creator/types.ts'
import { CreatorService } from '../../src/creator/service.ts'

const agent = { id: 'owner-a' } as never
const documents = new Map<string, CreatorDocumentV1>()
const barriers = new Map<string, { kind: 'materials' | 'draft'; token: string }>()
function operations() {
  return {
    documents: { deliveryStatus: async (id: string) => barriers.get(id), beginDelivery: async (id: string, kind: 'materials' | 'draft') => { const token = 'attempt'; barriers.set(id, { kind, token }); return token }, completeDelivery: async (id: string) => { barriers.delete(id) }, reconcileDelivery: async (id: string) => { barriers.delete(id) }, list: async () => [], read: async (id: string) => documents.get(id), save: async (document: CreatorDocumentV1) => { documents.set(document.articleId, document) } },
    assertReadable: async () => {},
    sourceSnapshot: async () => ({ path: 'article.md', sha256: 'a'.repeat(64) }),
    discoverRevisions: async () => [],
    loadRevision: async (manifestPath: string) => ({ id: manifestPath.split('/')[1]!, manifestPath, markdown: '# 文章', title: '文章' }),
    validateCandidates: async (_revision: unknown, candidates: any[]) => candidates,
    prepareDelivery: async () => { throw new Error('not prepared') },
    exportFinal: async () => ({ path: 'final.html' }),
    createDraft: async () => ({ draftId: 'draft' }),
    generateImages: async () => ({ kind: 'completed' as const, sourcePaths: [] }),
    requestImages: async () => {},
    importImage: async () => { throw new Error('no image') },
    rebindImages: async () => [],
    exportHtml: async () => ({ path: 'exports/article.html' }),
    suggest: async () => {},
    revise: async (revision: any, markdown: string) => ({ ...revision, id: 'revision-b', markdown }),
    restore: async (revision: any) => revision,
    assertWritable: async () => {},
    themes: async () => [{ name: 'default', description: '默认' }, { name: 'simple', description: '简洁' }],
    start: async () => ({ id: 'revision-a', manifestPath: 'revisions/a/manifest.json', title: '文章', markdown: '# 文章' }),
    preview: async (_revision: unknown, theme: string) => ({ path: theme + '.html', receipt: theme, sha256: 'digest' }),
  }
}

describe('creator service boundary', () => {
  it('keeps another session from reading or changing an owned article', async () => {
    const service = new CreatorService(() => operations(), 'default')
    const view = await service.open(agent, 'article.md', '', new AbortController().signal)
    await expect(service.get({ id: 'other' } as never, view.articleId)).rejects.toThrow('文章')
    await expect(service.dispatch({ id: 'other' } as never, view.articleId, 1, { type: 'select-theme', theme: 'simple' }, new AbortController().signal)).rejects.toThrow('文章')
  })
  it('selects only the owned runtime theme and renders that choice', async () => {
    const service = new CreatorService(() => operations(), 'default')
    const view = await service.open(agent, 'article.md', '', new AbortController().signal)
    const selected = await service.dispatch(agent, view.articleId, 1, { type: 'select-theme', theme: 'simple' }, new AbortController().signal)
    const rendered = await service.dispatch(agent, view.articleId, selected.version, { type: 'refresh-preview' }, new AbortController().signal)
    expect(rendered.preview).toMatchObject({ status: 'ready', path: 'simple.html' })
  })
  it('does not create or render anything when session policy is read-only', async () => {
    let started = false
    const service = new CreatorService(() => ({ ...operations(), assertWritable: async () => { throw new Error('只读') }, start: async () => { started = true; return operations().start() } }), 'default')
    await expect(service.open(agent, 'article.md', '', new AbortController().signal)).rejects.toThrow('只读')
    expect(started).toBe(false)
  })
})


it('requires explicit application; stale proposals and concurrent writes cannot change current state', async () => {
  const service = new CreatorService(() => operations(), 'default')
  const signal = new AbortController().signal
  const opened = await service.open(agent, 'article.md', '', signal)
  const requested = await service.dispatch(agent, opened.articleId, 1, { type: 'request-suggestions', kind: 'title' }, signal)
  await service.propose(agent, opened.articleId, 1, requested.suggestionRequest!.id, [{ title: '标题', reason: '具体', before: '# 文章', after: '# 新文章' }])
  expect((await service.get(agent, opened.articleId)).markdown).toBe('# 文章')
  const suggested = await service.get(agent, opened.articleId)
  const applied = await service.dispatch(agent, opened.articleId, 1, { type: 'apply-suggestion', suggestionId: suggested.suggestions[0]!.id }, signal)
  expect(applied).toMatchObject({ version: 2, markdown: '# 新文章', canUndo: true })
  await expect(service.propose(agent, opened.articleId, 1, requested.suggestionRequest!.id, [])).rejects.toThrow('更新')
  const undone = await service.dispatch(agent, opened.articleId, 2, { type: 'undo-edit' }, signal)
  expect(undone).toMatchObject({ version: 3, markdown: '# 文章', canUndo: false })
})


it('exports only after reviewing current preview and invalidates review after changes', async () => {
  let count = 0
  const service = new CreatorService(() => ({ ...operations(), exportHtml: async () => { count++; return { path: 'exports/article.html' } } }), 'default')
  const signal = new AbortController().signal
  const view = await service.open(agent, 'a.md', '', signal)
  await service.dispatch(agent, view.articleId, 1, { type: 'refresh-preview' }, signal)
  await expect(service.dispatch(agent, view.articleId, 1, { type: 'export-html', destination: 'exports/article.html' }, signal)).rejects.toThrow('审阅')
  await service.dispatch(agent, view.articleId, 1, { type: 'review-current', previewPath: 'default.html', previewSha256: 'digest', publicationTitle: '文章' }, signal)
  const exported = await service.dispatch(agent, view.articleId, 1, { type: 'export-html', destination: 'exports/article.html' }, signal)
  expect(exported.delivery).toMatchObject({ kind: 'export', status: 'completed', path: 'exports/article.html' })
  expect(count).toBe(1)
  await service.dispatch(agent, view.articleId, 1, { type: 'select-theme', theme: 'simple' }, signal)
  await expect(service.dispatch(agent, view.articleId, 2, { type: 'export-html', destination: 'exports/article.html' }, signal)).rejects.toThrow('审阅')
})

it('rejects image candidates from another request and only selects a cover explicitly', async () => {
  const revisionId = 'a'.repeat(64)
  const candidate = { id: 'cover', revisionId, kind: 'cover' as const, path: `revisions/${revisionId}/images/cover.png`, sha256: 'b'.repeat(64), contentType: 'image/png' as const, byteSize: 10, alt: '封面' }
  const service = new CreatorService(() => ({ ...operations(), start: async () => ({ id: revisionId, manifestPath: `revisions/${revisionId}/manifest.json`, title: '文章', markdown: '# 文章\n\n正文。' }), requestImages: async () => {}, importImage: async () => candidate }), 'default')
  const signal = new AbortController().signal
  const view = await service.open(agent, 'a.md', '', signal)
  const requested = await service.dispatch(agent, view.articleId, 1, { type: 'request-images', kind: 'cover', anchorId: '' }, signal)
  await expect(service.importImage(agent, view.articleId, 1, 'wrong', 'cover.png', '封面', signal)).rejects.toThrow('请求')
  await service.importImage(agent, view.articleId, 1, requested.imageRequest!.id, 'cover.png', '封面', signal)
  expect((await service.get(agent, view.articleId)).coverId).toBe('')
  const selected = await service.dispatch(agent, view.articleId, 1, { type: 'select-cover', candidateId: 'cover' }, signal)
  expect(selected).toMatchObject({ coverId: 'cover', version: 2, reviewed: false })
})

it('prepares selected materials before renewed review and blocks duplicate uncertain draft attempts', async () => {
  const { CreatorDeliveryUnknownError } = await import('../../src/creator/delivery.ts')
  const revisionId = 'a'.repeat(64)
  let draftCalls = 0
  const fakeProof = { id: 'final', revisionId, theme: 'default', path: 'final.html', sha256: 'b'.repeat(64), assets: [], coverId: 'cover', expiresAt: '2099-01-01T00:00:00Z' }
  const service = new CreatorService(() => ({ ...operations(),
    start: async () => ({ id: revisionId, manifestPath: `revisions/${revisionId}/manifest.json`, title: '文章', markdown: '# 文章' }),
    importImage: async () => ({ id: 'cover', revisionId, kind: 'cover', path: `revisions/${revisionId}/images/c.png`, sha256: 'c'.repeat(64), byteSize: 10, contentType: 'image/png', alt: '封面' }),
    prepareDelivery: async () => fakeProof,
    createDraft: async () => { draftCalls++; throw new CreatorDeliveryUnknownError('unknown') },
  }), 'default', '.md2wechat', true)
  const signal = new AbortController().signal
  const opened = await service.open(agent, 'a.md', '', signal)
  await service.dispatch(agent, opened.articleId, 1, { type: 'import-local-image', kind: 'cover', anchorId: '', sourcePath: 'c.png', alt: '封面' }, signal)
  await service.dispatch(agent, opened.articleId, 1, { type: 'select-cover', candidateId: 'cover' }, signal)
  await service.dispatch(agent, opened.articleId, 2, { type: 'refresh-preview' }, signal)
  await service.dispatch(agent, opened.articleId, 2, { type: 'review-current', previewPath: 'default.html', previewSha256: 'digest', publicationTitle: '文章' }, signal)
  const final = await service.dispatch(agent, opened.articleId, 2, { type: 'prepare-delivery' }, signal)
  expect(final).toMatchObject({ reviewed: false, preparedForDraft: true, preview: { path: 'final.html' } })
  await expect(service.dispatch(agent, opened.articleId, 2, { type: 'create-draft', confirmed: true }, signal)).rejects.toThrow('审阅')
  await service.dispatch(agent, opened.articleId, 2, { type: 'review-current', previewPath: 'final.html', previewSha256: 'b'.repeat(64), publicationTitle: '文章' }, signal)
  await expect(service.dispatch(agent, opened.articleId, 2, { type: 'create-draft', confirmed: false }, signal)).rejects.toThrow('确认')
  const unknown = await service.dispatch(agent, opened.articleId, 2, { type: 'create-draft', confirmed: true }, signal)
  expect(unknown.delivery?.status).toBe('unknown')
  expect(draftCalls).toBe(1)
})

it('does not let an action awaiting policy validation change a version during delivery', async () => {
  let blockNext = false
  let releasePolicy!: () => void
  let releaseExport!: () => void
  let exportStarted!: () => void
  const started = new Promise<void>(resolve => { exportStarted = resolve })
  const service = new CreatorService(() => ({ ...operations(),
    assertWritable: async () => { if (blockNext) { blockNext = false; await new Promise<void>(resolve => { releasePolicy = resolve }) } },
    exportHtml: async () => { exportStarted(); await new Promise<void>(resolve => { releaseExport = resolve }); return { path: 'out.html' } },
  }), 'default')
  const signal = new AbortController().signal
  const opened = await service.open(agent, 'a.md', '', signal)
  await service.dispatch(agent, opened.articleId, 1, { type: 'refresh-preview' }, signal)
  await service.dispatch(agent, opened.articleId, 1, { type: 'review-current', previewPath: 'default.html', previewSha256: 'digest', publicationTitle: '文章' }, signal)
  blockNext = true
  const change = service.dispatch(agent, opened.articleId, 1, { type: 'select-theme', theme: 'simple' }, signal)
  const exported = service.dispatch(agent, opened.articleId, 1, { type: 'export-html', destination: 'out.html' }, signal)
  await started
  releasePolicy()
  await expect(change).rejects.toThrow('稍候')
  expect(await service.get(agent, opened.articleId)).toMatchObject({ version: 1, theme: 'default' })
  releaseExport()
  expect(await exported).toMatchObject({ version: 1, theme: 'default', delivery: { status: 'completed' } })
})

it('returns the same fallback job for repeated or concurrent calls of one image request', async () => {
  let calls = 0
  const service = new CreatorService(() => ({ ...operations(), generateImages: async () => { calls++; return { kind: 'background' as const, jobId: 'one-job', sourcePaths: ['image.png'] } } }), 'default')
  const signal = new AbortController().signal
  const opened = await service.open(agent, 'a.md', '', signal)
  const requested = await service.dispatch(agent, opened.articleId, 1, { type: 'request-images', kind: 'cover', anchorId: '' }, signal)
  const args = [agent, opened.articleId, 1, requested.imageRequest!.id, signal] as const
  const [a, b] = await Promise.all([service.generateImages(...args), service.generateImages(...args)])
  expect(a).toEqual(b)
  expect(calls).toBe(1)
  await service.generateImages(...args)
  expect(calls).toBe(1)
})
