// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createArticlePanelClient, createCreatorClient } from '../../src/client/creator-client.ts'
vi.stubGlobal('crypto', webcrypto)
afterEach(() => vi.clearAllMocks())
function host() {
  const remote = { md2wechat: { discoverRevisions: vi.fn(async () => ({ ok: true, value: [] })), recoverRevision: vi.fn(async () => ({ ok: true, value: { articleId: 'recovered', title: '旧文章' } })), list: vi.fn(async () => ({ ok: true, value: [] })), open: vi.fn(async () => ({ ok: true, value: { articleId: 'stable', title: '文章' } })), resume: vi.fn(async () => ({ ok: true, value: { articleId: 'stable', title: '文章' } })), get: vi.fn(async () => ({ ok: true, value: { articleId: 'stable' } })), dispatch: vi.fn(async () => ({ ok: true, value: { articleId: 'stable' } })) }, workspaceFiles: { readBytes: vi.fn() } }
  const sessions = { refresh: vi.fn(async () => {}), list: { getSnapshot: () => ({ phase: 'ready', ids: ['A'], byId: { A: { id: 'A', displayTitle: '会话 A', cwd: '/workspace/a' }, hidden: { id: 'hidden', displayTitle: 'retained only' } } }) }, retain: vi.fn(() => ({ ready: Promise.resolve({}), release: vi.fn() })) }
  return { remote, sessions }
}
describe('shared authenticated creator client adapter', () => {
  it('uses only official catalog ids, explicit retain and exact session-scoped endpoints', async () => {
    const ctx = host(); const client = createArticlePanelClient(ctx as unknown as Context); const signal = new AbortController().signal
    expect(await client.listSessions(signal)).toEqual([{ sessionId: 'A', title: '会话 A', workspaceLabel: '/workspace/a' }])
    expect(ctx.sessions.retain).not.toHaveBeenCalled()
    const ref = client.retainSession('A', signal); await ref.ready; ref.release()
    expect(ctx.sessions.retain).toHaveBeenCalledWith('A', { source: 'mainView', signal })
    await client.getArticles('A', signal); await client.open('A', { sourcePath: 'a.md', sourceChange: 'continue-saved' }, signal)
    expect(ctx.remote.md2wechat.list).toHaveBeenCalledWith('A', signal)
    expect(ctx.remote.md2wechat.open).toHaveBeenCalledWith('A', 'a.md', '', { mode: 'continue' }, signal)
    await client.open('A', { sourcePath: 'a.md', sourceChange: 'reimport' }, signal)
    expect(ctx.remote.md2wechat.open).toHaveBeenLastCalledWith('A', 'a.md', '', { mode: 'import-new' }, signal)
    await client.resume('A', 'stable', signal)
    expect(ctx.remote.md2wechat.resume).toHaveBeenCalledWith('A', 'stable', signal)
  })
  it('does not scan or recover until called and preserves the exact session and manifest target', async () => {
    const ctx = host(); const client = createArticlePanelClient(ctx as unknown as Context); const signal = new AbortController().signal
    expect(ctx.remote.md2wechat.discoverRevisions).not.toHaveBeenCalled(); expect(ctx.remote.md2wechat.recoverRevision).not.toHaveBeenCalled()
    await client.discoverRevisions('A', signal)
    expect(ctx.remote.md2wechat.discoverRevisions).toHaveBeenCalledWith('A', signal)
    expect(await client.recoverRevision('A', '.md2wechat/revisions/r/manifest.json', signal)).toMatchObject({ articleId: 'recovered' })
    expect(ctx.remote.md2wechat.recoverRevision).toHaveBeenCalledWith('A', '.md2wechat/revisions/r/manifest.json', signal)
    expect(ctx.remote.md2wechat.open).not.toHaveBeenCalled()
  })
  it('treats a still-pending directory after fulfilled refresh as unavailable, not an empty catalog', async () => {
    const ctx = host(); vi.spyOn(ctx.sessions.list, 'getSnapshot').mockReturnValue({ phase: 'pending', ids: [], byId: {} } as never)
    const client = createArticlePanelClient(ctx as unknown as Context)
    await expect(client.listSessions(new AbortController().signal)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' })
  })
  it('normalizes Remote marker errors into safe typed recovery metadata', async () => {
    const ctx = host(); ctx.remote.md2wechat.open.mockResolvedValue({ ok: false, error: { message: '[md2wechat:SOURCE_CHANGED] token=never-render' } } as never)
    const client = createArticlePanelClient(ctx as unknown as Context)
    await expect(client.open('A', { sourcePath: 'a.md' }, new AbortController().signal)).rejects.toMatchObject({ code: 'SOURCE_CHANGED', actions: ['continue', 'import-new'] })
    await expect(client.open('A', { sourcePath: 'a.md' }, new AbortController().signal)).rejects.not.toHaveProperty('message', expect.stringContaining('never-render'))
  })
  it('verifies preview/image bytes and keeps all reads scoped to the same explicit session', async () => {
    const ctx = host(); const bytes = new TextEncoder().encode('<h1>文章</h1>'); const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex')
    ctx.remote.workspaceFiles.readBytes.mockResolvedValue({ ok: true, value: { data: bytes } } as never)
    const client = createCreatorClient(ctx as unknown as Context, 'A', 'stable'); const signal = new AbortController().signal
    const html = await client.readPreview({ status: 'ready', path: 'preview.html', sha256: digest, assets: [], message: '' }, signal)
    expect(html).toContain('文章'); expect(ctx.remote.workspaceFiles.readBytes).toHaveBeenCalledWith('A', 'preview.html', {}, signal)
    await expect(client.readPreview({ status: 'ready', path: 'preview.html', sha256: 'mismatch', assets: [], message: '' }, signal)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
  })
})

it('never guesses the current session from the first catalog entry', () => {
 const client = createArticlePanelClient(host() as unknown as Context)
 expect(client.getCurrentSessionId?.()).toBeUndefined()
})
