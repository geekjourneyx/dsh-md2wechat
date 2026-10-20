import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '../../lib/typert.remote-client.js'
import type { CreatorOpenOptions } from '@geekjourneyx/dsh-md2wechat/types'
import { creatorErrorInfo } from '../creator/errors.ts'
import { hydratePreviewHtml } from './preview-html.ts'
import type { CreatorClient } from './CreatorWorkspace.tsx'
import type { ArticlePanelClient } from './article-panel-model.ts'

/** One adapter for the panel and any future authenticated article surface. */
export function createCreatorClient(ctx: Context, sessionId: string, articleId: string): CreatorClient {
  const id = sessionId as SessionId
  const readBytes = async (path: string, sha256: string, signal: AbortSignal) => {
    const value = await remoteValue(() => ctx.remote.workspaceFiles.readBytes(id, path, {}, signal))
    signal.throwIfAborted()
    const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(value.data))
    const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    if (actual !== sha256) throw invalidArtifact()
    return value.data
  }
  return {
    get: signal => remoteValue(() => ctx.remote.md2wechat.get(id, articleId, signal)),
    dispatch: (version, action, signal) => remoteValue(() => ctx.remote.md2wechat.dispatch(id, articleId, version, action, signal)),
    async readImage(image, signal) { return dataUrl(await readBytes(image.path, image.sha256, signal), image.contentType) },
    async readPreview(preview, signal) {
      const bytes = await readBytes(preview.path, preview.sha256, signal)
      let html: string
      try { html = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw invalidArtifact() }
      const hydrated: Array<{ source: string; dataUrl: string }> = []
      for (const asset of preview.assets) hydrated.push({ source: asset.source, dataUrl: dataUrl(await readBytes(asset.path, asset.sha256, signal), asset.contentType) })
      return hydratePreviewHtml(html, hydrated)
    },
  }
}

/** Catalog and navigation are hints only; every Remote method authenticates the exact session. */
export function createArticlePanelClient(ctx: Context): ArticlePanelClient {
  return {
    async listSessions(signal) {
      signal.throwIfAborted()
      try { await ctx.sessions.refresh() } catch (error) { throw creatorErrorInfo(error) }
      signal.throwIfAborted()
      const list: SessionListState = ctx.sessions.list.getSnapshot()
      if (list.phase !== 'ready') throw creatorErrorInfo(new Error('[md2wechat:HOST_UNAVAILABLE]'))
      return list.ids.flatMap(id => {
        const item = list.byId[id]
        return item ? [{ sessionId: id, title: item.displayTitle || item.title || id, ...(item.cwd ? { workspaceLabel: item.cwd } : {}) }] : []
      })
    },
    retainSession(sessionId, signal) {
      const reference = ctx.sessions.retain(sessionId as SessionId, { source: 'mainView', signal })
      return { ready: reference.ready.then(() => undefined), release: () => reference.release() }
    },
    getArticles: (sessionId, signal) => remoteValue(() => ctx.remote.md2wechat.list(sessionId as SessionId, signal)),
    async open(sessionId, request, signal) {
      const options: CreatorOpenOptions = request.sourceChange ? { mode: request.sourceChange === 'continue-saved' ? 'continue' : 'import-new' } : {}
      const view = await remoteValue(() => ctx.remote.md2wechat.open(sessionId as SessionId, request.sourcePath, '', options, signal))
      return { articleId: view.articleId, title: view.title, sourcePath: request.sourcePath, updatedAt: '' }
    },
    async resume(sessionId, articleId, signal) {
      const view = await remoteValue(() => ctx.remote.md2wechat.resume(sessionId as SessionId, articleId, signal))
      return { articleId: view.articleId, title: view.title, sourcePath: '', updatedAt: '' }
    },
    discoverRevisions: (sessionId, signal) => remoteValue(() => ctx.remote.md2wechat.discoverRevisions(sessionId as SessionId, signal)),
    async recoverRevision(sessionId, manifestPath, signal) {
      const view = await remoteValue(() => ctx.remote.md2wechat.recoverRevision(sessionId as SessionId, manifestPath, signal))
      return { articleId: view.articleId, title: view.title, sourcePath: '', updatedAt: '' }
    },
    createWorkspaceClient: (sessionId, articleId) => createCreatorClient(ctx, sessionId, articleId),
  }
}

async function remoteValue<T>(operation: () => Promise<RemoteResult<T>>): Promise<T> {
  let result: RemoteResult<T>
  try { result = await operation() } catch (error) { throw creatorErrorInfo(error) }
  if (!result.ok) throw creatorErrorInfo(result.error)
  return result.value
}
function invalidArtifact() { return creatorErrorInfo(new Error('[md2wechat:ARTIFACT_INVALID]')) }
function dataUrl(bytes: Uint8Array, contentType: string): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  return `data:${contentType};base64,${btoa(binary)}`
}

/** Accept only finite typed client failures; never trust arbitrary Error.message text. */
export function clientErrorInfo(error: unknown) {
  const safe = creatorErrorInfo(error)
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const typed = creatorErrorInfo({ message: `[md2wechat:${error.code}]` })
    if (typed.code !== 'HOST_UNAVAILABLE' || error.code === 'HOST_UNAVAILABLE') return typed
  }
  return safe
}
