// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ArticlePanel } from '../../src/client/ArticlePanel.tsx'
import { createArticlePanelNavigation, PANEL_ID } from '../../src/client/article-panel-model.ts'
import type { ArticlePanelClient, ArticlePanelArticle } from '../../src/client/article-panel-model.ts'
import type { CreatorView } from '../../src/creator/types.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let container: HTMLDivElement
const article = (articleId: string, title = articleId): ArticlePanelArticle => ({ articleId, title, sourcePath: `${articleId}.md`, updatedAt: '2026-10-20T12:00:00.000Z' })
const baseView: CreatorView = { schemaVersion: 1, articleId: 'a', version: 1, title: '文章 a', publicationTitle: '文章 a', markdown: '# 正文', theme: 'default', themes: [], preview: { status: 'empty', path: '', sha256: '', assets: [], message: '' }, reviewed: false, preparedForDraft: false, draftEnabled: false, imageCandidates: [], imagePlacements: [], imageRequest: null, coverId: '', delivery: null, suggestions: [], suggestionRequest: null, canUndo: false }
function fixture(overrides: Partial<ArticlePanelClient> = {}): ArticlePanelClient {
  return {
    listSessions: vi.fn(async () => [{ sessionId: 'A', title: '会话 A', workspaceLabel: '/project-a' }, { sessionId: 'B', title: '会话 B', workspaceLabel: '/project-b' }]),
    retainSession: vi.fn(() => ({ ready: Promise.resolve(), release: vi.fn() })),
    getArticles: vi.fn(async sessionId => [article(`${sessionId}-saved`, `${sessionId} 的文章`)]),
    open: vi.fn(async (_sessionId, request) => article('opened', request.sourcePath)),
    resume: vi.fn(async (_sessionId, articleId) => article(articleId)),
    discoverRevisions: vi.fn(async () => []),
    recoverRevision: vi.fn(async () => article('recovered')),
    createWorkspaceClient: vi.fn((_sessionId, articleId) => ({ get: async () => ({ ...baseView, articleId, title: `正文 ${articleId}`, publicationTitle: `正文 ${articleId}` }), dispatch: async () => baseView, readPreview: async () => '' })),
    ...overrides,
  }
}
async function mount(client: ArticlePanelClient, navigation = createArticlePanelNavigation()) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(createElement(ArticlePanel, { client, navigation })) })
  return navigation
}
async function choose(sessionId: string) {
  await act(async () => { const select = container.querySelector('select[aria-label="选择会话"]') as HTMLSelectElement; select.value = sessionId; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent === text)
  expect(found, `button ${text}`).toBeDefined()
  return found!
}
async function click(text: string) { await act(async () => { button(text).click() }) }
async function enterSource(path: string) {
  await act(async () => { const input = container.querySelector('input[aria-label="Markdown 路径"]') as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, path); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })

describe('independent article main panel shell', () => {
  it('has a stable panel identity and explicit session empty state without creating or opening anything', async () => {
    const client = fixture()
    await mount(client)
    expect(PANEL_ID).toBe('md2wechat-articles')
    expect(container.querySelector('main[aria-label="文章主工作区"]')).not.toBeNull()
    expect(container.textContent).toContain('回到对话，开始写文章')
    expect(container.textContent).toContain('会话 A')
    expect(client.retainSession).not.toHaveBeenCalled()
    expect(client.getArticles).not.toHaveBeenCalled()
    expect(client.open).not.toHaveBeenCalled()
    expect(client.resume).not.toHaveBeenCalled()
    expect(container.querySelector('input[aria-label="Markdown 路径"]')).toBeNull()
  })

  it('lists only the explicitly selected session and continues its most recently saved article', async () => {
    const client = fixture({ getArticles: vi.fn(async () => [article('older', '旧文'), { ...article('recent', '最近文章'), updatedAt: '2026-10-20T13:00:00Z' }]) })
    await mount(client); await choose('A')
    expect(client.getArticles).toHaveBeenCalledWith('A', expect.any(AbortSignal))
    expect(client.resume).not.toHaveBeenCalled()
    expect(container.textContent).toContain('最近文章')
    await click('查看最近文章')
    expect(client.resume).toHaveBeenCalledWith('A', 'recent', expect.any(AbortSignal))
    expect(client.createWorkspaceClient).toHaveBeenCalledWith('A', 'recent')
    expect(container.textContent).toContain('正文 recent')
    expect(container.textContent).toContain('这里只查看已保存的文章')
    expect(container.querySelector('[aria-label="历史文章预览"]')).not.toBeNull()
    for (const label of ['换个标题', '更换封面', '存为草稿', '编辑正文']) expect(container.textContent).not.toContain(label)
  })

  it('supports an exact message navigation target without opening or guessing another article', async () => {
    const client = fixture()
    const navigation = createArticlePanelNavigation(); navigation.openArticle('A', 'from-message')
    await mount(client, navigation)
    expect(client.resume).toHaveBeenCalledWith('A', 'from-message', expect.any(AbortSignal))
    expect(client.open).not.toHaveBeenCalled()
    expect(container.textContent).toContain('正文 from-message')
  })

  it('keeps only navigation across remount and restores the article through the service again', async () => {
    const client = fixture(); const navigation = createArticlePanelNavigation(); navigation.openArticle('A', 'saved')
    await mount(client, navigation)
    await act(async () => { root!.unmount() }); root = undefined
    await mount(client, navigation)
    expect(client.resume).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('正文 saved')
    expect(Object.keys(navigation.getSnapshot()).sort()).toEqual(['articleId', 'sequence', 'sessionId'])
  })

  it('opens Markdown only on form submission and uses the returned stable article identity', async () => {
    const client = fixture(); const navigation = await mount(client); await choose('A')
    await enterSource('articles/example.md')
    expect(client.open).not.toHaveBeenCalled()
    await click('打开 Markdown')
    expect(client.open).toHaveBeenCalledWith('A', { sourcePath: 'articles/example.md' }, expect.any(AbortSignal))
    expect(navigation.getSnapshot()).toMatchObject({ sessionId: 'A', articleId: 'opened' })
    expect(container.textContent).toContain('正文 opened')
  })

  it('shows a useful empty article state without importing automatically', async () => {
    const client = fixture({ getArticles: vi.fn(async () => []) })
    await mount(client); await choose('B')
    expect(container.textContent).toContain('这段对话还没有文章')
    expect(button('打开 Markdown').disabled).toBe(true)
    expect(client.open).not.toHaveBeenCalled()
    expect(client.resume).not.toHaveBeenCalled()
  })

  it('aborts and ignores an old session list response after switching A to B, releasing each lease once', async () => {
    const a = deferred<ArticlePanelArticle[]>(); const releases = { A: vi.fn(), B: vi.fn() }; let aSignal!: AbortSignal
    const client = fixture({ retainSession: vi.fn(id => ({ ready: Promise.resolve(), release: releases[id as 'A' | 'B'] })), getArticles: vi.fn(async (id, signal) => { if (id === 'A') { aSignal = signal; return a.promise } return [article('b-only', '只属于 B')] }) })
    await mount(client); await choose('A')
    expect(container.textContent).toContain('正在读取已保存文章')
    await choose('B')
    expect(aSignal.aborted).toBe(true)
    expect(releases.A).toHaveBeenCalledTimes(1)
    await act(async () => { a.resolve([article('a-secret', '不应显示的 A')]) })
    expect(container.textContent).toContain('只属于 B')
    expect(container.textContent).not.toContain('不应显示的 A')
    await act(async () => { root!.unmount() }); root = undefined
    expect(releases.A).toHaveBeenCalledTimes(1); expect(releases.B).toHaveBeenCalledTimes(1)
  })

  it('ignores a late article resume and its error after newer article navigation', async () => {
    const first = deferred<ArticlePanelArticle>(); let firstSignal!: AbortSignal
    const client = fixture({ resume: vi.fn(async (_id, articleId, signal) => { if (articleId === 'first') { firstSignal = signal; return first.promise } return article(articleId) }) })
    const navigation = createArticlePanelNavigation(); navigation.openArticle('A', 'first'); await mount(client, navigation)
    await act(async () => { navigation.openArticle('A', 'second') })
    expect(firstSignal.aborted).toBe(true)
    await act(async () => { first.reject(new Error('old secret failure')) })
    expect(container.textContent).toContain('正文 second')
    expect(container.textContent).not.toContain('old secret failure')
    expect(client.createWorkspaceClient).toHaveBeenCalledTimes(1)
    expect(client.createWorkspaceClient).toHaveBeenCalledWith('A', 'second')
  })

  it('aborts a pending open on session switch and never navigates to its late result', async () => {
    const opening = deferred<ArticlePanelArticle>(); let signal!: AbortSignal
    const client = fixture({ open: vi.fn(async (_id, _request, currentSignal) => { signal = currentSignal; return opening.promise }) })
    const navigation = await mount(client); await choose('A'); await enterSource('a.md'); await click('打开 Markdown'); await choose('B')
    expect(signal.aborted).toBe(true)
    await act(async () => { opening.resolve(article('late-a')) })
    expect(navigation.getSnapshot()).toMatchObject({ sessionId: 'B', articleId: '' })
    expect(container.textContent).not.toContain('正文 late-a')
  })

  it('waits for session readiness and releases on unmount even when acquisition fails late', async () => {
    const ready = deferred<void>(); const release = vi.fn(); const client = fixture({ retainSession: vi.fn(() => ({ ready: ready.promise, release })) })
    await mount(client); await choose('A')
    expect(client.getArticles).not.toHaveBeenCalled()
    expect(container.textContent).toContain('正在连接所选会话')
    await act(async () => { root!.unmount() }); root = undefined
    expect(release).toHaveBeenCalledTimes(1)
    await act(async () => { ready.reject(new Error('late acquisition')) })
    expect(client.getArticles).not.toHaveBeenCalled()
  })

  it('shows safe actionable errors and retries without exposing raw remote details', async () => {
    let calls = 0
    const client = fixture({ getArticles: vi.fn(async () => { if (!calls++) throw { code: 'FORBIDDEN', message: 'token=do-not-render' }; return [article('retry')] }) })
    await mount(client); await choose('A')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('权限')
    expect(container.textContent).not.toContain('do-not-render')
    await click('重试读取文章')
    expect(container.textContent).toContain('retry')
  })

  it('requires an explicit source-change choice instead of silently overwriting saved work', async () => {
    const client = fixture({ open: vi.fn(async (_id, request) => { if (!request.sourceChange) throw { code: 'SOURCE_CHANGED', message: 'private diagnostic' }; return article('saved-copy') }) })
    await mount(client); await choose('A'); await enterSource('changed.md'); await click('打开 Markdown')
    expect(container.textContent).toContain('源文件已变化')
    expect(client.resume).not.toHaveBeenCalled()
    await click('继续已保存版本')
    expect(client.open).toHaveBeenLastCalledWith('A', { sourcePath: 'changed.md', sourceChange: 'continue-saved' }, expect.any(AbortSignal))
    expect(container.textContent).toContain('正文 saved-copy')
  })

  it('does not guess a replacement when an old article shortcut no longer resolves', async () => {
    const client = fixture({ resume: vi.fn(async () => { throw { code: 'ARTICLE_NOT_FOUND', message: 'unknown id' } }) }); const navigation = createArticlePanelNavigation(); navigation.openArticle('A', 'gone')
    await mount(client, navigation)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('重新打开 Markdown')
    expect(client.open).not.toHaveBeenCalled(); expect(client.createWorkspaceClient).not.toHaveBeenCalled()
    expect(container.querySelector('input[aria-label="Markdown 路径"]')).not.toBeNull()
  })

  it('refreshes the saved catalog when leaving an edited article, so continue-latest does not select stale data', async () => {
    let edited = false
    const client = fixture({ getArticles: vi.fn(async () => [{ ...article('A'), updatedAt: edited ? '2026-10-20T14:00:00Z' : '2026-10-20T10:00:00Z' }, { ...article('B'), updatedAt: '2026-10-20T12:00:00Z' }]) })
    const navigation = await mount(client); await choose('A')
    await act(async () => { navigation.openArticle('A', 'A') })
    edited = true
    await click('返回文章列表'); await click('查看最近文章')
    expect(client.resume).toHaveBeenLastCalledWith('A', 'A', expect.any(AbortSignal))
  })

  it('allows refreshing a nonempty session directory to discover newly created sessions', async () => {
    let added = false
    const client = fixture({ listSessions: vi.fn(async () => [{ sessionId: 'A', title: '现有会话' }, ...(added ? [{ sessionId: 'new', title: '新建会话' }] : [])]) })
    await mount(client); added = true; await click('刷新会话列表')
    expect(container.querySelector('select')?.textContent).toContain('新建会话')
    expect(client.retainSession).not.toHaveBeenCalled()
  })

  it('waits for the replacement client lease before listing or restoring the selected session', async () => {
    const navigation = createArticlePanelNavigation(); navigation.openArticle('A', 'saved')
    await mount(fixture(), navigation)
    const ready = deferred<void>(); const client = fixture({ retainSession: vi.fn(() => ({ ready: ready.promise, release: vi.fn() })) })
    await act(async () => { root!.render(createElement(ArticlePanel, { client, navigation })) })
    expect(client.getArticles).not.toHaveBeenCalled(); expect(client.resume).not.toHaveBeenCalled()
    await act(async () => { ready.resolve() })
    expect(client.getArticles).toHaveBeenCalledTimes(1); expect(client.resume).toHaveBeenCalledTimes(1)
  })

  it('discovers legacy revisions only on explicit request and recovers only an explicitly selected manifest', async () => {
    const client = fixture({ discoverRevisions: vi.fn(async () => [{ revisionId: 'old-r1', manifestPath: '.md2wechat/revisions/old-r1/manifest.json', title: '旧文章', createdAt: '2026-10-19T12:00:00Z' }]) })
    const navigation = await mount(client); await choose('A')
    expect(client.discoverRevisions).not.toHaveBeenCalled(); expect(client.recoverRevision).not.toHaveBeenCalled()
    await click('选择已保存版本')
    expect(client.discoverRevisions).toHaveBeenCalledWith('A', expect.any(AbortSignal))
    expect(button('恢复所选版本').disabled).toBe(true)
    expect(client.recoverRevision).not.toHaveBeenCalled()
    await act(async () => { const select = container.querySelector('select[aria-label="选择已保存文章版本"]') as HTMLSelectElement; select.value = '.md2wechat/revisions/old-r1/manifest.json'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await click('恢复所选版本')
    expect(client.recoverRevision).toHaveBeenCalledWith('A', '.md2wechat/revisions/old-r1/manifest.json', expect.any(AbortSignal))
    expect(navigation.getSnapshot()).toMatchObject({ sessionId: 'A', articleId: 'recovered' })
    expect(client.open).not.toHaveBeenCalled(); expect(container.textContent).toContain('正文 recovered')
  })

  it('ignores late legacy discovery after session navigation and never automatically chooses a candidate', async () => {
    const pending = deferred<readonly { revisionId: string; manifestPath: string; title: string; createdAt: string }[]>(); let signal!: AbortSignal
    const client = fixture({ discoverRevisions: vi.fn(async (_id, currentSignal) => { signal = currentSignal; return pending.promise }) })
    await mount(client); await choose('A'); await click('选择已保存版本'); await choose('B')
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve([{ revisionId: 'a-secret', manifestPath: 'a/manifest.json', title: '不该出现的旧版本', createdAt: '' }]) })
    expect(container.textContent).not.toContain('不该出现的旧版本'); expect(client.recoverRevision).not.toHaveBeenCalled()
  })

  it('explains an empty legacy catalog and preserves the original Markdown recovery option', async () => {
    await mount(fixture()); await choose('A'); await click('选择已保存版本')
    expect(container.textContent).toContain('没有找到可恢复的已保存版本')
    expect(container.querySelector('input[aria-label="Markdown 路径"]')).not.toBeNull()
  })

  it('uses container-responsive layout so a narrow host panel never forces fixed-width columns', async () => {
    const css = await readFile(resolve('src/client/ArticlePanel.css'), 'utf8')
    expect(css).toContain('container-type: inline-size')
    expect(css).toContain('@container md2-article-panel')
    expect(css).toContain('minmax(0, 1fr)')
    expect(css).toContain('overflow-wrap: anywhere')
  })
})
