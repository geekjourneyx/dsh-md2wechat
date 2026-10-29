import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CreatorRemote } from '../../src/creator/remote.ts'
import { CreatorService } from '../../src/creator/service.ts'
import { creatorOperations } from '../../src/creator/runtime.ts'
import { creatorErrorInfo } from '../../src/creator/errors.ts'
import type { CreatorBackend } from '../../src/creator/remote.ts'
import type { CreatorErrorCode } from '../../src/creator/errors.ts'
import { resolveConfig } from '../../src/config.ts'
import { ImagePlanStateStore } from '../../src/workspace/image-plan-state.ts'
import { DraftStateStore } from '../../src/workspace/draft.ts'

interface Target { targetKey: string; displayPath: string }
const roots: string[] = []
const signal = new AbortController().signal
const owner = { id: 'owner-a' } as Agent
const unknownId = '00000000-0000-0000-0000-000000000000'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
function remote(backend?: CreatorBackend) {
  const ctx = new Context()
  return new CreatorRemote(ctx, backend)
}
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'creator-remote-')); roots.push(workspace)
  const stateDir = await mkdtemp(join(process.cwd(), '.state-test-creator-remote-')); roots.push(stateDir)
  let readable = true; let mode = 'workspace-write'; let themeCalls = 0
  const fs = {
    async resolve(path: string, options?: { cwd?: string }): Promise<Target> {
      if (!readable) throw Object.assign(new Error(`permission denied /private/${path} secret-token`), { code: 'EACCES' })
      const displayPath = resolve(options?.cwd ?? workspace, path); let ancestor = displayPath; const missing: string[] = []
      while (true) {
        try { return { displayPath, targetKey: join(await realpath(ancestor), ...missing) } }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; missing.unshift(basename(ancestor)); ancestor = dirname(ancestor) }
      }
    },
    processPath: (target: Target) => target.targetKey,
    contains(parent: Target, child: Target) { const path = relative(parent.targetKey, child.targetKey); return path === '' || (!path.startsWith('..') && !isAbsolute(path)) },
    async stat(target: Target) { try { const value = await stat(target.targetKey); return { version: `${value.mtimeMs}:${value.size}`, type: value.isFile() ? 'file' : 'directory', size: value.size } } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error } },
    async readBytes(target: Target, readSignal: AbortSignal | undefined, maxBytes: number) {
      readSignal?.throwIfAborted()
      try { const bytes = await readFile(target.targetKey); if (bytes.byteLength > maxBytes) throw new Error('too large'); return bytes }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw Object.assign(new Error('missing file'), { code: 'FS_NOT_FOUND' }); throw error }
    },
  }
  const ctx = { fs, sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: workspace }) } }
  const agent = { id: 'owner-a', session: { header: { cwd: workspace } }, followup: () => { throw new Error('unexpected model request') } } as unknown as Agent
  const config = resolveConfig({ stateDir, artifactsDir: '.articles' })
  const gateway = { resolve: async () => 'md2wechat', run: async (argv: string[], options: { signal: AbortSignal; beforeSpawn?: (signal: AbortSignal) => Promise<void> }) => { await options.beforeSpawn?.(options.signal); themeCalls++; if (argv.join(' ') !== 'themes list --json') throw new Error('unexpected external command'); return { success: true, status: 'completed', code: 'THEMES_SHOWN', data: { themes: [{ type: 'api', selectable: true, name: 'default', description: 'Default' }, { type: 'api', selectable: true, name: 'simple', description: 'Simple' }] } } } }
  const service = () => new CreatorService(creatorOperations(ctx as never, config, gateway as never, () => {}, {} as never, new ImagePlanStateStore(stateDir), new DraftStateStore(stateDir)), 'default', '.articles')
  await writeFile(join(workspace, 'a.md'), '# Article\n\nOriginal paragraph.\n')
  return { workspace, agent, service, denyReads: () => { readable = false }, readonly: () => { mode = 'read-only' }, calls: () => themeCalls }
}
async function failureCode(result: Promise<unknown>, code: CreatorErrorCode) {
  const error = await result.then(() => { throw new Error('expected Remote failure') }, value => value)
  expect(error).toBeInstanceOf(Error)
  expect(error.message).toMatch(new RegExp(`^\\[md2wechat:${code}\\] `, 'u'))
  // Simulate both host carriers retaining message but discarding custom Error fields.
  const transported = JSON.parse(JSON.stringify({ message: error.message }))
  expect(creatorErrorInfo(transported).code).toBe(code)
  return { error, info: creatorErrorInfo(transported) }
}

describe('authenticated article Remote contract', () => {
  it('marks every endpoint for injected Agent lookup and exposes no caller-supplied owner', () => {
    expect(remoteMethods(remote()).map(marker => marker.exportName ?? marker.method).sort()).toEqual(['discoverRevisions', 'dispatch', 'get', 'importImageBytes', 'importSource', 'list', 'open', 'recoverRevision', 'resume', 'session'])
  })

  it('lists and resumes only the authenticated session even when sessions share a directory', async () => {
    const f = await fixture(); const api = remote(f.service())
    const opened = await api.open(f.agent, 'a.md', '', {}, signal)
    expect(await api.list(f.agent, signal)).toMatchObject([{ articleId: opened.articleId }])
    const other = { ...f.agent, id: 'owner-b' } as Agent
    expect(await api.list(other, signal)).toEqual([])
    const { error } = await failureCode(api.resume(other, opened.articleId, signal), 'PERMISSION_DENIED')
    expect(error.message).not.toContain(opened.markdown)
    expect(await api.resume(f.agent, opened.articleId, signal)).toMatchObject({ articleId: opened.articleId, markdown: opened.markdown })
  })

  it('rechecks revoked read access on every read, listing and mutation after opening', async () => {
    const f = await fixture(); const api = remote(f.service())
    const opened = await api.open(f.agent, 'a.md', '', {}, signal)
    f.denyReads()
    for (const request of [() => api.get(f.agent, opened.articleId, signal), () => api.resume(f.agent, opened.articleId, signal), () => api.list(f.agent, signal), () => api.dispatch(f.agent, opened.articleId, 1, { type: 'select-theme', theme: 'simple' }, signal)]) {
      const { error } = await failureCode(request(), 'PERMISSION_DENIED')
      expect(error.message).not.toMatch(/private|secret-token|EACCES/u)
    }
    expect(f.calls()).toBe(1)
  })

  it('permits a read-only resume but refuses the next write under the current policy', async () => {
    const f = await fixture(); const api = remote(f.service())
    const opened = await api.open(f.agent, 'a.md', '', {}, signal)
    f.readonly()
    expect(await api.resume(f.agent, opened.articleId, signal)).toMatchObject({ articleId: opened.articleId })
    await failureCode(api.dispatch(f.agent, opened.articleId, 1, { type: 'select-theme', theme: 'simple' }, signal), 'PERMISSION_DENIED')
    expect((await api.get(f.agent, opened.articleId, signal)).theme).toBe('default')
  })

  it('distinguishes an absent saved article from an unavailable host', async () => {
    const f = await fixture()
    const missing = await failureCode(remote(f.service()).resume(f.agent, unknownId, signal), 'ARTICLE_NOT_FOUND')
    expect(missing.info.actions).toContain('open-source')
    await failureCode(remote().get(f.agent, unknownId, signal), 'HOST_UNAVAILABLE')
    await failureCode(remote().list(f.agent, signal), 'HOST_UNAVAILABLE')
  })

  it('requires explicit source-change resolution and preserves stable identity or imports a new article', async () => {
    const f = await fixture(); const api = remote(f.service())
    const opened = await api.open(f.agent, 'a.md', '', {}, signal)
    expect((await api.open(f.agent, 'a.md', '', {}, signal)).articleId).toBe(opened.articleId)
    await writeFile(join(f.workspace, 'a.md'), '# Changed source\n')
    const changed = await failureCode(api.open(f.agent, 'a.md', '', {}, signal), 'SOURCE_CHANGED')
    expect(changed.info.actions).toEqual(['continue', 'import-new'])
    expect(await api.open(f.agent, 'a.md', '', { mode: 'continue' }, signal)).toMatchObject({ articleId: opened.articleId, markdown: opened.markdown })
    const imported = await api.open(f.agent, 'a.md', '', { mode: 'import-new' }, signal)
    expect(imported.articleId).not.toBe(opened.articleId)
    expect(imported.markdown).toBe('# Changed source\n')
    expect(await api.list(f.agent, signal)).toHaveLength(2)
  })

  it('preserves get/dispatch view responses and reports stale versions without publishing another write', async () => {
    const f = await fixture(); const api = remote(f.service())
    const opened = await api.open(f.agent, 'a.md', '', {}, signal)
    expect(await api.get(f.agent, opened.articleId, signal)).toMatchObject({ schemaVersion: 1, articleId: opened.articleId, version: 1 })
    expect(await api.dispatch(f.agent, opened.articleId, 1, { type: 'select-theme', theme: 'simple' }, signal)).toMatchObject({ schemaVersion: 1, version: 2, theme: 'simple' })
    const conflict = await failureCode(api.dispatch(f.agent, opened.articleId, 1, { type: 'select-theme', theme: 'default' }, signal), 'VERSION_CONFLICT')
    expect(conflict.info.actions).toContain('refresh')
    expect((await api.get(f.agent, opened.articleId, signal)).theme).toBe('simple')
  })

  it('reports tampered saved artifacts distinctly and strips backend diagnostics', async () => {
    const f = await fixture(); const opened = await remote(f.service()).open(f.agent, 'a.md', '', {}, signal)
    const document = JSON.parse(await readFile(join(f.workspace, '.articles', 'documents', `${opened.articleId}.json`), 'utf8'))
    await writeFile(join(f.workspace, '.articles', 'revisions', document.revision.id, 'article.md'), '# tampered')
    const invalid = await failureCode(remote(f.service()).resume(f.agent, opened.articleId, signal), 'ARTIFACT_INVALID')
    expect(invalid.error.message).not.toContain(f.workspace)
    expect(invalid.error.cause).toBeUndefined()
  })

  it.each([
    ['PERMISSION_DENIED', Object.assign(new Error('/private/path token=secret'), { code: 'EACCES' })],
    ['PERMISSION_DENIED', new Error('creator operation rejected by admission policy')],
    ['HOST_UNAVAILABLE', Object.assign(new Error('connection secret'), { code: 'ECONNRESET' })],
    ['HOST_UNAVAILABLE', new Error('当前宿主缺少文章工作区所需的会话权限服务。')],
    ['OPERATION_FAILED', new Error('unexpected backend /private/path token=secret')],
    ['OPERATION_FAILED', new TypeError('creator document article identity is invalid')],
    ['ARTIFACT_INVALID', new TypeError('creator document schema version is invalid')],
  ] as const)('maps %s failures to bounded browser-safe diagnostics', async (code, cause) => {
    const failing = vi.fn(async () => { throw cause })
    const api = remote({ get: failing, dispatch: failing } as CreatorBackend)
    const { error } = await failureCode(api.get(owner, unknownId, signal), code)
    expect(error.message).not.toMatch(/private|secret|token=| at /u)
    expect(error.cause).toBeUndefined()
  })

  it('reports malformed saved JSON as an invalid artifact without revealing its contents', async () => {
    const f = await fixture(); const opened = await remote(f.service()).open(f.agent, 'a.md', '', {}, signal)
    await writeFile(join(f.workspace, '.articles', 'documents', `${opened.articleId}.json`), '{secret-token')
    const { error } = await failureCode(remote(f.service()).resume(f.agent, opened.articleId, signal), 'ARTIFACT_INVALID')
    expect(error.message).not.toMatch(/secret|SyntaxError/u)
  })

  it('sanitizes even hostile thrown objects and preserves pre-invocation permission failures', async () => {
    const hostile = Object.defineProperty({}, 'message', { get() { throw new Error('/private/secret') } })
    const failing = async () => { throw hostile }
    await failureCode(remote({ get: failing, dispatch: failing } as CreatorBackend).get(owner, unknownId, signal), 'OPERATION_FAILED')
    expect(creatorErrorInfo(hostile).code).toBe('HOST_UNAVAILABLE')
    for (const code of ['remote-access/denied', 'gateway/interactions-forbidden']) {
      expect(creatorErrorInfo({ code, message: '/private/secret' })).toMatchObject({ code: 'PERMISSION_DENIED' })
    }
  })

  it('does not invoke a backend or expose an arbitrary cancellation reason once aborted', async () => {
    const called = vi.fn(async () => { throw new Error('should not run') })
    const api = remote({ get: called, dispatch: called, list: called, open: called, resume: called, discoverRevisions: called, recoverRevision: called })
    const aborted = new AbortController(); aborted.abort(new Error('/private/cancel-reason secret-token'))
    for (const request of [() => api.session(owner, aborted.signal), () => api.get(owner, unknownId, aborted.signal), () => api.list(owner, aborted.signal), () => api.open(owner, 'a.md', '', {}, aborted.signal), () => api.resume(owner, unknownId, aborted.signal), () => api.dispatch(owner, unknownId, 1, { type: 'refresh-preview' }, aborted.signal)]) {
      const { error } = await failureCode(request(), 'HOST_UNAVAILABLE')
      expect(error.message).not.toMatch(/private|secret|cancel-reason/u)
    }
    expect(called).not.toHaveBeenCalled()
  })

  it('does not publish a late successful backend response after cancellation', async () => {
    const f = await fixture(); const service = f.service(); const view = await service.open(f.agent, 'a.md', '', signal)
    const result = Promise.withResolvers<typeof view>()
    const api = remote({ get: async () => result.promise, dispatch: async () => result.promise } as CreatorBackend)
    const abort = new AbortController(); const pending = api.get(f.agent, view.articleId, abort.signal)
    abort.abort(); result.resolve(view)
    await failureCode(pending, 'HOST_UNAVAILABLE')
  })

  it('parses only finite markers and never reflects arbitrary error text into the UI', () => {
    expect(creatorErrorInfo({ message: '[md2wechat:SOURCE_CHANGED] /private/secret' })).toMatchObject({ code: 'SOURCE_CHANGED', actions: ['continue', 'import-new'] })
    for (const error of ['secret', null, new Error('token=secret'), { message: '[md2wechat:FAKE] secret' }, { message: 'prefix [md2wechat:SOURCE_CHANGED] secret' }]) {
      const info = creatorErrorInfo(error)
      expect(info.code).toBe('HOST_UNAVAILABLE')
      expect(info.message).not.toContain('secret')
    }
  })
})
