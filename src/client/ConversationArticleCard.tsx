import { useEffect, useId, useRef, useState } from 'react'
import { WorkspaceIcon } from './WorkspaceIcon.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ArticlePanelArticle, ArticlePanelClient } from './article-panel-model.ts'

/** Resident above the composer, so completed tool calls need not be expanded to find the article. */
export function ConversationArticleCard({ sessionId, running, client, onOpen }: { sessionId: string; running: boolean; client: ArticlePanelClient; onOpen: (sessionId: string, articleId: string) => void }) {
 const [articles, setArticles] = useState<readonly ArticlePanelArticle[]>([])
 const [selected, setSelected] = useState('')
 const [expanded, setExpanded] = useState(false)
 const areaId = useId()
 const toggle = useRef<HTMLButtonElement>(null)
 useEffect(() => { setArticles([]); setSelected(''); setExpanded(false) }, [sessionId])
 useEffect(() => {
  const controller = new AbortController()
  void client.getArticles(sessionId, controller.signal).then(items => { if (!controller.signal.aborted) setArticles([...items].sort((a,b) => Date.parse(b.updatedAt)-Date.parse(a.updatedAt))) }).catch(() => {})
  return () => controller.abort()
 }, [client, sessionId, running])
 const article = articles.find(item => item.articleId === selected) ?? articles[0]
 if (!article) return null
 return <section className="md2-article-dock" aria-label="本对话文章" onKeyDown={event => { if (event.key === 'Escape' && expanded) { event.stopPropagation(); setExpanded(false); toggle.current?.focus() } }}>
  <button ref={toggle} className="md2-article-toggle" aria-label={expanded ? '收起文章操作' : '展开文章操作'} title="本对话文章" aria-expanded={expanded} aria-controls={areaId} onClick={() => setExpanded(value => !value)}><WorkspaceIcon name="article" /></button>
  {expanded && <div id={areaId} className="md2-article-actions">
   <div className="md2-article-selected"><span>本对话文章</span>{articles.length > 1 ? <select aria-label="选择本对话文章" value={article.articleId} onChange={event => setSelected(event.target.value)}>{articles.map(item => <option key={item.articleId} value={item.articleId}>{item.title || '未命名文章'}</option>)}</select> : <strong title={article.title}>{article.title || '未命名文章'}</strong>}</div>
   <button className="md2-open-article" onClick={() => { onOpen(sessionId, article.articleId); setExpanded(false); toggle.current?.focus() }}>打开文章<WorkspaceIcon name="open" /></button>
  </div>}
 </section>
}
