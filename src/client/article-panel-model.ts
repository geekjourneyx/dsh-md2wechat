import type { CreatorClient } from './CreatorWorkspace.tsx'

/** The integration registers this id in main and sidebar.panellist. */
export const PANEL_ID = 'md2wechat-articles'

export interface ArticlePanelSession {
  sessionId: string
  title: string
  workspaceLabel?: string
}

/** Display data only. Neither a catalog entry nor a navigation target grants access. */
export interface ArticlePanelArticle {
  articleId: string
  title: string
  sourcePath: string
  updatedAt: string
  revisionId?: string
}

export interface ArticlePanelRevision { revisionId: string; manifestPath: string; title: string; createdAt: string }

export interface ArticlePanelOpenRequest {
  sourcePath: string
  sourceChange?: 'continue-saved' | 'reimport'
}

/** Adapts the host's explicitly owned SessionReference, without exposing its binding. */
export interface ArticlePanelSessionReference {
  readonly ready: Promise<void>
  release(): void
}

/** All article methods must recheck the authenticated session on the server. */
export interface ArticlePanelClient {
  listSessions(signal: AbortSignal): Promise<readonly ArticlePanelSession[]>
  retainSession(sessionId: string, signal: AbortSignal): ArticlePanelSessionReference
  getArticles(sessionId: string, signal: AbortSignal): Promise<readonly ArticlePanelArticle[]>
  open(sessionId: string, request: ArticlePanelOpenRequest, signal: AbortSignal): Promise<ArticlePanelArticle>
  resume(sessionId: string, articleId: string, signal: AbortSignal): Promise<ArticlePanelArticle>
  discoverRevisions(sessionId: string, signal: AbortSignal): Promise<readonly ArticlePanelRevision[]>
  recoverRevision(sessionId: string, manifestPath: string, signal: AbortSignal): Promise<ArticlePanelArticle>
  createWorkspaceClient(sessionId: string, articleId: string): CreatorClient
}

export interface ArticlePanelSelection {
  readonly sessionId: string
  readonly articleId: string
  /** Changes even when reopening the same target, so a failed restore can be retried. */
  readonly sequence: number
}

export interface ArticlePanelNavigation {
  getSnapshot(): ArticlePanelSelection
  subscribe(listener: () => void): () => void
  selectSession(sessionId: string): void
  openArticle(sessionId: string, articleId: string): void
  clearArticle(): void
}

/** Own this at plugin lifetime, outside React. Store no article bytes, leases or authority. */
export function createArticlePanelNavigation(): ArticlePanelNavigation {
  let selection: ArticlePanelSelection = Object.freeze({ sessionId: '', articleId: '', sequence: 0 })
  const listeners = new Set<() => void>()
  function select(sessionId: string, articleId: string) {
    selection = Object.freeze({ sessionId, articleId, sequence: selection.sequence + 1 })
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => selection,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    selectSession: sessionId => select(sessionId, ''),
    openArticle: (sessionId, articleId) => select(sessionId, articleId),
    clearArticle: () => select(selection.sessionId, ''),
  }
}

export interface ArticlePanelFailure { code: string; message: string }
type FailureContext = 'sessions' | 'session' | 'articles' | 'open' | 'resume' | 'revisions' | 'recover'

/** Never render transport messages: they may contain paths, credentials or diagnostics. */
export function describeArticlePanelFailure(error: unknown, context: FailureContext): ArticlePanelFailure {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : ''
  switch (code) {
    case 'SOURCE_CHANGED': return { code, message: '源文件已变化。请选择继续已保存版本，或将当前文件重新导入为新文章；不会覆盖已保存进度。' }
    case 'FORBIDDEN': case 'PERMISSION_DENIED': return { code, message: '当前会话没有读取这篇文章的权限。请检查会话权限，或选择有权访问的会话后重试。' }
    case 'UNAUTHORIZED': case 'AUTH_REQUIRED': return { code, message: '会话认证已失效。请在宿主重新连接或登录后重试。' }
    case 'RECOVERY_REQUIRED': return { code, message: '这个旧入口需要恢复。请选择已保存版本，或重新打开 Markdown；无法找回从未保存的历史进度或授权。' }
    case 'ARTIFACT_INVALID': return { code, message: '已保存版本或引用文件缺失、变化或无效。请检查文件，或重新打开 Markdown；不会覆盖原文件。' }
    case 'VERSION_CONFLICT': return { code, message: '文章或预览已经更新。请刷新并重新检查最新版本后再操作。' }
    case 'ARTICLE_NOT_FOUND': case 'DOCUMENT_NOT_FOUND': return { code, message: '未找到这篇已保存文章。请从本会话的文章列表选择，或重新打开 Markdown；不会自动新建替代文章。' }
    case 'SESSION_NOT_FOUND': case 'SESSION_UNAVAILABLE': return { code, message: '所选会话暂不可用。请确认会话仍存在，或重新选择会话。' }
    case 'SOURCE_NOT_FOUND': case 'FILE_NOT_FOUND': return { code, message: '没有找到这个 Markdown 文件。请检查相对于所选会话工作目录的路径后重试。' }
    case 'RECORD_INVALID': case 'DOCUMENT_INVALID': return { code, message: '已保存记录无法读取。原文件不会被覆盖；请重新打开 Markdown，或检查文章保存目录。' }
    case 'STORAGE_ERROR': case 'SAVE_FAILED': return { code, message: '文章未能保存。请检查磁盘空间与目录写入权限后重试，已有文章不会被替换。' }
    default: return { code: 'UNKNOWN', message: {
      sessions: '会话列表读取失败。请检查宿主连接后重试。',
      session: '所选会话连接失败。请检查宿主连接或重新选择会话。',
      articles: '已保存文章读取失败。请检查当前会话连接与目录权限后重试。',
      open: 'Markdown 未能打开。请检查文件路径、会话权限与宿主连接后重试。',
      resume: '文章恢复未完成。请重试恢复，或重新打开 Markdown；不会自动覆盖已保存文章。',
      revisions: '已保存版本读取失败。请检查当前会话连接与目录权限后重试。',
      recover: '所选版本未能恢复。请检查版本文件和会话权限，或选择其他版本；原文件不会被覆盖。',
    }[context] }
  }
}
