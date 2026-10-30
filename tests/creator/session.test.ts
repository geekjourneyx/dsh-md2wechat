import { describe, expect, it } from 'vitest'
import { CreatorSession, selectableThemes } from '../../src/creator/session.ts'

const revision = { id: 'revision-a', manifestPath: 'revisions/a/manifest.json', title: '文章', markdown: '# 文章' }
const themes = [{ name: 'default', description: '默认' }, { name: 'simple', description: '简洁' }]

describe('creator article state', () => {
  it('filters runtime theme collections and accepts incomplete selectable metadata', () => {
    expect(selectableThemes({ themes: [
      { name: 'default', type: 'api', selectable: true, metadata_incomplete: true },
      { name: 'api', type: 'api', selectable: false },
      { name: 'ai', type: 'ai', selectable: true },
    ] })).toEqual([{ name: 'default', description: 'default' }])
  })
  it('rejects a different session and unknown theme without mutation', () => {
    const state = new CreatorSession('article-a', 'owner-a', revision, themes, 'default')
    expect(() => state.assertOwner('owner-b')).toThrow('文章')
    expect(() => state.selectTheme(1, 'unlisted')).toThrow('主题')
    expect(state.view().version).toBe(1)
  })
  it('latest theme wins and late preview completion cannot replace current output', () => {
    const state = new CreatorSession('article-a', 'owner-a', revision, themes, 'default')
    const old = state.beginPreview(1)
    state.selectTheme(1, 'simple')
    const current = state.beginPreview(2)
    expect(old.signal.aborted).toBe(true)
    expect(state.finishPreview(old, { path: 'old.html', receipt: 'old' })).toBe(false)
    expect(state.finishPreview(current, { path: 'new.html', receipt: 'new' })).toBe(true)
    expect(state.view()).toMatchObject({ theme: 'simple', preview: { status: 'ready', path: 'new.html' } })
  })
  it('keeps last good preview stale after selection and invalidates review', () => {
    const state = new CreatorSession('article-a', 'owner-a', revision, themes, 'default')
    state.finishPreview(state.beginPreview(1), { path: 'a.html', receipt: 'a' })
    state.review(1)
    state.selectTheme(1, 'simple')
    expect(state.view()).toMatchObject({ reviewed: false, preview: { status: 'stale', path: 'a.html' } })
    expect(() => state.review(1)).toThrow('更新')
    expect(() => state.review(2)).toThrow('预览')
  })
})

describe('reviewable suggestions', () => {
  it('binds proposals to one request and revision; applying invalidates preview and supports undo', () => {
    const state = new CreatorSession('article-a', 'owner-a', revision, themes, 'default')
    const request = state.requestSuggestions(1, 'layout')
    state.propose(1, request.id, [{ title: '明确标题', reason: '更具体', before: '# 文章', after: '# 清晰的文章' }])
    expect(state.view().suggestions).toHaveLength(1)
    expect(() => state.propose(1, 'wrong', [])).toThrow('请求')
    const change = state.suggestion(1, state.view().suggestions[0]!.id)
    expect(change.after).toBe('# 清晰的文章')
    state.replaceRevision(1, { ...revision, id: 'revision-b', markdown: change.after }, true)
    expect(state.view()).toMatchObject({ version: 2, canUndo: true, suggestions: [], reviewed: false })
    expect(() => state.propose(1, request.id, [])).toThrow('更新')
    expect(state.undoTarget(2)?.id).toBe('revision-a')
    state.replaceRevision(2, state.undoTarget(2)!, false)
    expect(state.view()).toMatchObject({ version: 3, markdown: '# 文章', canUndo: false })
  })
  it('dismisses a suggestion without changing source or losing others', () => {
    const state = new CreatorSession('article-a', 'owner-a', revision, themes, 'default')
    const request = state.requestSuggestions(1, 'title')
    state.propose(1, request.id, [{ title: '标题', reason: '具体', before: '# 文章', after: '# 新标题' }])
    state.dismiss(1, state.view().suggestions[0]!.id)
    expect(state.view()).toMatchObject({ version: 1, suggestions: [], markdown: '# 文章' })
  })
})

 it('limits the combined advanced layout proposal to eight modules including existing ones', () => {
   const modules = (n: number) => Array.from({ length: n }, () => ':::hero\ntitle: 示例\n:::').join('\n')
   const state = new CreatorSession('article-a', 'owner-a', { ...revision, markdown: modules(6) + '\n甲\n乙' }, themes, 'default')
   const request = state.requestSuggestions(1, 'layout')
   const change = (before: string, n: number) => ({ title: '排版', reason: '强调', before, after: before + '\n' + modules(n) })
   expect(() => state.propose(1, request.id, [change('甲', 2), change('乙', 1)])).toThrow('8 个')
   expect(state.view().suggestions).toHaveLength(0)
   state.propose(1, request.id, [change('甲', 1), change('乙', 1)])
   expect(state.view().suggestions).toHaveLength(2)
 })
