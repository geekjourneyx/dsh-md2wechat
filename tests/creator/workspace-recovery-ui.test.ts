// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { CreatorWorkspace } from '../../src/client/CreatorWorkspace.tsx'
import type { CreatorClient } from '../../src/client/CreatorWorkspace.tsx'
import type { CreatorView } from '../../src/creator/types.ts'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let container: HTMLDivElement
const view: CreatorView = { schemaVersion: 1, articleId: 'a', version: 1, title: '已保存正文', publicationTitle: '已保存正文', markdown: '# 正文', theme: 'default', themes: [], preview: { status: 'ready', path: 'preview.html', sha256: 'digest', assets: [], message: '' }, reviewed: true, preparedForDraft: true, draftEnabled: true, imageCandidates: [], imagePlacements: [], imageRequest: null, coverId: 'cover', delivery: null, suggestions: [], suggestionRequest: null, canUndo: false }
async function mount(client: CreatorClient, onRecover?: () => void) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); await act(async () => { root!.render(createElement(CreatorWorkspace, { client, ...(onRecover ? { onRecover } : {}) })) }) }
function button(text: string) { const result = [...container.querySelectorAll('button')].find(item => item.textContent === text); expect(result).toBeDefined(); return result! }
async function click(text: string) { await act(async () => { button(text).click() }) }
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
describe('actionable workspace recovery and delivery reconciliation', () => {
  it('explains a typed missing article failure without raw remote data and offers explicit recovery', async () => {
    const onRecover = vi.fn(); const client: CreatorClient = { get: async () => { throw new Error('[md2wechat:ARTICLE_NOT_FOUND] secret=do-not-render') }, dispatch: async () => view, readPreview: async () => '' }
    await mount(client, onRecover)
    expect(container.querySelector('[role=alert]')?.textContent).toContain('保存记录')
    expect(container.textContent).not.toContain('secret=')
    await click('选择原文恢复'); expect(onRecover).toHaveBeenCalledTimes(1)
    expect(button('重新加载文章').disabled).toBe(false)
  })
  it('retries an initial connection failure and displays the current saved article without model operations', async () => {
    let first = true; const dispatch = vi.fn(async () => view)
    const client: CreatorClient = { get: vi.fn(async () => { if (first) { first = false; throw { code: 'HOST_UNAVAILABLE' } } return view }), dispatch, readPreview: async () => '<p>保存的预览</p>' }
    await mount(client); await click('重新加载文章')
    expect(container.textContent).toContain('已保存正文'); expect(container.querySelector('iframe')?.srcdoc).toContain('保存的预览'); expect(dispatch).not.toHaveBeenCalled()
  })
  it('retains displayed article and preview after a typed operation error and exposes a reload action', async () => {
    const client: CreatorClient = { get: async () => view, dispatch: async () => { throw { code: 'PERMISSION_DENIED', message: 'private-token' } }, readPreview: async () => '<p>不要清空这个预览</p>' }
    await mount(client); await click('更新预览')
    expect(container.querySelector('[role=alert]')?.textContent).toContain('权限')
    expect(container.textContent).not.toContain('private-token'); expect(container.textContent).toContain('已保存正文'); expect(container.querySelector('iframe')?.srcdoc).toContain('不要清空这个预览')
    expect(button('重新加载文章').disabled).toBe(false)
  })
  it('retries preview bytes when reload returns the exact same article version and preview identity', async () => {
    let failed = true
    const readPreview = vi.fn(async () => { if (failed) { failed = false; throw new Error('first read failed') } return '<p>同一版本的预览已重新读取</p>' })
    await mount({ get: async () => view, dispatch: async () => view, readPreview })
    expect(container.querySelector('iframe')).toBeNull()
    await click('重新加载文章')
    expect(readPreview).toHaveBeenCalledTimes(2)
    expect(container.querySelector('iframe')?.srcdoc).toContain('同一版本的预览已重新读取')
  })
  it('shows restored-version caveats and never treats a restored article as already reviewed', async () => {
    await mount({ get: async () => ({ ...view, reviewed: false, recovery: { message: '原文已变化，当前继续的是已保存版本。', sourceChanged: true, themeUnavailable: false } }), dispatch: async () => view, readPreview: async () => '<p>保存版本</p>' })
    expect(container.textContent).toContain('原文已变化，当前继续的是已保存版本')
    expect(button('审阅当前版本').disabled).toBe(false)
    expect(container.textContent).not.toContain('已审阅当前版本')
  })
  it('requires explicit backend-check confirmation before clearing unknown delivery and never retries upload automatically', async () => {
    const unknown = { ...view, delivery: { kind: 'draft' as const, status: 'unknown' as const, path: '', message: '交付结果未知，请先核对。' } }
    const dispatch = vi.fn(async () => ({ ...view, version: 2 }))
    await mount({ get: async () => unknown, dispatch, readPreview: async () => '<p>最终预览</p>' })
    expect(button('确认已核对，解除保护').disabled).toBe(true)
    await click('交付')
    expect(button('重新准备微信素材').disabled).toBe(true)
    expect(button('导出已审阅 HTML').disabled).toBe(false)
    await act(async () => { (container.querySelector('input[aria-label="已核对公众号后台交付结果"]') as HTMLInputElement).click() })
    await click('确认已核对，解除保护')
    expect(dispatch.mock.calls.map(call => call[1])).toEqual([{ type: 'reconcile-delivery', confirmed: true }])
    expect(container.textContent).not.toContain('确认已核对，解除保护')
  })
})
