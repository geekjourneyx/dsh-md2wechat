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
const view: CreatorView = { schemaVersion: 1, articleId: 'a', version: 1, title: '真实文章', markdown: '# 真实文章', theme: 'default', themes: [{ name: 'default', description: '默认' }, { name: 'simple', description: '简洁' }], preview: { status: 'ready', path: 'preview.html', sha256: 'digest', assets: [], message: '' }, reviewed: false, delivery: null, suggestions: [], suggestionRequest: null, canUndo: false }
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
