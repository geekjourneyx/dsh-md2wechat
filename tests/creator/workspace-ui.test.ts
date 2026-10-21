// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { CreatorWorkspace } from '../../src/client/CreatorWorkspace.tsx'
import type { CreatorClient } from '../../src/client/CreatorWorkspace.tsx'
import type { CreatorView } from '../../src/creator/types.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let container: HTMLDivElement
const view: CreatorView = { schemaVersion: 1, articleId: 'a', version: 1, title: '真实文章', publicationTitle: '真实文章', markdown: '# 真实文章', theme: 'default', themes: [{ name: 'default', description: '默认' }, { name: 'simple', description: '简洁' }], preview: { status: 'ready', path: 'preview.html', sha256: 'digest', assets: [], message: '' }, reviewed: false, preparedForDraft: false, draftEnabled: true, imageCandidates: [], imagePlacements: [], imageRequest: null, coverId: '', delivery: null, suggestions: [], suggestionRequest: null, canUndo: false }
async function render(client: CreatorClient) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(createElement(CreatorWorkspace, { client })) })
}
function button(text: string): HTMLButtonElement { return [...container.querySelectorAll('button')].find(item => item.textContent === text)! }
afterEach(async () => { await act(async () => root?.unmount()); document.body.innerHTML = '' })
describe('creator native workspace', () => {
  it('uses actual provider HTML in an isolated iframe and switches themes without a prompt', async () => {
    const dispatch = vi.fn(async (version, action) => ({ ...view, version: 2, theme: action.type === 'select-theme' ? action.theme : 'simple' }))
    await render({ get: async () => view, dispatch, readPreview: async () => '<h1>真实排版结果</h1>' })
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.srcdoc).toContain('真实排版结果')
    expect(frame.srcdoc).toContain("default-src 'none'")
    await act(async () => { button('simple简洁').click() })
    expect(dispatch.mock.calls.map(call => call[1])).toEqual([{ type: 'select-theme', theme: 'simple' }, { type: 'refresh-preview' }])
  })
  it('shows exact before/after and only applies when clicked', async () => {
    const dispatch = vi.fn(async () => ({ ...view, version: 2 }))
    await render({ get: async () => ({ ...view, suggestions: [{ id: 'suggestion', title: '改标题', reason: '更具体', before: '# 旧标题', after: '# 新标题' }] }), dispatch, readPreview: async () => '<p>文章</p>' })
    await act(async () => { button('标题与文字').click() })
    expect(container.textContent).toContain('# 旧标题')
    expect(container.textContent).toContain('# 新标题')
    expect(dispatch).not.toHaveBeenCalled()
    await act(async () => { button('应用这条建议').click() })
    expect(dispatch.mock.calls[0]?.[1]).toEqual({ type: 'apply-suggestion', suggestionId: 'suggestion' })
  })
  it('preserves last preview and exposes retry after a failed render', async () => {
    await render({ get: async () => ({ ...view, preview: { ...view.preview, status: 'error', message: '预览未完成。原文未更改。' } }), dispatch: async () => view, readPreview: async () => '<p>上一次预览</p>' })
    expect(container.querySelector('[role=alert]')?.textContent).toContain('原文未更改')
    expect(container.querySelector('iframe')?.srcdoc).toContain('上一次预览')
    expect(button('更新预览').disabled).toBe(false)
  })
})

it('requires current final review and explicit checkbox before saving an unpublished draft', async () => {
  const dispatch = vi.fn(async () => view)
  await render({ get: async () => ({ ...view, preparedForDraft: true, reviewed: true, coverId: 'cover' }), dispatch, readPreview: async () => '<p>最终文章</p>' })
  await act(async () => { button('保存到公众号草稿箱').click() })
  expect(button('确认保存到草稿箱').disabled).toBe(true)
  await act(async () => { (container.querySelector('input[type=checkbox]') as HTMLInputElement).click() })
  expect(button('确认保存到草稿箱').disabled).toBe(false)
  await act(async () => { button('确认保存到草稿箱').click() })
  expect(dispatch.mock.calls[0]?.[1]).toEqual({ type: 'create-draft', confirmed: true })
})

it('cannot review server-ready bytes before they are displayed or after a read failure', async () => {
  let finish!: (html: string) => void
  const dispatch = vi.fn(async () => view)
  await render({ get: async () => view, dispatch, readPreview: () => new Promise(resolve => { finish = resolve }) })
  expect(button('审阅当前版本').disabled).toBe(true)
  await act(async () => { finish('<p>当前真实内容</p>') })
  expect(button('审阅当前版本').disabled).toBe(false)
  await act(async () => { button('审阅当前版本').click() })
  expect(dispatch.mock.calls[0]?.[1]).toEqual({ type: 'review-current', previewPath: view.preview.path, previewSha256: view.preview.sha256, publicationTitle: view.publicationTitle })
  const failed = { get: async () => ({ ...view, articleId: 'b' }), dispatch, readPreview: async () => { throw new Error('tampered') } }
  await act(async () => root!.render(createElement(CreatorWorkspace, { client: failed })))
  expect(button('审阅当前版本').disabled).toBe(true)
  expect(container.querySelector('iframe')).toBeNull()
})

it('cannot review while showing the previous theme and resets state for another article', async () => {
  const next = { ...view, version: 2, theme: 'simple', preview: { ...view.preview, path: 'new.html', sha256: 'new-digest' } }
  await render({ get: async () => view, dispatch: async () => next, readPreview: async preview => `<p>${preview.path}</p>` })
  await act(async () => { button('simple简洁').click() })
  await act(async () => { button('对比上一主题').click() })
  expect(button('审阅当前版本').disabled).toBe(true)
  const another = { ...view, articleId: 'other', title: '另一篇文章' }
  const client: CreatorClient = { get: async () => another, dispatch: async () => another, readPreview: async () => '<p>另一篇内容</p>' }
  await act(async () => root!.render(createElement(CreatorWorkspace, { client })))
  expect(container.textContent).toContain('另一篇文章')
  expect(container.querySelector('iframe')?.srcdoc).toContain('另一篇内容')
  expect(container.textContent).not.toContain('对比上一主题')
  expect(button('审阅当前版本').disabled).toBe(false)
})

it('coalesces rapid theme clicks so the last intent uses the latest accepted version', async () => {
  let state = { ...view }
  let release!: () => void
  const selections: string[] = []
  const first = new Promise<void>(resolve => { release = resolve })
  const client: CreatorClient = { get: async () => state, readPreview: async () => '<p>文章</p>', dispatch: async (version, action) => {
    if (action.type === 'select-theme') {
      if (!selections.length) await first
      expect(version).toBe(state.version)
      selections.push(action.theme)
      state = { ...state, version: state.version + 1, theme: action.theme }
    }
    return state
  } }
  await render(client)
  await act(async () => { button('simple简洁').click(); button('default默认').click() })
  await act(async () => { release() })
  await vi.waitFor(() => expect(selections).toEqual(['simple', 'default']))
  expect(container.querySelector('iframe')?.title).toBe('当前主题：default')
})

it('shows the actual publication title before allowing confirmation', async () => {
 await render({get:async()=>({...view,publicationTitle:'公众号实际标题'}),dispatch:async()=>view,readPreview:async()=>'<p>文章</p>'})
 await act(async()=>button('保存到公众号草稿箱').click())
 expect(container.querySelector('[aria-label="交付文章"]')?.textContent).toContain('公众号实际标题')
 expect(container.querySelector('[aria-label="交付文章"]')?.textContent).toContain('与文章名称不同')
})
