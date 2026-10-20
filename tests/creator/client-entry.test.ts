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
    layout: { selectPanel: vi.fn() },
    effect: (callback: () => (() => void)) => { cleanups.push(callback()) },
    slots: { inject: vi.fn((_name: string, callback: () => (() => void)) => { cleanups.push(callback()) }), register: vi.fn((options: Record<string, unknown>, component: Entry['component']) => { const key = String(options.name); entries.set(key, { options, component }); return () => { entries.delete(key) } }) },
  }
  return { ctx, entries, release, dispose: () => { for (const cleanup of cleanups.reverse()) cleanup() } }
}
async function render(component: Entry['component'], props: Record<string, unknown> = {}) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); await act(async () => { root!.render(createElement(component, props)) }) }
function button(text: string) { const item = [...container.querySelectorAll('button')].find(element => element.textContent === text); expect(item).toBeDefined(); return item! }
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''; document.head.querySelectorAll('style').forEach(style => style.remove()) })

describe('official article panel registration', () => {
  it('registers a fixed main entry and sidebar metadata after Remote mount, independently of any tool call', async () => {
    const h = host(); let mounted!: () => void; h.ctx.remote.$mount.mockImplementation(() => new Promise(resolve => { mounted = resolve }))
    const applying = apply(h.ctx as unknown as Context)
    expect(h.entries.size).toBe(0)
    mounted(); await applying
    expect(inject).toEqual(expect.arrayContaining(['slots', 'remote', 'sessions', 'layout']))
    expect(h.entries.get('main')?.options.key).toBe('md2wechat-articles')
    expect(h.entries.get('sidebar.panellist')?.options).toMatchObject({ id: 'md2wechat-articles', label: '文章' })
    expect(h.entries.has('sidebar.right.pane.tab')).toBe(false)
    await render(h.entries.get('main')!.component)
    expect(container.querySelector('[aria-label="文章主工作区"]')).not.toBeNull()
    expect(h.ctx.sessions.retain).not.toHaveBeenCalled()
    expect(h.ctx.remote.md2wechat.list).not.toHaveBeenCalled()
    expect(document.head.textContent).toContain('.workspace-style{}')
    expect(document.head.textContent).toContain('.article-panel-style{}')
    await act(async () => root!.unmount()); root = undefined
    h.dispose(); expect(h.entries.size).toBe(0); expect(document.head.querySelector('style')).toBeNull()
  })

  it('keeps a valid message as a shortcut and uses its authenticated prop session, not a metadata session', async () => {
    const h = host(); await apply(h.ctx as unknown as Context)
    await render(h.entries.get('tool.call.toolview')!.component, { sessionId: 'A', block: { meta: { kind: 'md2wechat-creator', schemaVersion: 1, articleId: 'saved', sessionId: 'untrusted-other-session' } } })
    expect(container.querySelector('[aria-label="文章工作区"]')).toBeNull()
    expect(h.ctx.remote.md2wechat.get).not.toHaveBeenCalled()
    await act(async () => { button('打开文章').click() })
    expect(h.ctx.layout.selectPanel).toHaveBeenCalledWith('md2wechat-articles')
    await act(async () => { root!.render(createElement(h.entries.get('main')!.component)) })
    expect(h.ctx.sessions.retain).toHaveBeenCalledWith('A', { source: 'mainView', signal: expect.any(AbortSignal) })
    expect(h.ctx.remote.md2wechat.resume).toHaveBeenCalledWith('A', 'saved', expect.any(AbortSignal))
    expect(h.ctx.remote.md2wechat.open).not.toHaveBeenCalled()
    await act(async () => root!.unmount()); root = undefined; expect(h.release).toHaveBeenCalledTimes(1); h.dispose()
  })

  it('offers explicit source recovery for old malformed card metadata without guessing any article', async () => {
    const h = host(); await apply(h.ctx as unknown as Context)
    await render(h.entries.get('tool.call.toolview')!.component, { sessionId: 'A', block: { meta: { kind: 'md2wechat-creator', schemaVersion: 1 } } })
    await act(async () => { button('选择原文恢复').click() })
    await act(async () => { root!.render(createElement(h.entries.get('main')!.component)) })
    expect(h.ctx.remote.md2wechat.resume).not.toHaveBeenCalled(); expect(h.ctx.remote.md2wechat.open).not.toHaveBeenCalled()
    expect(container.querySelector('input[aria-label="Markdown 路径"]')).not.toBeNull()
    h.dispose()
  })
})
