// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject } from '../../src/client/index.ts'
import type { CreatorView } from '../../src/creator/types.ts'
vi.mock('../../src/client/CreatorWorkspace.css', () => ({ default: '.workspace-style{}' }))
vi.mock('../../src/client/ArticlePanel.css', () => ({ default: '.article-panel-style{}' }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let container: HTMLDivElement
interface Entry { options: Record<string, unknown>; component: ComponentType<Record<string, unknown>> }
function host() {
  const entries = new Map<string, Entry>(); const cleanups: Array<() => void> = []
  const release = vi.fn()
  const view: CreatorView = { schemaVersion: 1, articleId: 'saved', version: 1, title: '持久文章', publicationTitle: '持久文章', markdown: '# 正文', theme: 'default', themes: [], preview: { status: 'empty', path: '', sha256: '', assets: [], message: '' }, reviewed: false, preparedForDraft: false, draftEnabled: false, imageCandidates: [], imagePlacements: [], imageRequest: null, coverId: '', delivery: null, suggestions: [], suggestionRequest: null, canUndo: false }
  const ctx = {
    remote: { $mount: vi.fn(async () => {}), md2wechat: { session: vi.fn(async () => ({ ok: true, value: 'A' })), list: vi.fn(async () => ({ ok: true, value: [{ articleId: 'saved', title: '持久文章', sourcePath: 'a.md', updatedAt: '2026-10-20T12:00:00Z' }] })), resume: vi.fn(async () => ({ ok: true, value: view })), open: vi.fn(async () => ({ ok: true, value: view })), get: vi.fn(async () => ({ ok: true, value: view })), dispatch: vi.fn(async () => ({ ok: true, value: view })) }, workspaceFiles: { readBytes: vi.fn() } },
    sessions: { refresh: vi.fn(async () => {}), list: { getSnapshot: () => ({ ids: ['A'], byId: { A: { id: 'A', displayTitle: '会话 A', cwd: '/same' } }, phase: 'ready' }) }, retain: vi.fn(() => ({ ready: Promise.resolve({}), release })) },
    inject: (_names: string[], callback: (child: unknown) => void) => callback(ctx),
    layout: { selectPanel: vi.fn() },
    uiWorkspace: { openSession: vi.fn() },
    sidebarRight: { mounted: { getSnapshot: () => 'A' }, openTab: vi.fn() },
    sidebarRightTabs: { register: vi.fn(() => () => {}) },
    effect: (callback: () => (() => void)) => { cleanups.push(callback()) },
    slots: { inject: vi.fn((_name: string, callback: () => (() => void)) => { cleanups.push(callback()) }), register: vi.fn((options: Record<string, unknown>, component: Entry['component']) => { const key = String(options.name); entries.set(key, { options, component }); return () => { entries.delete(key) } }) },
  }
  return { ctx, entries, release, dispose: () => { for (const cleanup of cleanups.reverse()) cleanup() } }
}
async function render(component: Entry['component'], props: Record<string, unknown> = {}) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); await act(async () => { root!.render(createElement(component, props)) }) }
function button(text: string) { const item = [...container.querySelectorAll('button')].find(element => element.textContent === text); expect(item).toBeDefined(); return item! }
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''; document.head.querySelectorAll('style').forEach(style => style.remove()) })

describe('official article panel registration', () => {
  it('returns a history article to its exact source conversation without invoking editing actions', async () => {
    const h = host(); await apply(h.ctx as unknown as Context)
    await render(h.entries.get('main')!.component)
    await act(async () => {
      const select = container.querySelector('select[aria-label="选择会话"]') as HTMLSelectElement
      select.value = 'A'; select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { button('查看最近文章').click() })
    expect(container.querySelector('[aria-label="历史文章预览"]')).not.toBeNull()
    expect(h.ctx.remote.md2wechat.dispatch).not.toHaveBeenCalled()
    await act(async () => { button('回到原对话继续编辑').click() })
    expect(h.ctx.uiWorkspace.openSession).toHaveBeenCalledWith('A')
    expect(h.ctx.sidebarRight.openTab).toHaveBeenCalledWith('md2wechat-article', { params: { articleId: 'saved' } })
    h.dispose()
  })

  it('registers a fixed main entry and sidebar metadata after Remote mount, independently of any tool call', async () => {
    const h = host(); let mounted!: () => void; h.ctx.remote.$mount.mockImplementation(() => new Promise(resolve => { mounted = resolve }))
    const applying = apply(h.ctx as unknown as Context)
    expect(h.entries.size).toBe(0)
    mounted(); await applying
    expect(inject).toEqual(expect.arrayContaining(['slots', 'remote', 'sessions', 'layout']))
    expect(h.entries.get('main')?.options.key).toBe('md2wechat-articles')
    expect(h.entries.get('sidebar.panellist')?.options).toMatchObject({ id: 'md2wechat-articles', label: '文章历史' })
    expect(h.entries.has('sidebar.right.pane.tab')).toBe(true)
    expect(h.entries.has('shell.overlay')).toBe(false)
    expect(h.entries.has('conversation.input.dock')).toBe(true)
    await render(h.entries.get('main')!.component)
    expect(container.querySelector('[aria-label="文章主工作区"]')).not.toBeNull()
    expect(h.ctx.sessions.retain).not.toHaveBeenCalled()
    expect(h.ctx.remote.md2wechat.list).not.toHaveBeenCalled()
    expect(document.head.textContent).toContain('.workspace-style{}')
    expect(document.head.textContent).toContain('.article-panel-style{}')
    await act(async () => root!.unmount()); root = undefined
    h.dispose(); expect(h.entries.size).toBe(0); expect(document.head.querySelector('style')).toBeNull()
  })

  it('reads articles through the injected child namespace rather than the unprivileged parent', async () => {
    const h = host()
    const permitted = h.ctx.remote
    const parentRemote = { $mount: permitted.$mount }
    Object.defineProperty(parentRemote, 'md2wechat', { get() { throw new Error('cannot get property remote.md2wechat without inject') } })
    const parent = { ...h.ctx, remote: parentRemote, inject: (names: string[], callback: (child: unknown) => void) => {
      expect(names).toEqual(expect.arrayContaining(['remote.md2wechat', 'remote.workspaceFiles']))
      callback(h.ctx)
    } }
    await apply(parent as unknown as Context)
    await render(h.entries.get('tool.call.toolview')!.component, { sessionId: 'A', block: { meta: { kind: 'md2wechat-creator', schemaVersion: 1, articleId: 'saved' } } })
    await act(async () => { button('预览与调整文章').click() })
    await act(async () => { root!.render(createElement(h.entries.get('sidebar.right.pane.tab')!.component, {sessionId:'A',useTabInfo:()=>({tab:{navigation:{params:{articleId:'saved'}}}})})) })
    expect(container.textContent).toContain('持久文章')
    expect(container.textContent).not.toContain('读取失败')
  })

  it('keeps a valid message as a shortcut and uses its authenticated prop session, not a metadata session', async () => {
    const h = host(); await apply(h.ctx as unknown as Context)
    await render(h.entries.get('tool.call.toolview')!.component, { sessionId: 'A', block: { meta: { kind: 'md2wechat-creator', schemaVersion: 1, articleId: 'saved', sessionId: 'untrusted-other-session' } } })
    expect(container.querySelector('[aria-label="文章工作区"]')).toBeNull()
    expect(h.ctx.remote.md2wechat.get).not.toHaveBeenCalled()
    await act(async () => { button('预览与调整文章').click() })
    expect(h.ctx.layout.selectPanel).not.toHaveBeenCalled()
    expect(h.ctx.sidebarRight.openTab).toHaveBeenCalledWith('md2wechat-article', { params: { articleId: 'saved' } })
    await act(async () => { root!.render(createElement(h.entries.get('sidebar.right.pane.tab')!.component, {sessionId:'A',useTabInfo:()=>({tab:{navigation:{params:{articleId:'saved'}}}})})) })
    expect(h.ctx.sessions.retain).toHaveBeenCalledWith('A', { source: 'mainView', signal: expect.any(AbortSignal) })
    expect(h.ctx.remote.md2wechat.resume).toHaveBeenCalledWith('A', 'saved', expect.any(AbortSignal))
    expect(h.ctx.remote.md2wechat.open).not.toHaveBeenCalled()
    await act(async () => root!.unmount()); root = undefined; expect(h.release).toHaveBeenCalledTimes(1); h.dispose()
  })

  it('offers explicit source recovery for old malformed card metadata without guessing any article', async () => {
    const h = host(); await apply(h.ctx as unknown as Context)
    await render(h.entries.get('tool.call.toolview')!.component, { sessionId: 'A', block: { meta: { kind: 'md2wechat-creator', schemaVersion: 1 } } })
    await act(async () => { button('查看文章历史').click() })
    await act(async () => { root!.render(createElement(h.entries.get('main')!.component)) })
    expect(h.ctx.remote.md2wechat.resume).not.toHaveBeenCalled(); expect(h.ctx.remote.md2wechat.open).not.toHaveBeenCalled()
    expect(container.querySelector('input[aria-label="Markdown 路径"]')).not.toBeNull()
    h.dispose()
  })
})
