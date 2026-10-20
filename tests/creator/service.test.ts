import { describe, expect, it } from 'vitest'
import { CreatorService } from '../../src/creator/service.ts'

const agent = { id: 'owner-a' } as never
function operations() {
  return {
    exportHtml: async () => ({ path: 'exports/article.html' }),
    suggest: async () => {},
    revise: async (revision: any, markdown: string) => ({ ...revision, id: 'revision-b', markdown }),
    restore: async (revision: any) => revision,
    assertWritable: async () => {},
    themes: async () => [{ name: 'default', description: '默认' }, { name: 'simple', description: '简洁' }],
    start: async () => ({ id: 'revision-a', manifestPath: 'revisions/a/manifest.json', title: '文章', markdown: '# 文章' }),
    preview: async (_revision: unknown, theme: string) => ({ path: theme + '.html', receipt: theme }),
  }
}

describe('creator service boundary', () => {
  it('keeps another session from reading or changing an owned article', async () => {
    const service = new CreatorService(() => operations(), 'default')
    const view = await service.open(agent, 'article.md', '', new AbortController().signal)
    expect(() => service.get({ id: 'other' } as never, view.articleId)).toThrow('文章')
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
  service.propose(agent, opened.articleId, 1, requested.suggestionRequest!.id, [{ title: '标题', reason: '具体', before: '# 文章', after: '# 新文章' }])
  expect(service.get(agent, opened.articleId).markdown).toBe('# 文章')
  const suggested = service.get(agent, opened.articleId)
  const applied = await service.dispatch(agent, opened.articleId, 1, { type: 'apply-suggestion', suggestionId: suggested.suggestions[0]!.id }, signal)
  expect(applied).toMatchObject({ version: 2, markdown: '# 新文章', canUndo: true })
  expect(() => service.propose(agent, opened.articleId, 1, requested.suggestionRequest!.id, [])).toThrow('更新')
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
  await service.dispatch(agent, view.articleId, 1, { type: 'review-current' }, signal)
  const exported = await service.dispatch(agent, view.articleId, 1, { type: 'export-html', destination: 'exports/article.html' }, signal)
  expect(exported.delivery).toMatchObject({ kind: 'export', status: 'completed', path: 'exports/article.html' })
  expect(count).toBe(1)
  await service.dispatch(agent, view.articleId, 1, { type: 'select-theme', theme: 'simple' }, signal)
  await expect(service.dispatch(agent, view.articleId, 2, { type: 'export-html', destination: 'exports/article.html' }, signal)).rejects.toThrow('审阅')
})
