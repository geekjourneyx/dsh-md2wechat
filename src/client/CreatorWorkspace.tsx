import { useEffect, useRef, useState } from 'react'
import type { CreatorAction, CreatorView, CreatorPreview } from '@geekjourneyx/dsh-md2wechat/types'
import { ArticlePreview } from './ArticlePreview.tsx'

export interface CreatorClient {
  get(signal: AbortSignal): Promise<CreatorView>
  dispatch(version: number, action: CreatorAction, signal: AbortSignal): Promise<CreatorView>
  readPreview(preview: CreatorPreview, signal: AbortSignal): Promise<string>
}

/** Article-first native workspace. Operations are deterministic authenticated calls, not chat prompts. */
export function CreatorWorkspace({ client }: { client: CreatorClient }) {
  const [view, setView] = useState<CreatorView>()
  const [html, setHtml] = useState('')
  const [previous, setPrevious] = useState<{ html: string; theme: string }>()
  const [comparing, setComparing] = useState(false)
  const [error, setError] = useState('')
  const [destination, setDestination] = useState('exports/article.html')
  const [busy, setBusy] = useState(false)
  const lifetime = useRef(new AbortController())
  const latest = useRef<CreatorView>()
  const actionSequence = useRef(0)
  const accept = (next: CreatorView) => {
    if (!latest.current || next.version >= latest.current.version) { latest.current = next; setView(next) }
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller
    void client.get(controller.signal).then(accept).catch(() => { if (!controller.signal.aborted) setError('无法打开文章工作区，请重新打开原文。') })
    return () => controller.abort()
  }, [client])
  useEffect(() => {
    if (!view?.preview.path) return
    const controller = new AbortController()
    void client.readPreview(view.preview, controller.signal).then(value => { if (!controller.signal.aborted) setHtml(value) })
      .catch(() => { if (!controller.signal.aborted) setError('预览读取失败，请重新生成预览。') })
    return () => controller.abort()
  }, [client, view?.preview.path, view?.preview.sha256])
  useEffect(() => {
    if (view?.suggestionRequest?.status !== 'pending') return
    const controller = new AbortController()
    const timer = setInterval(() => { void client.get(controller.signal).then(accept).catch(() => {}) }, 1200)
    return () => { clearInterval(timer); controller.abort() }
  }, [client, view?.suggestionRequest?.id, view?.suggestionRequest?.status])
  async function act(action: CreatorAction) {
    const current = latest.current
    if (!current) return
    const sequence = ++actionSequence.current
    setBusy(true); setError('')
    try {
      let next = await client.dispatch(current.version, action, lifetime.current.signal)
      if (lifetime.current.signal.aborted) return
      accept(next)
      if (action.type === 'select-theme' || action.type === 'apply-suggestion' || action.type === 'undo-edit') {
        if (html && current.preview.status === 'ready') setPrevious({ html, theme: current.theme })
        next = await client.dispatch(next.version, { type: 'refresh-preview' }, lifetime.current.signal)
        if (!lifetime.current.signal.aborted) accept(next)
      }
    } catch { if (!lifetime.current.signal.aborted) setError('操作未完成。请刷新工作区后重试，原文未更改。') }
    finally { if (sequence === actionSequence.current) setBusy(false) }
  }
  if (!view) return <section className="md2-workspace" aria-label="文章工作区"><p role="status">{error || '正在打开文章…'}</p></section>
  return <section className="md2-workspace" aria-label="文章工作区">
    <header className="md2-header"><div><span className="md2-eyebrow">微信公众号 · 创作工作区</span><h2>{view.title}</h2><p>原文保持不变。先看效果，再决定如何调整。</p></div>
      <div className="md2-header-actions"><button type="button" disabled={busy} onClick={() => void act({ type: 'refresh-preview' })}>更新预览</button><button className="md2-primary" type="button" disabled={busy || view.preview.status !== 'ready'} onClick={() => void act({ type: 'review-current' })}>{view.reviewed ? '已审阅当前版本' : '审阅当前版本'}</button></div>
    </header>
    {(error || view.preview.message) && <div className="md2-notice" role="alert">{error || view.preview.message}</div>}
    {(busy || view.preview.status === 'loading') && <p className="md2-status" role="status">正在更新… 如需授权，请在宿主中确认。</p>}
    {view.preview.status === 'stale' && <p className="md2-status" role="status">显示上一次预览，新的选择尚未完成排版。</p>}
    <div className="md2-body">
      <main className="md2-reading">
        {previous && <button className="md2-compare" type="button" aria-pressed={comparing} onClick={() => setComparing(!comparing)}>{comparing ? '返回当前主题' : '对比上一主题'}</button>}
        {html ? <ArticlePreview html={comparing && previous ? previous.html : html} label={comparing && previous ? `上一主题：${previous.theme}` : `当前主题：${view.theme}`} />
          : <div className="md2-empty"><h3>看看文章排版后的样子</h3><p>使用真实排版引擎生成预览。若未配置排版服务，可先保留原文，配置后再继续。</p><button className="md2-primary" disabled={busy} type="button" onClick={() => void act({ type: 'refresh-preview' })}>生成文章预览</button></div>}
      </main>
      <aside className="md2-controls" aria-label="文章调整">
        <h3>选择适合这篇文章的风格</h3><p>切换后查看真实排版效果，不改写正文。</p>
        <div className="md2-theme-grid">{view.themes.slice(0, 6).map(theme => <button key={theme.name} type="button" aria-pressed={view.theme === theme.name} onClick={() => void act({ type: 'select-theme', theme: theme.name })}><strong>{theme.name}</strong><span>{theme.description}</span></button>)}</div>
        <label className="md2-label">全部主题<select value={view.theme} onChange={event => void act({ type: 'select-theme', theme: event.target.value })}>{view.themes.map(theme => <option key={theme.name} value={theme.name}>{theme.name}</option>)}</select></label>
        <p className="md2-help">切换不满意？可继续比较，不会覆盖原文件。</p>
        <section aria-label="改进建议" className="md2-suggestions"><h3>只改真正值得改的地方</h3><p>先看前后对比，再逐条应用。不自动改写整篇文章。</p>
          <div className="md2-request-actions"><button disabled={busy || view.suggestionRequest?.status === 'pending'} onClick={() => void act({ type: 'request-suggestions', kind: 'layout' })}>检查阅读体验</button><button disabled={busy || view.suggestionRequest?.status === 'pending'} onClick={() => void act({ type: 'request-suggestions', kind: 'title' })}>优化标题</button><button disabled={busy || view.suggestionRequest?.status === 'pending'} onClick={() => void act({ type: 'request-suggestions', kind: 'polish' })}>轻量润色</button></div>
          {view.suggestionRequest?.status === 'pending' && <p role="status">正在请当前会话分析。你可以继续阅读，稍后在这里查看建议。</p>}
          {view.suggestionRequest?.status === 'error' && <p role="alert">建议准备失败，可重试。文章未更改。</p>}
          {view.suggestionRequest?.status === 'ready' && !view.suggestions.length && <p>没有待处理的建议。文章可以保持原样。</p>}
          {view.suggestions.map(change => <article className="md2-change" key={change.id}><h4>{change.title}</h4><p>{change.reason}</p><details open><summary>查看修改前后</summary><div className="md2-diff"><div><span>修改前</span><pre>{change.before}</pre></div><div><span>修改后</span><pre>{change.after}</pre></div></div></details><div className="md2-request-actions"><button disabled={busy} className="md2-primary" onClick={() => void act({ type: 'apply-suggestion', suggestionId: change.id })}>应用这条建议</button><button disabled={busy} onClick={() => void act({ type: 'dismiss-suggestion', suggestionId: change.id })}>保留原文</button></div></article>)}
          {view.canUndo && <button disabled={busy} onClick={() => void act({ type: 'undo-edit' })}>撤回上一次修改</button>}
        </section>
        <section className="md2-delivery" aria-label="交付文章"><h3>带走审阅后的文章</h3><p>只有当前预览审阅后才能导出。导出内容与真实预览一致，不会发布文章。</p><label className="md2-label">HTML 保存位置<input value={destination} onChange={event => setDestination(event.target.value)} placeholder="exports/article.html" /></label><button className="md2-primary" disabled={busy || !view.reviewed || view.preview.status !== 'ready' || !destination.trim()} onClick={() => void act({ type: 'export-html', destination })}>导出已审阅 HTML</button>{view.delivery && <p role="status">{view.delivery.message}<br /><span>{view.delivery.path}</span></p>}</section>
      </aside>
    </div>
  </section>
}
