// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { CreatorWorkspace } from '../../src/client/CreatorWorkspace.tsx'
import type { CreatorClient } from '../../src/client/CreatorWorkspace.tsx'
import type { CreatorView } from '../../src/creator/types.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
HTMLElement.prototype.scrollIntoView = vi.fn()
let root: Root | undefined
let container: HTMLDivElement
const view: CreatorView = { schemaVersion: 1, articleId: 'a', version: 1, title: '真实文章', publicationTitle: '真实文章', markdown: '# 真实文章', theme: 'default', themes: [{ name: 'default', description: '默认' }, { name: 'simple', description: '简洁' }], preview: { status: 'ready', path: 'preview.html', sha256: 'digest', assets: [], message: '' }, reviewed: false, preparedForDraft: false, draftEnabled: true, imageCandidates: [], imagePlacements: [], imageRequest: null, coverId: '', delivery: null, suggestions: [], suggestionRequest: null, canUndo: false }
async function render(client: CreatorClient) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(createElement(CreatorWorkspace, { client })) })
}
function button(text: string): HTMLButtonElement { return [...container.querySelectorAll('button')].find(item => item.textContent === text || item.getAttribute('aria-label') === text)! }
function theme(value: string) { const select = container.querySelector<HTMLSelectElement>('[aria-label="排版主题"]')!; select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) }
function fill(element: HTMLInputElement | HTMLTextAreaElement, value: string) { const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) }
afterEach(async () => { await act(async () => root?.unmount()); document.body.innerHTML = '' })
describe('creator native workspace', () => {
  it('uses actual provider HTML in an isolated iframe and switches themes without a prompt', async () => {
    const dispatch = vi.fn(async (version, action) => ({ ...view, version: 2, theme: action.type === 'select-theme' ? action.theme : 'simple' }))
    await render({ get: async () => view, dispatch, readPreview: async () => '<h1>真实排版结果</h1>' })
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.srcdoc).toContain('真实排版结果')
    expect(frame.srcdoc).toContain("default-src 'none'")
    await act(async () => { theme('simple') })
    expect(dispatch.mock.calls.map(call => call[1])).toEqual([{ type: 'select-theme', theme: 'simple' }, { type: 'refresh-preview' }])
  })
  it('shows exact before/after and only applies when clicked', async () => {
    const dispatch = vi.fn(async () => ({ ...view, version: 2 }))
    await render({ get: async () => ({ ...view, suggestions: [{ id: 'suggestion', title: '改标题', reason: '更具体', before: '# 旧标题', after: '# 新标题' }] }), dispatch, readPreview: async () => '<p>文章</p>' })
    await act(async () => { button('更换封面').click() })
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
  const prepared = { ...view, preparedForDraft: true, reviewed: true, coverId: 'cover' }; const dispatch = vi.fn(async () => prepared)
  await render({ get: async () => prepared, dispatch, readPreview: async () => '<p>最终文章</p>' })
  await act(async () => { button('存为草稿').click() })
  expect(button('确认保存到草稿箱').disabled).toBe(true)
  await act(async () => { (container.querySelector('input[type=checkbox]') as HTMLInputElement).click() })
  expect(button('确认保存到草稿箱').disabled).toBe(false)
  await act(async () => { button('确认保存到草稿箱').click() })
  expect(dispatch.mock.calls.at(-1)?.[1]).toEqual({ type: 'create-draft', confirmed: true })
})

it('cannot review server-ready bytes before they are displayed or after a read failure', async () => {
  let finish!: (html: string) => void
  const dispatch = vi.fn<CreatorClient['dispatch']>(async () => view)
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
  await act(async () => { theme('simple') })
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
  await act(async () => { theme('simple'); theme('default') })
  await act(async () => { release() })
  await vi.waitFor(() => expect(selections).toEqual(['simple', 'default']))
  expect(container.querySelector('iframe')?.title).toBe('当前主题：default')
})

it('shows the actual publication title before allowing confirmation', async () => {
 await render({get:async()=>({...view,publicationTitle:'公众号实际标题'}),dispatch:async()=>({...view,publicationTitle:'公众号实际标题'}),readPreview:async()=>'<p>文章</p>'})
 await act(async()=>button('存为草稿').click())
 expect(container.querySelector('[aria-label="交付文章"]')?.textContent).toContain('公众号实际标题')
 expect(container.querySelector('[aria-label="交付文章"]')?.textContent).toContain('与文章名称不同')
})

it('selects a cover without calling the layout provider again', async () => {
  const candidate = { id: 'cover', revisionId: 'r', kind: 'cover' as const, path: 'cover.png', sha256: 'c', contentType: 'image/png' as const, byteSize: 12, alt: '封面' }
  const initial = { ...view, imageCandidates: [candidate] }
  const dispatch = vi.fn(async () => ({ ...initial, version: 2, coverId: 'cover' }))
  await render({ get: async () => initial, dispatch, readPreview: async () => '<p>正文</p>' })
  await act(async () => button('选作封面：封面').click())
  expect(dispatch.mock.calls).toHaveLength(1)
  expect(dispatch.mock.calls[0]).toEqual([1, { type: 'select-cover', candidateId: 'cover' }, expect.any(AbortSignal)])
})

it('shows missing draft requirements without asking the model or uploading anything', async () => {
  const empty = { ...view, preview: { ...view.preview, status: 'empty' as const } }; const dispatch = vi.fn(async (_version: number, _action: unknown) => empty)
  await render({ get: async () => empty, dispatch, readPreview: async () => '' })
  await act(async () => button('存为草稿').click())
  const checklist = container.querySelector('[aria-label="保存前检查"]')!
  expect(checklist.textContent).toContain('尚未选择封面')
  expect(checklist.textContent).toContain('需要更新预览')
  expect(dispatch.mock.calls.map(call => call[1])).toEqual([{ type: 'check-article' }])
})

it('renders structured CLI inspection results in the save panel', async () => {
  const dispatch = vi.fn(async () => ({ ...view, inspection: { ready: false, checks: [{ level: 'error' as const, message: '请选择一张封面。' }] } }))
  await render({ get: async () => view, dispatch, readPreview: async () => '<p>正文</p>' })
  await act(async () => button('检查发布条件').click())
  expect(dispatch.mock.calls[0]).toEqual([1, { type: 'check-article' }, expect.any(AbortSignal)])
  expect(container.textContent).toContain('需要处理：请选择一张封面。')
})


it('keeps the cover card, candidates and body in one canvas with no category tabs or bottom sheet', async () => {
  await render({ get: async () => view, dispatch: async () => view, readPreview: async () => '<p>正文</p>' })
  expect(container.querySelector('.md2-toolbar')).toBeNull()
  expect(container.querySelector('.md2-controls')).toBeNull()
  expect(container.querySelector('.md2-preview-width')).toBeNull()
  await act(async () => button('更换封面').click())
  const canvas = container.querySelector('.md2-article-canvas')!
  expect(canvas.querySelector('[aria-label="选择封面"]')?.hasAttribute('hidden')).toBe(false)
  expect(canvas.querySelector('iframe')).not.toBeNull()
  expect(button('更新预览').getAttribute('title')).toBe('更新排版')
})

it('edits a paragraph against the version opened and refreshes the saved text without a model request', async () => {
  const before = '这是可以修改的正文。'
  const initial = { ...view, markdown: '# 真实文章\n\n' + before, imagePlacements: [{ id: 'p', context: before, hasImage: false }] }
  const dispatch = vi.fn(async (_version, action) => ({ ...initial, version: 2, markdown: '# 真实文章\n\n修改后的正文。', imagePlacements: [{ id: 'p2', context: action.after || '修改后的正文。', hasImage: false }] }))
  await render({ get: async () => initial, dispatch, readPreview: async () => '<p>正文</p>' })
  await act(async () => button('编辑正文').click())
  await act(async () => button(before).click())
  await act(async () => fill(container.querySelector('textarea')!, '修改后的正文。'))
  await act(async () => container.querySelector<HTMLFormElement>('.md2-edit-paragraph form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(dispatch.mock.calls[0]).toEqual([1, { type: 'edit-text', before, after: '修改后的正文。' }, expect.any(AbortSignal)])
  expect(dispatch.mock.calls[1]?.[1]).toEqual({ type: 'refresh-preview' })
  expect(container.querySelector('textarea')).toBeNull()
  expect(container.textContent).toContain('修改后的正文。')
})

it('retains unsaved paragraph text on save failure and cancels without writing', async () => {
  const initial = { ...view, imagePlacements: [{ id: 'p', context: '原文内容。', hasImage: false }] }
  const dispatch = vi.fn(async () => { throw new Error('save failed') })
  await render({ get: async () => initial, dispatch, readPreview: async () => '<p>正文</p>' })
  await act(async () => button('编辑正文').click())
  await act(async () => button('原文内容。').click())
  await act(async () => fill(container.querySelector('textarea')!, '我的修改。'))
  await act(async () => container.querySelector<HTMLFormElement>('.md2-edit-paragraph form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(container.querySelector('textarea')?.value).toBe('我的修改。')
  await act(async () => button('取消修改').click())
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('原文内容。')
})

it('shows partial cover progress without losing the selected cover or pretending all three are ready', async () => {
  const candidate = (id: string) => ({ id, revisionId: 'r', kind: 'cover' as const, path: id + '.png', sha256: id, contentType: 'image/png' as const, byteSize: 12, alt: id })
  const initial = { ...view, coverId: 'old', imageCandidates: [candidate('old'), candidate('new')], imageRequest: { id: 'batch', kind: 'cover' as const, anchorId: '', status: 'pending' as const, completed: 1, expected: 3, candidateIds: ['new'] } }
  await render({ get: async () => initial, dispatch: async () => initial, readImage: async image => 'data:image/png;base64,' + image.id, readPreview: async () => '<p>正文</p>' })
  await act(async () => button('更换封面').click())
  expect(container.querySelector('.md2-message-card img')?.getAttribute('alt')).toBe('old')
  expect(container.textContent).toContain('1/3 正在生成')
  expect(container.querySelectorAll('.md2-cover-wait')).toHaveLength(2)
  expect(button('再生成三张').disabled).toBe(true)
})

it('does not reset an unsaved title or allow a second editor or delivery action', async () => {
  const initial = { ...view, preparedForDraft: true, reviewed: true, coverId: 'cover', imagePlacements: [{ id: 'p', context: '段落文字。', hasImage: false }] }
  await render({ get: async () => initial, dispatch: async () => initial, readPreview: async () => '<p>正文</p>' })
  await act(async () => button('编辑正文').click())
  await act(async () => button('编辑标题').click())
  await act(async () => fill(container.querySelector<HTMLInputElement>('[aria-label="文章标题"]')!, '尚未保存的新标题'))
  expect(button('编辑标题').disabled).toBe(true)
  expect(button('段落文字。').disabled).toBe(true)
  expect(button('存为草稿').disabled).toBe(true)
  expect(button('已审阅当前版本').disabled).toBe(true)
  expect(button('导出已审阅 HTML').disabled).toBe(true)
  expect(container.querySelector<HTMLInputElement>('[aria-label="文章标题"]')?.value).toBe('尚未保存的新标题')
})

it('retains an accessible draft and cancel when reloading a concurrently changed paragraph', async () => {
  let state = { ...view, imagePlacements: [{ id: 'p', context: '原文内容。', hasImage: false }] }
  await render({ get: async () => state, dispatch: async () => { throw { code: 'VERSION_CONFLICT' } }, readPreview: async () => '<p>正文</p>' })
  await act(async () => button('编辑正文').click())
  await act(async () => button('原文内容。').click())
  await act(async () => fill(container.querySelector('textarea')!, '保留我的输入。'))
  await act(async () => container.querySelector<HTMLFormElement>('.md2-edit-paragraph form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  state = { ...state, version: 2, imagePlacements: [{ id: 'q', context: '别人更新的段落。', hasImage: false }] }
  await act(async () => button('重新加载文章').click())
  expect(container.querySelector('textarea')?.value).toBe('保留我的输入。')
  expect(container.textContent).toContain('这段原文已更新')
  await act(async () => button('取消修改').click())
  expect(button('存为草稿').disabled).toBe(false)
})

it('offers advanced layout next to polishing with an eight-module explanation', async () => {
  const dispatch = vi.fn<CreatorClient['dispatch']>(async () => view)
  await render({ get: async () => view, dispatch, readPreview: async () => '<p>文章</p>' })
  expect(button('高级排版').closest('details')?.textContent).toContain('请助手润色')
  expect(container.textContent).toContain('整篇最多 8 个')
  await act(async () => button('高级排版').click())
  expect(dispatch.mock.calls[0]?.[1]).toEqual({ type: 'request-suggestions', kind: 'layout' })
})
