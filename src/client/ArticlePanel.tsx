import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CreatorWorkspace } from './CreatorWorkspace.tsx'
import type { CreatorClient } from './CreatorWorkspace.tsx'
import { describeArticlePanelFailure } from './article-panel-model.ts'
import type { ArticlePanelArticle, ArticlePanelClient, ArticlePanelFailure, ArticlePanelNavigation, ArticlePanelOpenRequest, ArticlePanelRevision, ArticlePanelSession, ArticlePanelSessionReference } from './article-panel-model.ts'

interface ArticlePanelProps { client: ArticlePanelClient; navigation: ArticlePanelNavigation }
interface SessionState { client: ArticlePanelClient; sessionId: string; status: 'loading' | 'ready' | 'error'; error?: ArticlePanelFailure }
interface ArticleListState { sessionId: string; status: 'loading' | 'ready' | 'error'; articles: readonly ArticlePanelArticle[]; error?: ArticlePanelFailure }
interface RestoreState { sequence: number; status: 'loading' | 'ready' | 'error'; workspaceClient?: CreatorClient; error?: ArticlePanelFailure }
interface LegacyState { sequence: number; status: 'loading' | 'ready' | 'recovering' | 'error'; candidates: readonly ArticlePanelRevision[]; selectedPath: string; error?: ArticlePanelFailure }
interface OpenState { sequence: number; sourcePath: string; status: 'loading' | 'error'; error?: ArticlePanelFailure }

/** A global main panel whose selected session is explicit, retained and never inferred from chat. */
export function ArticlePanel({ client, navigation }: ArticlePanelProps) {
  const selection = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
  const [sessions, setSessions] = useState<readonly ArticlePanelSession[]>([])
  const [directoryStatus, setDirectoryStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [directoryError, setDirectoryError] = useState<ArticlePanelFailure>()
  const [directoryRetry, setDirectoryRetry] = useState(0)
  const [sessionRetry, setSessionRetry] = useState(0)
  const [sessionState, setSessionState] = useState<SessionState>()
  const [articles, setArticles] = useState<ArticleListState>()
  const [listRetry, setListRetry] = useState(0)
  const [restore, setRestore] = useState<RestoreState>()
  const [source, setSource] = useState('')
  const [opening, setOpening] = useState<OpenState>()
  const openController = useRef<AbortController>()
  const legacyController = useRef<AbortController>()
  const [legacy, setLegacy] = useState<LegacyState>()
  const { sessionId, articleId, sequence } = selection
  const sessionReady = sessionState?.client === client && sessionState.sessionId === sessionId && sessionState.status === 'ready'

  useEffect(() => {
    const controller = new AbortController()
    setDirectoryStatus('loading'); setDirectoryError(undefined)
    void Promise.resolve().then(() => client.listSessions(controller.signal)).then(result => {
      if (!controller.signal.aborted) { setSessions(result); setDirectoryStatus('ready') }
    }).catch(error => {
      if (!controller.signal.aborted) { setDirectoryStatus('error'); setDirectoryError(describeArticlePanelFailure(error, 'sessions')) }
    })
    return () => controller.abort()
  }, [client, directoryRetry])

  useEffect(() => {
    if (!sessionId) { setSessionState(undefined); return }
    const controller = new AbortController()
    let reference: ArticlePanelSessionReference | undefined
    let released = false
    const release = () => { if (reference && !released) { released = true; reference.release() } }
    setSessionState({ client, sessionId, status: 'loading' })
    try {
      reference = client.retainSession(sessionId, controller.signal)
      void reference.ready.then(() => {
        if (!controller.signal.aborted) setSessionState({ client, sessionId, status: 'ready' })
      }).catch(error => {
        release()
        if (!controller.signal.aborted) setSessionState({ client, sessionId, status: 'error', error: describeArticlePanelFailure(error, 'session') })
      })
    } catch (error) {
      release()
      setSessionState({ client, sessionId, status: 'error', error: describeArticlePanelFailure(error, 'session') })
    }
    return () => { controller.abort(); release() }
  }, [client, sessionId, sessionRetry])

  useEffect(() => {
    if (!sessionId || !sessionReady) return
    const controller = new AbortController()
    setArticles({ sessionId, status: 'loading', articles: [] })
    void Promise.resolve().then(() => client.getArticles(sessionId, controller.signal)).then(result => {
      if (!controller.signal.aborted) setArticles({ sessionId, status: 'ready', articles: [...result].sort((a, b) => savedTime(b.updatedAt) - savedTime(a.updatedAt)) })
    }).catch(error => {
      if (!controller.signal.aborted) setArticles({ sessionId, status: 'error', articles: [], error: describeArticlePanelFailure(error, 'articles') })
    })
    return () => controller.abort()
  }, [client, sessionId, sessionReady, listRetry, sequence])

  useEffect(() => {
    if (!sessionReady || !articleId) return
    const controller = new AbortController()
    setRestore({ sequence, status: 'loading' })
    void Promise.resolve().then(() => client.resume(sessionId, articleId, controller.signal)).then(result => {
      if (controller.signal.aborted || navigation.getSnapshot().sequence !== sequence) return
      // A corrupt or misrouted response must not silently select a replacement article.
      if (result.articleId !== articleId) throw { code: 'ARTICLE_NOT_FOUND' }
      setRestore({ sequence, status: 'ready', workspaceClient: client.createWorkspaceClient(sessionId, articleId) })
    }).catch(error => {
      if (!controller.signal.aborted && navigation.getSnapshot().sequence === sequence) setRestore({ sequence, status: 'error', error: describeArticlePanelFailure(error, 'resume') })
    })
    return () => controller.abort()
  }, [client, navigation, sessionId, articleId, sequence, sessionReady])

  useEffect(() => {
    setSource(''); setOpening(undefined); setLegacy(undefined)
    return () => { openController.current?.abort(); legacyController.current?.abort() }
  }, [client, sessionId, sequence])

  async function openMarkdown(request: ArticlePanelOpenRequest) {
    if (!sessionReady || !request.sourcePath.trim()) return
    openController.current?.abort()
    const controller = new AbortController(); openController.current = controller
    setOpening({ sequence, sourcePath: request.sourcePath, status: 'loading' })
    try {
      const result = await client.open(sessionId, request, controller.signal)
      if (controller.signal.aborted || navigation.getSnapshot().sequence !== sequence) return
      if (!result.articleId) throw { code: 'ARTICLE_NOT_FOUND' }
      setListRetry(value => value + 1)
      navigation.openArticle(sessionId, result.articleId)
    } catch (error) {
      if (!controller.signal.aborted && navigation.getSnapshot().sequence === sequence) setOpening({ sequence, sourcePath: request.sourcePath, status: 'error', error: describeArticlePanelFailure(error, 'open') })
    }
  }

  async function discoverLegacyRevisions() {
    if (!sessionReady) return
    legacyController.current?.abort()
    const controller = new AbortController(); legacyController.current = controller
    setLegacy({ sequence, status: 'loading', candidates: [], selectedPath: '' })
    try {
      const candidates = await client.discoverRevisions(sessionId, controller.signal)
      if (!controller.signal.aborted && navigation.getSnapshot().sequence === sequence) setLegacy({ sequence, status: 'ready', candidates: candidates.slice(0, 100), selectedPath: '' })
    } catch (error) {
      if (!controller.signal.aborted && navigation.getSnapshot().sequence === sequence) setLegacy({ sequence, status: 'error', candidates: [], selectedPath: '', error: describeArticlePanelFailure(error, 'revisions') })
    }
  }
  async function recoverLegacyRevision() {
    const candidate = legacy?.sequence === sequence ? legacy.candidates.find(item => item.manifestPath === legacy.selectedPath) : undefined
    if (!sessionReady || !candidate) return
    legacyController.current?.abort()
    const controller = new AbortController(); legacyController.current = controller
    setLegacy(current => current ? { sequence: current.sequence, status: 'recovering', candidates: current.candidates, selectedPath: current.selectedPath } : current)
    try {
      const result = await client.recoverRevision(sessionId, candidate.manifestPath, controller.signal)
      if (controller.signal.aborted || navigation.getSnapshot().sequence !== sequence) return
      if (!result.articleId) throw { code: 'ARTICLE_NOT_FOUND' }
      navigation.openArticle(sessionId, result.articleId)
    } catch (error) {
      if (!controller.signal.aborted && navigation.getSnapshot().sequence === sequence) setLegacy(current => current ? { ...current, status: 'error', error: describeArticlePanelFailure(error, 'recover') } : current)
    }
  }

  const currentSession = sessions.find(item => item.sessionId === sessionId)
  const currentArticles = sessionReady && articles?.sessionId === sessionId ? articles : undefined
  const currentRestore = restore?.sequence === sequence ? restore : undefined
  const currentOpen = opening?.sequence === sequence ? opening : undefined
  const recent = currentArticles?.articles[0]
  const openBusy = currentOpen?.status === 'loading'
  const currentLegacy = legacy?.sequence === sequence ? legacy : undefined
  const legacyBusy = currentLegacy?.status === 'loading' || currentLegacy?.status === 'recovering'

  return <main className="md2-article-panel" aria-label="文章主工作区">
    <header className="md2-article-header">
      <div><span className="md2-article-eyebrow">MD2WECHAT · 文章</span><h1>文章工作区</h1><p>从已保存的进度继续，不必翻找聊天中的工具调用。</p></div>
      <label className="md2-article-session-label">工作会话<select aria-label="选择会话" value={sessionId} onChange={event => navigation.selectSession(event.target.value)}>
        <option value="">选择会话…</option>
        {sessionId && !currentSession && <option value={sessionId}>指定会话 · {sessionId}</option>}
        {sessions.map(item => <option key={item.sessionId} value={item.sessionId}>{item.title || item.sessionId}{item.workspaceLabel ? ` · ${item.workspaceLabel}` : ''}</option>)}
      </select><button type="button" disabled={directoryStatus === 'loading'} onClick={() => setDirectoryRetry(value => value + 1)}>刷新会话列表</button></label>
    </header>
    {directoryStatus === 'loading' && <p className="md2-article-status" role="status">正在读取会话列表…</p>}
    {directoryStatus === 'error' && <div className="md2-article-notice" role="alert"><p>{directoryError?.message}</p><button type="button" onClick={() => setDirectoryRetry(value => value + 1)}>重试读取会话</button></div>}
    {!sessionId ? <section className="md2-article-welcome"><div className="md2-article-document-icon" aria-hidden="true">文</div><h2>先选择会话，再开始创作</h2><p>文章按会话保存。选择上方会话后，可以继续已保存文章，或打开这个会话目录中的 Markdown。</p><p className="md2-article-muted">不会自动创建会话、读取其他工作区，或发起模型请求。</p>{directoryStatus === 'ready' && !sessions.length && <p>还没有可选会话。请先在宿主中打开一个会话，再刷新上方的会话列表。</p>}</section>
      : <div className="md2-article-layout">
        <aside className="md2-article-library" aria-label="本会话文章">
          <div className="md2-article-library-heading"><h2>本会话文章</h2><button type="button" className="md2-article-quiet" disabled={!sessionReady || currentArticles?.status === 'loading'} onClick={() => setListRetry(value => value + 1)}>刷新列表</button></div>
          <p className="md2-article-muted md2-article-session-caption">{currentSession?.title || '指定会话'}{currentSession?.workspaceLabel && <span>{currentSession.workspaceLabel}</span>}</p>
          {sessionState?.sessionId === sessionId && sessionState.status === 'error' && <div className="md2-article-notice" role="alert"><p>{sessionState.error?.message}</p><button type="button" onClick={() => setSessionRetry(value => value + 1)}>重试连接会话</button></div>}
          {!sessionReady && sessionState?.status !== 'error' && <p role="status">正在连接所选会话…</p>}
          {sessionReady && (!currentArticles || currentArticles.status === 'loading') && <p role="status">正在读取已保存文章…</p>}
          {currentArticles?.status === 'error' && <div className="md2-article-notice" role="alert"><p>{currentArticles.error?.message}</p><button type="button" onClick={() => setListRetry(value => value + 1)}>重试读取文章</button></div>}
          {recent && <button className="md2-article-primary md2-article-continue" type="button" onClick={() => navigation.openArticle(sessionId, recent.articleId)}>继续最近文章</button>}
          {currentArticles?.status === 'ready' && !currentArticles.articles.length && <p className="md2-article-empty-list">这个会话还没有已保存文章。打开 Markdown 后，可从这里继续。</p>}
          {!!currentArticles?.articles.length && <ul className="md2-article-list">{currentArticles.articles.map(item => <li key={item.articleId}><button type="button" aria-current={articleId === item.articleId ? 'page' : undefined} onClick={() => navigation.openArticle(sessionId, item.articleId)}><strong>{item.title || '未命名文章'}</strong><span>{item.sourcePath}</span><time dateTime={item.updatedAt}>保存于 {displayTime(item.updatedAt)}</time></button></li>)}</ul>}
          {sessionReady && <form className="md2-article-open-form" onSubmit={event => { event.preventDefault(); void openMarkdown({ sourcePath: source.trim() }) }}>
            <h3>打开 Markdown</h3><label>会话目录中的文件路径<input aria-label="Markdown 路径" value={source} onChange={event => setSource(event.target.value)} placeholder="articles/example.md" autoComplete="off" spellCheck={false} /></label><p className="md2-article-muted">重复打开会继续同一篇文章。源文件变化时，由你选择如何处理。</p><button type="submit" disabled={!source.trim() || openBusy}>打开 Markdown</button>
            {openBusy && <p role="status">正在打开 Markdown…</p>}
            {currentOpen?.status === 'error' && <div className="md2-article-notice" role="alert"><p>{currentOpen.error?.message}</p>{currentOpen.error?.code === 'SOURCE_CHANGED' ? <div className="md2-article-error-actions"><button type="button" onClick={() => void openMarkdown({ sourcePath: currentOpen.sourcePath, sourceChange: 'continue-saved' })}>继续已保存版本</button><button type="button" onClick={() => void openMarkdown({ sourcePath: currentOpen.sourcePath, sourceChange: 'reimport' })}>重新导入为新文章</button></div> : <button type="button" onClick={() => void openMarkdown({ sourcePath: currentOpen.sourcePath })}>重试打开 Markdown</button>}</div>}
          </form>}
          {sessionReady && <section className="md2-article-legacy" aria-label="恢复已保存版本"><h3>恢复旧文章</h3><p className="md2-article-muted">旧入口失效？只在你点击后列出本会话目录已有的版本，不跨工作区查找。</p><button type="button" disabled={legacyBusy || openBusy} onClick={() => void discoverLegacyRevisions()}>选择已保存版本</button>
            {currentLegacy?.status === 'loading' && <p role="status">正在读取已保存版本…</p>}
            {currentLegacy && currentLegacy.status !== 'loading' && !!currentLegacy.candidates.length && <div className="md2-article-legacy-chooser"><label>明确选择一个已有版本<select aria-label="选择已保存文章版本" disabled={legacyBusy} value={currentLegacy.selectedPath} onChange={event => { const selectedPath = event.target.value; setLegacy(current => current ? { ...current, selectedPath } : current) }}><option value="">选择版本…</option>{currentLegacy.candidates.map(item => <option key={item.manifestPath} value={item.manifestPath}>{item.title || '未命名文章'} · {item.revisionId} · {displayTime(item.createdAt)}</option>)}</select></label><p className="md2-article-muted">会创建新文章记录，不覆盖原文或旧版本。无法找回从未保存的主题、候选与撤回记录，历史审阅和授权不会恢复。</p><button type="button" disabled={legacyBusy || openBusy || !currentLegacy.selectedPath} onClick={() => void recoverLegacyRevision()}>恢复所选版本</button></div>}
            {currentLegacy?.status === 'ready' && !currentLegacy.candidates.length && <p role="status">没有找到可恢复的已保存版本。你仍可在上方重新打开 Markdown；未保存的历史进度无法找回。</p>}
            {currentLegacy?.status === 'recovering' && <p role="status">正在校验并恢复所选版本…</p>}
            {currentLegacy?.error && <div className="md2-article-notice" role="alert"><p>{currentLegacy.error.message}</p></div>}
          </section>}
        </aside>
        <section className="md2-article-content" aria-label="当前文章">
          {articleId && sessionReady ? <>
            <div className="md2-article-restore-note"><p>已保存不等于已审阅。恢复后请重新检查预览；不会恢复未完成请求或历史授权。</p><button type="button" onClick={() => navigation.clearArticle()}>返回文章列表</button></div>
            {currentRestore?.status === 'error' ? <div className="md2-article-restore-error md2-article-notice" role="alert"><h2>文章暂未恢复</h2><p>{currentRestore.error?.message}</p><button type="button" onClick={() => navigation.openArticle(sessionId, articleId)}>重试恢复文章</button></div>
              : currentRestore?.status === 'ready' && currentRestore.workspaceClient ? <div className="md2-article-workspace"><CreatorWorkspace key={`${sessionId}:${articleId}:${sequence}`} client={currentRestore.workspaceClient} onRecover={() => navigation.clearArticle()} /></div>
                : <div className="md2-article-content-empty" role="status"><h2>正在恢复文章…</h2><p>正在读取此会话已保存的正文和选择，不会自动生成内容或上传素材。</p></div>}
          </> : <div className="md2-article-content-empty"><span className="md2-article-eyebrow">保存的文章，随时继续</span><h2>{sessionReady ? '选择一篇文章，继续创作' : '文章只属于你选定的会话'}</h2><p>{sessionReady ? '从列表选择文章，或打开 Markdown。正文、主题和已保存候选会保留，交付前仍需审阅当前版本。' : '连接后才能读取文章。切换会话不会把另一会话的文章带过来。'}</p></div>}
        </section>
      </div>}
  </main>
}

function savedTime(value: string): number { const time = Date.parse(value); return Number.isFinite(time) ? time : 0 }
function displayTime(value: string): string { return savedTime(value) ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '时间未知' }
