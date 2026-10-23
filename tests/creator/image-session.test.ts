import { describe, expect, it } from 'vitest'
import { CreatorSession } from '../../src/creator/session.ts'
import type { ImageCandidate } from '../../src/creator/image-choices.ts'

const revisionId = 'a'.repeat(64)
const nextId = 'b'.repeat(64)
const themes = [{ name: 'default', description: '默认' }, { name: 'simple', description: '简洁' }]
const image = (id: string, kind: ImageCandidate['kind'] = 'cover', revision = revisionId): ImageCandidate => ({
  id, revisionId: revision, kind, path: `revisions/${revision}/images/${id}.png`,
  sha256: 'c'.repeat(64), contentType: 'image/png', byteSize: 10, alt: id,
})
const session = (markdown = '# 标题\n\n普通正文。') => new CreatorSession(
  'article', 'owner', { id: revisionId, manifestPath: `revisions/${revisionId}/manifest.json`, title: '标题', markdown }, themes, 'default',
)
function batch(state: CreatorSession, ids: string[], kind: ImageCandidate['kind'] = 'cover') {
  const anchorId = kind === 'body' ? state.view().imagePlacements[0]!.id : ''
  const request = state.requestImages(state.version, kind, anchorId)
  for (const id of ids) state.addImage(state.version, request.id, image(id, kind, state.revision.id))
  return request
}

describe('bounded image candidate request batches', () => {
  it('accepts two three-cover rounds without a lifetime cap or an implicit selection', () => {
    const state = session()
    const first = batch(state, ['one', 'two', 'three'])
    const second = batch(state, ['four', 'five', 'six'])
    expect(first.id).not.toBe(second.id)
    expect(state.candidates().map(image => image.id)).toEqual(['one', 'two', 'three', 'four', 'five', 'six'])
    expect(state.selectedCover()).toBeUndefined()
    expect(state.version).toBe(1)
    expect(() => state.addImage(1, second.id, image('seven'))).toThrow('3')
  })

  it('allows four body candidates across distinct paragraph-image requests', () => {
    const state = session()
    for (const id of ['one', 'two', 'three', 'four']) batch(state, [id], 'body')
    expect(state.candidates().map(image => image.id)).toEqual(['one', 'two', 'three', 'four'])
    expect(state.version).toBe(1)
  })

  it('deduplicates a replay before the batch limit but rejects conflicting identity reuse', () => {
    const state = session()
    const request = batch(state, ['one', 'two', 'three'])
    state.addImage(1, request.id, image('one'))
    expect(state.candidates()).toHaveLength(3)
    expect(() => state.addImage(1, request.id, { ...image('one'), sha256: 'd'.repeat(64) })).toThrow('变化')
    expect(() => state.addImage(1, request.id, image('four'))).toThrow('3')
  })

  it('counts existing candidates as responses in a new batch without duplicating retention', () => {
    const state = session()
    batch(state, ['one', 'two', 'three'])
    const next = batch(state, ['one', 'four', 'five'])
    expect(state.candidates()).toHaveLength(5)
    expect(() => state.addImage(1, next.id, image('six'))).toThrow('3')
  })

  it('rejects stale request, revision, version, kind and failed-request results', () => {
    const state = session()
    const first = state.requestImages(1, 'cover', '')
    const second = state.requestImages(1, 'cover', '')
    expect(() => state.addImage(1, first.id, image('old'))).toThrow('失效')
    expect(() => state.addImage(1, second.id, image('new', 'cover', nextId))).toThrow('当前文章')
    expect(() => state.addImage(1, second.id, image('new', 'body'))).toThrow('当前文章')
    state.failImages(second.id)
    expect(() => state.addImage(1, second.id, image('new'))).toThrow('失效')
    const third = state.requestImages(1, 'cover', '')
    state.selectTheme(1, 'simple')
    expect(() => state.addImage(1, third.id, image('old'))).toThrow('更新')
    expect(() => state.imageRequestFor(2, third.id)).toThrow('失效')
    expect(state.candidates()).toHaveLength(0)
  })

  it('reserves capacity at request start by pruning oldest unused candidates without changing version', () => {
    const state = session()
    for (let i = 0; i < 8; i++) batch(state, [String(i * 3), String(i * 3 + 1), String(i * 3 + 2)])
    expect(state.candidates()).toHaveLength(24)
    const next = state.requestImages(1, 'cover', '')
    expect(state.candidates().map(image => image.id)).toEqual(Array.from({ length: 21 }, (_, i) => String(i + 3)))
    expect(state.version).toBe(1)
    for (const id of ['24', '25', '26']) state.addImage(1, next.id, image(id))
    expect(state.candidates()).toHaveLength(24)
  })

  it('preserves selected cover and Markdown-referenced assets while pruning older unused choices', () => {
    const state = session('# 标题\n\n正文。\n\n![used](images/1.png)\n\n![alias](<./images/2.png>)')
    for (let i = 0; i < 8; i++) batch(state, [String(i * 3), String(i * 3 + 1), String(i * 3 + 2)])
    state.selectCover(1, '0')
    const next = state.requestImages(2, 'cover', '')
    for (const id of ['24', '25', '26']) state.addImage(2, next.id, image(id))
    expect(state.candidates().map(image => image.id)).toEqual(['0', '1', '2', ...Array.from({ length: 21 }, (_, i) => String(i + 6))])
    expect(state.selectedCover()?.id).toBe('0')
    expect(state.version).toBe(2)
  })

  it('rejects an impossible new batch before mutation when every retained asset is in use', () => {
    const markdown = '# 标题\n\n正文。\n\n' + Array.from({ length: 24 }, (_, i) => `![${i}](images/${i}.png)`).join('\n\n')
    const state = session(markdown)
    let lastRequest = ''
    for (let i = 0; i < 8; i++) lastRequest = batch(state, [String(i * 3), String(i * 3 + 1), String(i * 3 + 2)]).id
    const before = state.candidates()
    expect(() => state.requestImages(1, 'cover', '')).toThrow('空间')
    expect(state.candidates()).toEqual(before)
    expect(state.imageRequestFor(1, lastRequest).id).toBe(lastRequest)
    expect(state.version).toBe(1)
  })

  it('does not partially prune when only some of the required capacity can be freed', () => {
    const markdown = '# 标题\n\n正文。\n\n' + Array.from({ length: 23 }, (_, i) => `![${i}](images/${i}.png)`).join('\n\n')
    const state = session(markdown)
    for (let i = 0; i < 8; i++) batch(state, [String(i * 3), String(i * 3 + 1), String(i * 3 + 2)])
    const before = state.candidates()
    expect(() => state.requestImages(1, 'cover', '')).toThrow('空间')
    expect(state.candidates()).toEqual(before)
  })

  it('refuses generation once the current batch is full but still accepts exact import replays', () => {
    const state = session()
    const request = batch(state, ['one', 'two', 'three'])
    expect(() => state.imageRequestFor(1, request.id, true)).toThrow('3')
    expect(state.imageRequestFor(1, request.id).id).toBe(request.id)
    state.addImage(1, request.id, image('one'))
    expect(state.candidates()).toHaveLength(3)
  })

  it('checks actual fallback batch size before allowing generation in a partially completed request', () => {
    const state = session()
    const cover = batch(state, ['one'])
    expect(() => state.imageRequestFor(1, cover.id, true)).toThrow('3')
    const body = batch(state, ['body-one'], 'body')
    expect(() => state.imageRequestFor(1, body.id, true)).toThrow('空间')
    expect(() => state.addImage(1, body.id, image('body-two', 'body'))).toThrow()
  })

  it('rebinds only current-revision candidate metadata, preserving a selected cover and de-duplicating identical entries', () => {
    const state = session()
    batch(state, ['one', 'two', 'three'])
    state.selectCover(1, 'one')
    const nextRevision = { ...state.revision, id: nextId, manifestPath: `revisions/${nextId}/manifest.json` }
    state.replaceRevision(2, nextRevision, true)
    expect(() => state.rebindCandidates([image('one')])).toThrow('版本')
    state.rebindCandidates([image('one', 'cover', nextId), image('one', 'cover', nextId), image('two', 'cover', nextId)])
    expect(state.selectedCover()?.revisionId).toBe(nextId)
    expect(state.candidates()).toHaveLength(2)
    const detached = state.candidates()
    detached[0]!.alt = 'changed'
    expect(state.candidates()[0]!.alt).toBe('one')
  })
})

it('keeps a current body preview when selecting a cover but revokes final review', () => {
  const state = session()
  batch(state, ['one'])
  state.finishPreview(state.beginPreview(1), { path: 'body.html', receipt: 'receipt', sha256: 'body', assets: [], publicationTitle: '标题' })
  state.review(1)
  state.selectCover(1, 'one')
  expect(state.view()).toMatchObject({ preview: { status: 'ready', path: 'body.html' }, reviewed: false, preparedForDraft: false })
  expect(state.proof().path).toBe('body.html')
})

it('retains inspection through view refreshes and invalidates it when the article changes', () => {
  const state = session()
  state.inspected(1, { ready: false, checks: [{ level: 'error', message: '请选择封面。' }] })
  expect(state.view().inspection?.ready).toBe(false)
  expect(state.fork().view().inspection?.checks).toHaveLength(1)
  state.selectTheme(1, 'simple')
  expect(state.view().inspection).toBeUndefined()
})


it('tracks partial completion, isolates returned arrays, and retains successful candidates on failure', () => {
  const state = session()
  const request = state.requestImages(1, 'cover', '')
  expect(request).toMatchObject({ expected: 3, completed: 0, candidateIds: [], status: 'pending' })
  request.candidateIds.push('injected')
  state.addImage(1, request.id, image('one'))
  state.addImage(1, request.id, image('one'))
  const view = state.view()
  expect(view.imageRequest).toMatchObject({ expected: 3, completed: 1, candidateIds: ['one'], status: 'pending' })
  view.imageRequest!.candidateIds.push('injected')
  const copy = state.fork()
  copy.addImage(1, request.id, image('two'))
  expect(state.view().imageRequest!.candidateIds).toEqual(['one'])
  state.failImages(request.id)
  expect(state.view().imageRequest).toMatchObject({ completed: 1, candidateIds: ['one'], status: 'error' })
  expect(state.candidates().map(item => item.id)).toEqual(['one'])
  expect(() => state.addImage(1, request.id, image('late'))).toThrow('失效')
  const next = state.requestImages(1, 'cover', '')
  for (const id of ['two', 'three', 'four']) state.addImage(1, next.id, image(id))
  expect(state.view().imageRequest).toMatchObject({ completed: 3, status: 'ready' })
  expect(state.candidates()).toHaveLength(4)
})
