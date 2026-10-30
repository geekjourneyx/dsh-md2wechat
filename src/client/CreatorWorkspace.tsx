import { useEffect, useRef, useState } from 'react'
import type { CreatorAction, CreatorView, CreatorPreview, CreatorImageCandidate } from '@geekjourneyx/dsh-md2wechat/types'
import { ArticlePreview } from './ArticlePreview.tsx'
import { WorkspaceIcon } from './WorkspaceIcon.tsx'
import { clientErrorInfo } from './creator-client.ts'

export interface CreatorClient {
  uploadImage?(file: File, signal: AbortSignal): Promise<{ sourcePath: string }>
  get(signal: AbortSignal): Promise<CreatorView>
  dispatch(version: number, action: CreatorAction, signal: AbortSignal): Promise<CreatorView>
  readImage?(image: CreatorImageCandidate, signal: AbortSignal): Promise<string>
  readPreview(preview: CreatorPreview, signal: AbortSignal): Promise<string>
}

/** Article-first native workspace. Operations are deterministic authenticated calls, not chat prompts. */
export function CreatorWorkspace({ client, onRecover, readOnly = false }: { client: CreatorClient; onRecover?: () => void; readOnly?: boolean }) {
  const [view, setView] = useState<CreatorView>()
  const [html, setHtml] = useState('')
  const [displayedKey, setDisplayedKey] = useState('')
  const [previewReload, setPreviewReload] = useState(0)
  const [previous, setPrevious] = useState<{ html: string; theme: string }>()
  const [comparing, setComparing] = useState(false)
  const [error, setError] = useState('')
  const [errorInfo, setErrorInfo] = useState<ReturnType<typeof clientErrorInfo>>()
  const [confirmReconcile, setConfirmReconcile] = useState(false)
  const [panel, setPanel] = useState<'suggestions' | 'images' | 'delivery' | null>(null)
  const surface = useRef<HTMLElement>(null)
  const coverArea = useRef<HTMLDivElement>(null)
  const deliveryArea = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingBody, setEditingBody] = useState(false)
  const [paragraphEdit, setParagraphEdit] = useState<{ before: string; after: string; version: number }>()
  const [titleVersion, setTitleVersion] = useState(0)
  const [titleDraft, setTitleDraft] = useState('')
  const [confirmDraft, setConfirmDraft] = useState(false)
  const [imageKind, setImageKind] = useState<'cover' | 'body'>('cover')
  const [placement, setPlacement] = useState('')
  const [destination, setDestination] = useState('exports/article.html')
  const [busy, setBusy] = useState(false)
  const [activity, setActivity] = useState('正在读取文章…')
  const [waitingLong, setWaitingLong] = useState(false)
  const lifetime = useRef(new AbortController())
  const latest = useRef<CreatorView>()
  const actionSequence = useRef(0)
  const queuedTheme = useRef<string>()
  const themeRunning = useRef(false)
  const accept = (next: CreatorView) => {
    if (!latest.current || next.version >= latest.current.version) { latest.current = next; setView(next) }
  }
  function fail(error: unknown) { const info = clientErrorInfo(error); setError(info.message); setErrorInfo(info) }
  async function reloadArticle() {
    const controller = lifetime.current; const sequence = ++actionSequence.current
    setBusy(true); setError(''); setErrorInfo(undefined)
    try { const next = await client.get(controller.signal); if (!controller.signal.aborted) { accept(next); setPreviewReload(value => value + 1) } }
    catch (error) { if (!controller.signal.aborted) fail(error) }
    finally { if (!controller.signal.aborted && sequence === actionSequence.current) setBusy(false) }
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller
    latest.current = undefined; queuedTheme.current = undefined; themeRunning.current = false; actionSequence.current++; setView(undefined); setHtml(''); setDisplayedKey(''); setPrevious(undefined); setComparing(false); setError(''); setErrorInfo(undefined); setConfirmReconcile(false); setBusy(false); setPlacement(''); setConfirmDraft(false); setEditingTitle(false); setEditingBody(false); setParagraphEdit(undefined); setPanel(null); setExpanded(false)
    void client.get(controller.signal).then(next => { if (!controller.signal.aborted) accept(next) }).catch(error => { if (!controller.signal.aborted) fail(error) })
    return () => controller.abort()
  }, [client])
  useEffect(() => {
    setDisplayedKey('')
    if (!view?.preview.path) return
    const key = previewKey(view)
    const controller = new AbortController()
    void client.readPreview(view.preview, controller.signal).then(value => { if (!controller.signal.aborted) { setHtml(value); setDisplayedKey(key) } })
      .catch(() => { if (!controller.signal.aborted) setError('预览读取失败，请重新生成预览。') })
    return () => controller.abort()
  }, [client, view?.articleId, view?.version, view?.preview.path, view?.preview.sha256, previewReload])
  useEffect(() => {
    if (view?.suggestionRequest?.status !== 'pending' && view?.imageRequest?.status !== 'pending') return
    const controller = new AbortController()
    setWaitingLong(false)
    const timer = setInterval(() => { void client.get(controller.signal).then(next => { if (!controller.signal.aborted) accept(next) }).catch(() => {}) }, 1200)
    const timeout = setTimeout(() => setWaitingLong(true), 120000)
    return () => { clearInterval(timer); clearTimeout(timeout); controller.abort() }
  }, [client, view?.suggestionRequest?.id, view?.suggestionRequest?.status, view?.imageRequest?.id, view?.imageRequest?.status])
  useEffect(() => { if (placement && view && !view.imagePlacements.some(item => item.id === placement)) setPlacement('') }, [view?.version, placement])
  async function act(action: CreatorAction, expectedVersion?: number): Promise<boolean> {
    const current = latest.current
    if (!current) return false
    const controller = lifetime.current
    const sequence = ++actionSequence.current
    setActivity(action.type === 'request-images' || action.type === 'request-suggestions' ? '正在将创作请求交给当前对话…' : action.type === 'prepare-delivery' ? '正在准备所选图片和最终预览…' : action.type === 'create-draft' ? '正在保存公众号草稿，请勿重复提交…' : action.type === 'check-article' ? '正在检查文章和发布条件…' : action.type === 'refresh-preview' ? '正在生成排版预览…' : '正在应用修改…')
    setBusy(true); setError(''); setErrorInfo(undefined); setConfirmReconcile(false); if (action.type !== 'create-draft') setConfirmDraft(false)
    try {
      let next = await client.dispatch(expectedVersion ?? current.version, action, controller.signal)
      if (controller.signal.aborted) return false
      accept(next)
      if (action.type === 'edit-text') setParagraphEdit(undefined)
      if (action.type === 'set-title') setEditingTitle(false)
      if (action.type === 'edit-text' || action.type === 'set-title' || action.type === 'select-theme' || action.type === 'apply-suggestion' || action.type === 'undo-edit' || action.type === 'place-image' || action.type === 'remove-image') {
        setComparing(false)
        if (html && displayedKey === previewKey(current) && current.preview.status === 'ready') setPrevious({ html, theme: current.theme })
        setActivity('正在生成排版预览…')
        next = await client.dispatch(next.version, { type: 'refresh-preview' }, controller.signal)
        if (!controller.signal.aborted) accept(next)
      }
      return true
    } catch (error) { if (!controller.signal.aborted) fail(error); return false }
    finally { if (sequence === actionSequence.current) setBusy(false) }
  }
  async function uploadImage(file?: File, kind: 'cover' | 'body' = imageKind) {
    if (!file || !client.uploadImage || busy) return
    if (file.size > 8*1024*1024 || !['image/png','image/jpeg','image/gif','image/webp'].includes(file.type)) { setError('请选择不超过 8 MiB 的 PNG、JPEG、GIF 或 WebP 图片。'); return }
    const controller = lifetime.current
    setBusy(true); setError('')
    try {
      const result = await client.uploadImage(file, controller.signal)
      if (!controller.signal.aborted) await act({ type: 'import-local-image', kind, anchorId: kind === 'body' ? placement : '', sourcePath: result.sourcePath, alt: file.name })
    } catch (error) { if (!controller.signal.aborted) fail(error) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  async function chooseTheme(theme: string) {
    queuedTheme.current = theme
    if (themeRunning.current) return
    themeRunning.current = true
    const controller = lifetime.current
    try {
      while (queuedTheme.current && !controller.signal.aborted) {
        const next = queuedTheme.current; queuedTheme.current = undefined
        await act({ type: 'select-theme', theme: next })
      }
    } finally { if (lifetime.current === controller) themeRunning.current = false }
  }
  async function openDelivery() {
    if (paragraphEdit || editingTitle) { setError('请先保存或取消正在编辑的内容，再存为草稿。'); return }
    setEditingBody(false)
    setPanel('delivery')
    if (latest.current?.delivery?.status !== 'unknown') await act({ type: 'check-article' })
    deliveryArea.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
  const recoveryActions = <div className="md2-request-actions"><button type="button" disabled={busy} onClick={() => void reloadArticle()}>重新加载文章</button>{onRecover && errorInfo?.actions.some(action => action === 'open-source' || action === 'recover-revision') && <button type="button" onClick={onRecover}>选择原文恢复</button>}</div>
  if (!view) return <section className="md2-workspace" aria-label="文章工作区">{error ? <div className="md2-notice" role="alert"><p>{error}</p>{recoveryActions}</div> : <p role="status">正在打开文章…</p>}</section>
  const selectedCover = view.imageCandidates.find(image => image.id === view.coverId)
  if (readOnly) return <section className="md2-workspace md2-inline-workspace" aria-label="历史文章预览">
    <div className="md2-reading"><div className="md2-article-canvas">
      <div className="md2-message-section"><div className="md2-section-heading">已保存的消息卡片</div>
        <div className={`md2-message-card md2-history-card ${selectedCover ? '' : 'md2-no-cover'}`}>
          {selectedCover && <CandidateImage image={selectedCover} client={client} />}
          <h2 className="md2-card-title">{view.publicationTitle || view.title}</h2>
        </div>
      </div>
      <div className="md2-body-section">
        {error && <p role="alert">{error}</p>}
        {html && displayedKey === previewKey(view) ? <><p className="md2-help">已保存的排版{view.preview.status !== 'ready' ? ' · 可能与最新正文不同，请回原对话更新' : ''}</p><ArticlePreview html={html} label="历史文章排版" /></> : <><p className="md2-help">暂无可读取的排版，以下为已保存正文。更新排版请回到原对话。</p><div className="md2-original"><pre>{view.markdown}</pre></div></>}
      </div>
    </div></div>
  </section>
  const coverRequest = view.imageRequest?.kind === 'cover' ? view.imageRequest : null
  const batchIds = coverRequest?.candidateIds
  const covers = view.imageCandidates.filter(image => image.kind === 'cover')
  const currentCovers = batchIds ? covers.filter(image => batchIds.includes(image.id)) : covers.slice(-3)
  const olderCovers = batchIds ? covers.filter(image => !batchIds.includes(image.id)) : covers.slice(0, -3)
  const editing = editingTitle || !!paragraphEdit
  const imagePending = view.imageRequest?.status === 'pending'
  const paragraphForm = paragraphEdit ? <form onSubmit={event => { event.preventDefault(); void act({ type: 'edit-text', before: paragraphEdit.before, after: paragraphEdit.after }, paragraphEdit.version) }}><label className="md2-label">修改这一段<textarea autoFocus aria-label="段落内容" value={paragraphEdit.after} onChange={event => setParagraphEdit({ ...paragraphEdit, after: event.target.value })} /></label><div className="md2-edit-footer"><button disabled={busy} type="button" onClick={() => setParagraphEdit(undefined)}>取消修改</button><button className="md2-primary" disabled={busy || paragraphEdit.before === paragraphEdit.after}>保存这一段</button></div></form> : null
  return <section ref={surface} className={`md2-workspace md2-inline-workspace ${expanded ? 'md2-expanded' : ''}`} aria-label="文章工作区">
    <header className="md2-header"><div className="md2-document-label"><strong>文章</strong><span>{editing ? '编辑中 · 尚未保存' : busy ? '处理中' : '已保存'}</span></div>
      <div className="md2-header-actions">
        <button className="md2-icon" aria-label="撤回上一次修改" title="撤回上一次修改" disabled={busy || editing || !view.canUndo} onClick={() => void act({ type: 'undo-edit' })}><WorkspaceIcon name="undo" /></button>
        <button className="md2-icon" aria-label="更新预览" title="更新排版" disabled={busy || editing} onClick={() => void act({ type: 'refresh-preview' })}><WorkspaceIcon name="refresh" /></button>
        <button className="md2-icon" aria-label={expanded ? '收起文章' : '展开文章'} title={expanded ? '收起文章' : '展开文章'} onClick={() => setExpanded(!expanded)}><WorkspaceIcon name={expanded ? 'collapse' : 'expand'} /></button>
        <button className="md2-primary" type="button" disabled={busy || editing} onClick={() => void openDelivery()}>存为草稿</button>
      </div>
    </header>
    {view.recovery?.message && <details className="md2-recovery"><summary>已恢复上次保存的文章</summary><p>{view.recovery.message}</p></details>}
    {view.delivery?.status === 'unknown' && <div className="md2-notice" role="alert"><p>{view.delivery.message}</p><p>请先到公众号后台核对上次结果，避免重复保存。</p><label><input type="checkbox" aria-label="已核对公众号后台交付结果" checked={confirmReconcile} onChange={event => setConfirmReconcile(event.target.checked)} />我已到公众号后台核对交付结果，确认现在解除防重复保护</label><button disabled={busy || !confirmReconcile} onClick={() => void act({ type: 'reconcile-delivery', confirmed: confirmReconcile })}>确认已核对，解除保护</button></div>}
    {(error || view.preview.message) && <div className="md2-notice" role="alert">{error || view.preview.message}{error && recoveryActions}</div>}
    {(busy || view.preview.status === 'loading') && <p className="md2-status" role="status">{activity}</p>}
    {waitingLong && (view.suggestionRequest?.status === 'pending' || imagePending) && <p className="md2-status" role="status">当前对话仍在处理，已有结果会保留。<button disabled={busy} onClick={() => void reloadArticle()}>查看最新结果</button></p>}
    <div className="md2-reading"><div className="md2-article-canvas">
      <div ref={coverArea} className="md2-message-section">
        <div className="md2-section-heading"><span>消息卡片</span><div className="md2-inline-actions">
          <button disabled={busy || editing} onClick={() => { setEditingTitle(true); setTitleDraft(view.title); setTitleVersion(view.version); setPanel(null) }}><WorkspaceIcon name="edit" />编辑标题</button>
          <button disabled={busy || editing || view.suggestionRequest?.status === 'pending'} onClick={() => { setPanel('suggestions'); void act({ type: 'request-suggestions', kind: 'title' }) }}><WorkspaceIcon name="magic" />换个标题</button>
          <button aria-expanded={panel === 'images'} disabled={editing} onClick={() => { setPanel(panel === 'images' ? null : 'images'); setImageKind('cover') }}><WorkspaceIcon name="image" />更换封面</button>
        </div></div>
        <div className={`md2-message-card ${selectedCover ? '' : 'md2-no-cover'}`}>
          {selectedCover && <CandidateImage image={selectedCover} client={client} />}
          {!selectedCover && <button className="md2-cover-empty" disabled={editing} onClick={() => setPanel('images')}><WorkspaceIcon name="image" /><span>为文章选择一张封面</span></button>}
          <button className="md2-card-title" disabled={busy || editing} title="点击修改标题" onClick={() => { setEditingTitle(true); setTitleDraft(view.title); setTitleVersion(view.version) }}>{view.title}</button>
        </div>
        {editingTitle && <form className="md2-title-edit" onSubmit={event => { event.preventDefault(); void act({ type: 'set-title', title: titleDraft }, titleVersion) }}>
          <label className="md2-label">文章标题<input autoFocus aria-label="文章标题" value={titleDraft} onChange={event => setTitleDraft(event.target.value)} /></label>
          <div className="md2-edit-footer"><span>{[...titleDraft.trim()].length}/32 字</span><button type="button" disabled={busy} onClick={() => setEditingTitle(false)}>取消</button><button className="md2-primary" disabled={busy || !titleDraft.trim() || [...titleDraft.trim()].length > 32 || titleDraft.trim() === view.title}>保存标题</button></div>
        </form>}
        <section hidden={panel !== 'suggestions'} aria-label={view.suggestionRequest?.kind === 'layout' ? '高级排版建议' : view.suggestionRequest?.kind === 'polish' ? '文字建议' : '标题建议'} className="md2-inline-results">
          <div className="md2-section-heading"><strong>{view.suggestionRequest?.kind === 'layout' ? '高级排版建议' : view.suggestionRequest?.kind === 'polish' ? '文字建议' : '标题建议'}</strong><button className="md2-icon" aria-label="收起建议" onClick={() => setPanel(null)}><WorkspaceIcon name="up" /></button></div>
          {view.suggestionRequest?.status === 'pending' && <p role="status">正在请当前对话准备建议，原标题会保留。</p>}
          {view.suggestionRequest?.status === 'error' && <p role="alert">建议准备失败，请重试。文章未更改。</p>}
          {view.suggestionRequest?.status === 'ready' && !view.suggestions.length && <p>没有待处理的建议，可以保留原文。</p>}
          {view.suggestions.map(change => <article className="md2-change" key={change.id}><strong>{change.after.replace(/^#\s+/u, '')}</strong><p>{change.reason}</p><details><summary>查看修改前后</summary><div className="md2-diff"><pre>{change.before}</pre><pre>{change.after}</pre></div></details><div className="md2-request-actions"><button disabled={busy || editing} onClick={() => void act({ type: 'apply-suggestion', suggestionId: change.id })}>应用这条建议</button><button disabled={busy} onClick={() => void act({ type: 'dismiss-suggestion', suggestionId: change.id })}>保留原文</button></div></article>)}
        </section>
        <section hidden={panel !== 'images'} aria-label="选择封面" className="md2-inline-results">
          <div className="md2-section-heading"><strong>选择封面</strong><span role="status">{coverRequest ? `${coverRequest.completed ?? currentCovers.length}/${coverRequest.expected ?? 3} ${coverRequest.status === 'ready' ? '已完成' : coverRequest.status === 'error' ? '生成未完成' : '正在生成'}` : '从候选中选择'}</span><div className="md2-inline-actions"><button disabled={busy || (imagePending && !waitingLong) || editing} onClick={() => void act({ type: 'request-images', kind: 'cover', anchorId: '' })}><WorkspaceIcon name="magic" />{covers.length ? '再生成三张' : '生成三张封面'}</button><button className="md2-icon" aria-label="收起封面选择" onClick={() => setPanel(null)}><WorkspaceIcon name="up" /></button></div></div>
          <div className="md2-cover-grid">{currentCovers.map(image => <button className="md2-cover-choice" key={image.id} aria-label={`选作封面：${image.alt}`} aria-pressed={view.coverId === image.id} disabled={busy || editing || imagePending} onClick={() => void act({ type: 'select-cover', candidateId: image.id })}><CandidateImage image={image} client={client} />{view.coverId === image.id && <span className="md2-selected"><WorkspaceIcon name="check" /></span>}<span className="md2-choice-caption">{image.alt}</span></button>)}{coverRequest?.status === 'pending' && Array.from({ length: Math.max(0, (coverRequest.expected ?? 3) - currentCovers.length) }, (_, index) => <div className="md2-cover-wait" key={index}><span>正在准备</span></div>)}</div>
          {coverRequest?.status === 'error' && <p role="alert">本轮未全部完成。已返回的图片仍可选用，也可以重新生成。</p>}
          {olderCovers.length > 0 && <details><summary>之前的封面（{olderCovers.length}）</summary><div className="md2-cover-grid">{olderCovers.map(image => <button className="md2-cover-choice" aria-label={`选作封面：${image.alt}`} aria-pressed={view.coverId === image.id} disabled={busy || editing || imagePending} key={image.id} onClick={() => void act({ type: 'select-cover', candidateId: image.id })}><CandidateImage image={image} client={client} /><span className="md2-choice-caption">{image.alt}</span></button>)}</div></details>}
          <div className="md2-cover-footer"><span>{selectedCover ? '已选用 · 仅作封面，不插入正文' : '选择后用于公众号消息卡片'}</span>{client.uploadImage && <label className="md2-upload">上传封面<input aria-label="上传封面" type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={busy || editing} onChange={event => { setImageKind('cover'); void uploadImage(event.target.files?.[0], 'cover'); event.target.value = '' }} /></label>}</div>
        </section>
      </div>
      <div className="md2-body-section">
        <div className="md2-section-heading"><span>{editingBody ? '编辑正文' : '正文阅读效果'}</span><div className="md2-inline-actions"><label className="md2-theme-select"><span aria-hidden="true">Aa</span><select aria-label="排版主题" value={view.theme} disabled={editing} onChange={event => void chooseTheme(event.target.value)}>{view.themes.map(theme => <option key={theme.name} value={theme.name}>{theme.description || theme.name}</option>)}</select></label><button disabled={busy || editing} aria-pressed={editingBody} onClick={() => { setEditingBody(!editingBody); setComparing(false) }}><WorkspaceIcon name="edit" />{editingBody ? '查看效果' : '编辑正文'}</button></div></div>
        {view.preview.status === 'stale' && <p className="md2-status" role="status">显示上一次排版，请更新预览后再保存草稿。</p>}
        {previous && !editingBody && <button className="md2-compare" aria-pressed={comparing} onClick={() => setComparing(!comparing)}>{comparing ? '返回当前主题' : '对比上一主题'}</button>}
        {editingBody ? <div className="md2-text-editor"><h2>{view.title}</h2><p className="md2-help">点击段落修改，保存后更新排版。复杂图文和代码块保持原样。</p>{paragraphEdit && !view.imagePlacements.some(item => item.context === paragraphEdit.before) && <div className="md2-edit-paragraph"><p role="alert">这段原文已更新。你的输入仍保留，请复制后取消并重新选择段落。</p>{paragraphForm}</div>}{view.imagePlacements.length ? view.imagePlacements.map(item => <div className="md2-edit-paragraph" key={item.id}>{paragraphEdit?.before === item.context ? paragraphForm : <button disabled={busy || editing} className="md2-paragraph-button" onClick={() => setParagraphEdit({ before: item.context, after: item.context, version: view.version })}><span>{item.context}</span><WorkspaceIcon name="edit" /></button>}</div>) : <p>这篇文章暂无可直接编辑的普通段落，请在当前对话中修改正文。</p>}</div>
          : html ? <ArticlePreview html={comparing && previous ? previous.html : html} label={comparing && previous ? `上一主题：${previous.theme}` : `当前主题：${view.theme}`} />
          : <article className="md2-original"><h2>{view.title}</h2><pre>{view.markdown.replace(/^# [^\n]*\n?/u, '')}</pre><button disabled={busy || editing} onClick={() => void act({ type: 'refresh-preview' })}>生成文章预览</button></article>}
        <details className="md2-secondary"><summary>正文配图与文字建议</summary><div className="md2-request-actions"><button disabled={busy || editing} onClick={() => { setPanel('suggestions'); void act({ type: 'request-suggestions', kind: 'polish' }); coverArea.current?.scrollIntoView({ block: 'start' }) }}>请助手润色</button><button disabled={busy || editing} onClick={() => { setPanel('suggestions'); void act({ type: 'request-suggestions', kind: 'layout' }); coverArea.current?.scrollIntoView({ block: 'start' }) }}>高级排版</button></div><p className="md2-help">高级排版会按文章内容选择模块，整篇最多 8 个；确认建议后才应用。</p><label className="md2-label">选择配图段落<select aria-label="选择配图段落" value={placement} onChange={event => { setPlacement(event.target.value); setImageKind('body') }}><option value="">请选择段落</option>{view.imagePlacements.map(item => <option key={item.id} value={item.id}>{item.context.slice(0, 55)}</option>)}</select></label><div className="md2-request-actions"><button disabled={busy || editing || imagePending || !placement} onClick={() => void act({ type: 'request-images', kind: 'body', anchorId: placement })}>为这个段落配图</button>{view.imagePlacements.find(item => item.id === placement)?.hasImage && <button disabled={busy || editing} onClick={() => void act({ type: 'remove-image', anchorId: placement })}>移除这处图片</button>}{client.uploadImage && <label className="md2-upload">上传正文图片<input aria-label="上传正文图片" type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={busy || editing || !placement} onChange={event => { void uploadImage(event.target.files?.[0], 'body'); event.target.value = '' }} /></label>}</div>{view.imageRequest?.kind === 'body' && <p role="status">{view.imageRequest.status === 'pending' ? '正文配图正在准备' : view.imageRequest.status === 'error' ? '配图未完成，可重试' : '正文配图已返回'}</p>}<div className="md2-cover-grid">{view.imageCandidates.filter(image => image.kind === 'body').map(image => <div className="md2-image-card" key={image.id}><CandidateImage image={image} client={client} /><button disabled={busy || editing || !placement} onClick={() => void act({ type: 'place-image', candidateId: image.id, anchorId: placement })}>放到所选段落</button></div>)}</div></details>
      </div>
      <div ref={deliveryArea}>
        <section hidden={panel !== 'delivery'} className="md2-delivery" aria-label="交付文章"><h3>保存到公众号草稿箱</h3><button disabled={busy || editing || editingBody} onClick={() => void act({ type: 'check-article' })}>检查发布条件</button>{view.inspection && <div role="status"><p>{view.inspection.ready ? '文章内容检查通过，保存时还会验证公众号连接。' : '检查发现以下待处理事项：'}</p><ul>{view.inspection.checks.map((check, index) => <li key={index}>{check.level === 'error' ? '需要处理：' : '提示：'}{check.message}</li>)}</ul></div>}<ul aria-label="保存前检查" className="md2-checklist"><li>{view.markdown.trim() ? '✓ 正文已准备' : '需要补充正文'}</li><li>{view.publicationTitle.trim() && [...view.publicationTitle.trim()].length <= 32 ? '✓ 标题长度符合要求' : '需要修改标题（1–32 字）'}</li><li>{view.coverId ? '✓ 已选择封面' : '尚未选择封面'}</li><li>{view.preview.status === 'ready' ? '✓ 当前排版已生成' : '需要更新预览'}{view.preview.status !== 'ready' && <button disabled={busy || editing || editingBody} onClick={() => void act({ type: 'refresh-preview' })}>生成最新预览</button>}</li><li>{view.draftEnabled ? '✓ 草稿功能已开启，连接将在保存时验证' : '需要配置公众号连接'}</li><li>{view.delivery?.status === 'unknown' ? '上次保存结果待核对，暂不能再次提交' : '保存前还会检查图片和当前文章是否有效'}</li></ul><p>公众号标题：<strong>{view.publicationTitle}</strong></p>{view.publicationTitle !== view.title && <p role="status">实际保存将使用上面的公众号标题，与文章名称不同。请核对后确认。</p>}<p>目标：当前配置公众号（名称未验证）。请在保存前核对账号。</p>{!view.draftEnabled && <p role="status">尚未开启公众号草稿功能。请先配置公众号连接；现在可以预览并导出文章。</p>}{!view.coverId && <button onClick={() => { setPanel('images'); coverArea.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }}>先选择封面</button>}{view.draftEnabled && <div className="md2-draft-prepare"><h4>准备微信草稿</h4><p>第一步：准备所选封面和正文图片。这会上传到公众号，完成后请检查最终预览。</p><button disabled={busy || editing || editingBody || !view.coverId || view.preview.status !== 'ready' || view.delivery?.status === 'unknown'} onClick={() => void act({ type: 'prepare-delivery' })}>{view.preparedForDraft ? '重新准备微信素材' : '准备微信素材与最终预览'}</button>{view.preparedForDraft && <p role="status">第二步：最终预览已准备好。检查文章和标题后，确认当前版本。</p>}</div>}<button type="button" disabled={busy || editing || editingBody || comparing || view.preview.status !== 'ready' || displayedKey !== previewKey(view)} onClick={() => void act({ type: 'review-current', previewPath: view.preview.path, previewSha256: view.preview.sha256, publicationTitle: view.publicationTitle })}>{view.reviewed ? '已审阅当前版本' : '审阅当前版本'}</button><p>只有当前预览审阅后才能导出。导出内容与真实预览一致，不会发布文章。</p><label className="md2-label">HTML 保存位置<input value={destination} onChange={event => setDestination(event.target.value)} placeholder="exports/article.html" /></label><button className="md2-primary" disabled={busy || editing || editingBody || !view.reviewed || view.preview.status !== 'ready' || !destination.trim()} onClick={() => void act({ type: 'export-html', destination })}>导出已审阅 HTML</button>{view.draftEnabled && view.preparedForDraft && <div className="md2-draft-confirm"><label><input type="checkbox" checked={confirmDraft} onChange={event => setConfirmDraft(event.target.checked)} />我已核对目标公众号和当前文章，确认保存为未发布的草稿</label><button className="md2-primary" disabled={busy || editing || editingBody || !view.reviewed || !confirmDraft || view.delivery?.status === 'unknown'} onClick={() => void act({ type: 'create-draft', confirmed: confirmDraft })}>确认保存到草稿箱</button></div>}{view.delivery && <p role="status">{view.delivery.message}<br /><span>{view.delivery.path}</span></p>}</section>
      </div>
    </div></div>
  </section>
}

function CandidateImage({ image, client }: { image: CreatorImageCandidate; client: CreatorClient }) {
  const [source, setSource] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController(); setSource(''); setFailed(false)
    if (!client.readImage) { setFailed(true); return }
    void client.readImage(image, controller.signal).then(value => { if (!controller.signal.aborted) setSource(value) }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [client, image.path, image.sha256])
  return source ? <img src={source} alt={image.alt} /> : <span className="md2-image-unavailable" role="status">{failed ? '图片读取失败，请重新加载文章' : '正在读取图片…'}</span>
}
function previewKey(view: CreatorView): string { return [view.articleId, view.version, view.preview.path, view.preview.sha256].join('\0') }
