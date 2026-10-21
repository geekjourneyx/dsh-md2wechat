import { useEffect, useRef, useState } from 'react'
import type { CreatorAction, CreatorView, CreatorPreview, CreatorImageCandidate } from '@geekjourneyx/dsh-md2wechat/types'
import { ArticlePreview } from './ArticlePreview.tsx'
import { clientErrorInfo } from './creator-client.ts'

export interface CreatorClient {
  uploadImage?(file: File, signal: AbortSignal): Promise<{ sourcePath: string }>
  get(signal: AbortSignal): Promise<CreatorView>
  dispatch(version: number, action: CreatorAction, signal: AbortSignal): Promise<CreatorView>
  readImage?(image: CreatorImageCandidate, signal: AbortSignal): Promise<string>
  readPreview(preview: CreatorPreview, signal: AbortSignal): Promise<string>
}

/** Article-first native workspace. Operations are deterministic authenticated calls, not chat prompts. */
export function CreatorWorkspace({ client, onRecover }: { client: CreatorClient; onRecover?: () => void }) {
  const [view, setView] = useState<CreatorView>()
  const [html, setHtml] = useState('')
  const [displayedKey, setDisplayedKey] = useState('')
  const [previewReload, setPreviewReload] = useState(0)
  const [previous, setPrevious] = useState<{ html: string; theme: string }>()
  const [comparing, setComparing] = useState(false)
  const [error, setError] = useState('')
  const [errorInfo, setErrorInfo] = useState<ReturnType<typeof clientErrorInfo>>()
  const [confirmReconcile, setConfirmReconcile] = useState(false)
  const [panel, setPanel] = useState<'style' | 'suggestions' | 'images' | 'delivery' | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [confirmDraft, setConfirmDraft] = useState(false)
  const [imageKind, setImageKind] = useState<'cover' | 'body'>('cover')
  const [placement, setPlacement] = useState('')
  const [destination, setDestination] = useState('exports/article.html')
  const [busy, setBusy] = useState(false)
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
    latest.current = undefined; queuedTheme.current = undefined; themeRunning.current = false; actionSequence.current++; setView(undefined); setHtml(''); setDisplayedKey(''); setPrevious(undefined); setComparing(false); setError(''); setErrorInfo(undefined); setConfirmReconcile(false); setBusy(false); setPlacement(''); setConfirmDraft(false)
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
    if (view?.suggestionRequest?.status !== 'pending' && view?.imageRequest?.status !== 'pending' && view?.imageRequest?.status !== 'ready') return
    const controller = new AbortController()
    const timer = setInterval(() => { void client.get(controller.signal).then(next => { if (!controller.signal.aborted) accept(next) }).catch(() => {}) }, 1200)
    const timeout = setTimeout(() => clearInterval(timer), 120000)
    return () => { clearInterval(timer); clearTimeout(timeout); controller.abort() }
  }, [client, view?.suggestionRequest?.id, view?.suggestionRequest?.status, view?.imageRequest?.id, view?.imageRequest?.status])
  useEffect(() => { if (placement && view && !view.imagePlacements.some(item => item.id === placement)) setPlacement('') }, [view?.version, placement])
  async function act(action: CreatorAction) {
    const current = latest.current
    if (!current) return
    const controller = lifetime.current
    const sequence = ++actionSequence.current
    setBusy(true); setError(''); setErrorInfo(undefined); setConfirmReconcile(false); if (action.type !== 'create-draft') setConfirmDraft(false)
    try {
      let next = await client.dispatch(current.version, action, controller.signal)
      if (controller.signal.aborted) return
      accept(next)
      if (action.type === 'set-title' || action.type === 'select-theme' || action.type === 'apply-suggestion' || action.type === 'undo-edit' || action.type === 'place-image' || action.type === 'remove-image' || action.type === 'select-cover') {
        setComparing(false)
        if (html && displayedKey === previewKey(current) && current.preview.status === 'ready') setPrevious({ html, theme: current.theme })
        next = await client.dispatch(next.version, { type: 'refresh-preview' }, controller.signal)
        if (!controller.signal.aborted) accept(next)
      }
    } catch (error) { if (!controller.signal.aborted) fail(error) }
    finally { if (sequence === actionSequence.current) setBusy(false) }
  }
  async function uploadImage(file?: File) {
    if (!file || !client.uploadImage || busy) return
    if (file.size > 8*1024*1024 || !['image/png','image/jpeg','image/gif','image/webp'].includes(file.type)) { setError('请选择不超过 8 MiB 的 PNG、JPEG、GIF 或 WebP 图片。'); return }
    const controller = lifetime.current
    setBusy(true); setError('')
    try {
      const result = await client.uploadImage(file, controller.signal)
      if (!controller.signal.aborted) await act({ type: 'import-local-image', kind: imageKind, anchorId: placement, sourcePath: result.sourcePath, alt: file.name })
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
  const recoveryActions = <div className="md2-request-actions"><button type="button" disabled={busy} onClick={() => void reloadArticle()}>重新加载文章</button>{onRecover && errorInfo?.actions.some(action => action === 'open-source' || action === 'recover-revision') && <button type="button" onClick={onRecover}>选择原文恢复</button>}</div>
  if (!view) return <section className="md2-workspace" aria-label="文章工作区">{error ? <div className="md2-notice" role="alert"><p>{error}</p>{recoveryActions}</div> : <p role="status">正在打开文章…</p>}</section>
  return <section className="md2-workspace" aria-label="文章工作区">
    <header className="md2-header"><div><h2>{view.title}</h2><p>已保存 · {view.reviewed ? '当前版本已确认' : '修改后请检查效果'}</p></div>
      <button className="md2-primary" type="button" onClick={() => setPanel('delivery')}>保存到公众号草稿箱</button>
    </header>
    <nav className="md2-toolbar" aria-label="文章操作">{([['style', '排版'], ['suggestions', '标题与文字'], ['images', '配图']] as const).map(([key, label]) => <button key={key} aria-pressed={panel === key} onClick={() => { setPanel(panel === key ? null : key); if (key === 'suggestions') setTitleDraft(view.title) }}>{label}</button>)}<button disabled={busy} onClick={() => { setPanel(null); void act({ type: 'refresh-preview' }) }}>更新预览</button><button aria-pressed={panel === null} onClick={() => setPanel(null)}>专注阅读</button></nav>
    {view.recovery?.message && <div className="md2-notice" role="status">{view.recovery.message}</div>}
    {view.delivery?.status === 'unknown' && <div className="md2-notice" role="alert"><p>{view.delivery.message}</p><p>先到公众号后台核对素材或草稿。解除保护后可重新操作，不会自动重试上传或创建草稿；仍可导出本地 HTML。</p><label><input type="checkbox" aria-label="已核对公众号后台交付结果" checked={confirmReconcile} onChange={event => setConfirmReconcile(event.target.checked)} />我已到公众号后台核对交付结果，确认现在解除防重复保护</label><div className="md2-request-actions"><button type="button" disabled={busy || !confirmReconcile} onClick={() => void act({ type: 'reconcile-delivery', confirmed: confirmReconcile })}>确认已核对，解除保护</button></div></div>}
    {(error || view.preview.message) && <div className="md2-notice" role="alert">{error || view.preview.message}{error && recoveryActions}</div>}
    {(busy || view.preview.status === 'loading') && <p className="md2-status" role="status">正在更新… 如需授权，请在宿主中确认。</p>}
    {view.preview.status === 'stale' && <p className="md2-status" role="status">显示上一次预览，新的选择尚未完成排版。</p>}
    <div className={`md2-body ${panel ? 'md2-has-tool' : ''}`}>
      <main className="md2-reading">
        {previous && <button className="md2-compare" type="button" aria-pressed={comparing} onClick={() => setComparing(!comparing)}>{comparing ? '返回当前主题' : '对比上一主题'}</button>}
        {html ? <ArticlePreview html={comparing && previous ? previous.html : html} label={comparing && previous ? `上一主题：${previous.theme}` : `当前主题：${view.theme}`} />
          : <article className="md2-original"><span className="md2-eyebrow">原文 · 尚未排版</span><pre>{view.markdown}</pre><button disabled={busy} type="button" onClick={() => void act({ type: 'refresh-preview' })}>生成文章预览</button></article>}

      </main>
      <aside hidden={!panel} className="md2-controls" aria-label="文章调整">
        <button className="md2-close-tool" onClick={() => setPanel(null)}>关闭调整</button>
        <section hidden={panel !== 'style'} aria-label="排版风格"><h3>选择适合这篇文章的风格</h3><p>切换后查看真实排版效果，不改写正文。</p>
        <div className="md2-theme-grid">{view.themes.slice(0, 6).map(theme => <button key={theme.name} type="button" aria-pressed={view.theme === theme.name} onClick={() => void chooseTheme(theme.name)}><strong>{theme.name}</strong><span>{theme.description}</span></button>)}</div>
        <label className="md2-label">全部主题<select value={view.theme} onChange={event => void chooseTheme(event.target.value)}>{view.themes.map(theme => <option key={theme.name} value={theme.name}>{theme.name}</option>)}</select></label>
        <p className="md2-help">切换不满意？可继续比较，不会覆盖原文件。</p></section>
        <section hidden={panel !== 'suggestions'} aria-label="改进建议" className="md2-suggestions"><h3>标题与文字</h3><form onSubmit={event => { event.preventDefault(); void act({ type: 'set-title', title: titleDraft }) }}><label className="md2-label">文章标题（最多 32 字）<input aria-label="文章标题" maxLength={64} value={titleDraft} onChange={event => setTitleDraft(event.target.value)} /></label><button disabled={busy || !titleDraft.trim() || [...titleDraft.trim()].length > 32 || titleDraft.trim() === view.title}>使用这个标题</button></form><p>先看前后对比，再逐条应用。不自动改写整篇文章。</p>
          <div className="md2-request-actions"><button disabled={busy} onClick={() => void act({ type: 'request-suggestions', kind: 'layout' })}>检查阅读体验</button><button disabled={busy} onClick={() => void act({ type: 'request-suggestions', kind: 'title' })}>优化标题</button><button disabled={busy} onClick={() => void act({ type: 'request-suggestions', kind: 'polish' })}>轻量润色</button></div>
          {view.suggestionRequest?.status === 'pending' && <p role="status">正在请当前会话分析。你可以继续阅读，稍后在这里查看建议。</p>}
          {view.suggestionRequest?.status === 'error' && <p role="alert">建议准备失败，可重试。文章未更改。</p>}
          {view.suggestionRequest?.status === 'ready' && !view.suggestions.length && <p>没有待处理的建议。文章可以保持原样。</p>}
          {view.suggestions.map(change => <article className="md2-change" key={change.id}><h4>{change.title}</h4><p>{change.reason}</p><details open><summary>查看修改前后</summary><div className="md2-diff"><div><span>修改前</span><pre>{change.before}</pre></div><div><span>修改后</span><pre>{change.after}</pre></div></div></details><div className="md2-request-actions"><button disabled={busy} className="md2-primary" onClick={() => void act({ type: 'apply-suggestion', suggestionId: change.id })}>应用这条建议</button><button disabled={busy} onClick={() => void act({ type: 'dismiss-suggestion', suggestionId: change.id })}>保留原文</button></div></article>)}
          {view.canUndo && <button disabled={busy} onClick={() => void act({ type: 'undo-edit' })}>撤回上一次修改</button>}
        </section>
        <section hidden={panel !== 'images'} className="md2-images" aria-label="封面和正文图片"><h3>封面与正文配图</h3>{client.uploadImage && <label className="md2-upload">上传{imageKind === 'cover' ? '封面' : '正文图片'}<input aria-label="上传图片" type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={busy || (imageKind === 'body' && !placement)} onChange={event => { void uploadImage(event.target.files?.[0]); event.target.value = '' }} /></label>}<div className="md2-request-actions"><button aria-pressed={imageKind === 'cover'} onClick={() => setImageKind('cover')}>封面</button><button aria-pressed={imageKind === 'body'} onClick={() => setImageKind('body')}>正文配图</button></div><p>正文配图可以跳过，保存公众号草稿前需要选择封面。</p><button disabled={busy} onClick={() => void act({ type: 'request-images', kind: 'cover', anchorId: '' })}>准备 3 张封面候选</button>
          <div className="md2-image-grid">{view.imageCandidates.filter(image => image.kind === 'cover').map(image => <div className="md2-image-card" key={image.id}><CandidateImage image={image} client={client} /><button disabled={busy} aria-pressed={view.coverId === image.id} onClick={() => void act({ type: 'select-cover', candidateId: image.id })}>{view.coverId === image.id ? '已选作封面' : '选作封面'}</button></div>)}</div>
          {view.coverId && <button disabled={busy} onClick={() => void act({ type: 'select-cover', candidateId: '' })}>暂不使用封面</button>}
          <div className="md2-paragraphs" aria-label="正文配图位置"><p>选择要配图的段落</p>{view.imagePlacements.map(item => <button key={item.id} aria-pressed={placement === item.id} onClick={() => { setPlacement(item.id); setImageKind('body') }}>{item.context.slice(0, 120)}{item.hasImage ? '（已有图片）' : ''}</button>)}</div>
          <div className="md2-request-actions"><button disabled={busy || !placement} onClick={() => void act({ type: 'request-images', kind: 'body', anchorId: placement })}>为这个段落配图</button>{view.imagePlacements.find(item => item.id === placement)?.hasImage && <button disabled={busy} onClick={() => void act({ type: 'remove-image', anchorId: placement })}>移除这处图片</button>}</div>
          <div className="md2-image-grid">{view.imageCandidates.filter(image => image.kind === 'body').map(image => <div className="md2-image-card" key={image.id}><CandidateImage image={image} client={client} /><button disabled={busy || !placement} onClick={() => void act({ type: 'place-image', candidateId: image.id, anchorId: placement })}>放到所选段落</button></div>)}</div>
          {view.imageRequest?.status === 'pending' && <p role="status">正在请当前会话准备图片。完成后将显示候选，不会自动选用。</p>}

          <p className="md2-help">优先使用宿主图片能力。备用生图会同时上传全部候选到微信素材库，可能产生费用，需要另外确认。</p>
        </section>
        <section hidden={panel !== 'delivery'} className="md2-delivery" aria-label="交付文章"><h3>保存到公众号草稿箱</h3><p>公众号标题：<strong>{view.publicationTitle}</strong></p>{view.publicationTitle !== view.title && <p role="status">实际保存将使用上面的公众号标题，与文章名称不同。请核对后确认。</p>}<p>目标：当前配置公众号（名称未验证）。请在保存前核对账号。</p>{!view.draftEnabled && <p role="status">尚未开启公众号草稿功能。请先配置公众号连接；现在可以预览并导出文章。</p>}{!view.coverId && <button onClick={() => setPanel('images')}>先选择封面</button>}{view.draftEnabled && <div className="md2-draft-prepare"><h4>准备微信草稿</h4><p>第一步：准备所选封面和正文图片。这会上传到公众号，完成后请检查最终预览。</p><button disabled={busy || !view.coverId || view.preview.status !== 'ready' || view.delivery?.status === 'unknown'} onClick={() => void act({ type: 'prepare-delivery' })}>{view.preparedForDraft ? '重新准备微信素材' : '准备微信素材与最终预览'}</button>{view.preparedForDraft && <p role="status">第二步：最终预览已准备好。检查文章和标题后，确认当前版本。</p>}</div>}<button type="button" disabled={busy || comparing || view.preview.status !== 'ready' || displayedKey !== previewKey(view)} onClick={() => void act({ type: 'review-current', previewPath: view.preview.path, previewSha256: view.preview.sha256, publicationTitle: view.publicationTitle })}>{view.reviewed ? '已审阅当前版本' : '审阅当前版本'}</button><p>只有当前预览审阅后才能导出。导出内容与真实预览一致，不会发布文章。</p><label className="md2-label">HTML 保存位置<input value={destination} onChange={event => setDestination(event.target.value)} placeholder="exports/article.html" /></label><button className="md2-primary" disabled={busy || !view.reviewed || view.preview.status !== 'ready' || !destination.trim()} onClick={() => void act({ type: 'export-html', destination })}>导出已审阅 HTML</button>{view.draftEnabled && view.preparedForDraft && <div className="md2-draft-confirm"><label><input type="checkbox" checked={confirmDraft} onChange={event => setConfirmDraft(event.target.checked)} />我已核对目标公众号和当前文章，确认保存为未发布的草稿</label><button className="md2-primary" disabled={busy || !view.reviewed || !confirmDraft || view.delivery?.status === 'unknown'} onClick={() => void act({ type: 'create-draft', confirmed: confirmDraft })}>确认保存到草稿箱</button></div>}{view.delivery && <p role="status">{view.delivery.message}<br /><span>{view.delivery.path}</span></p>}</section>
      </aside>
    </div>
  </section>
}

function CandidateImage({ image, client }: { image: CreatorImageCandidate; client: CreatorClient }) {
  const [source, setSource] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setSource('')
    void client.readImage?.(image, controller.signal).then(value => { if (!controller.signal.aborted) setSource(value) }).catch(() => {})
    return () => controller.abort()
  }, [client, image.path, image.sha256])
  return source ? <img src={source} alt={image.alt} /> : <span role="status">图片预览暂不可用</span>
}

function previewKey(view: CreatorView): string { return [view.articleId, view.version, view.preview.path, view.preview.sha256].join('\0') }
