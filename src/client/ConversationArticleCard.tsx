import { useEffect, useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ArticlePanelArticle, ArticlePanelClient } from './article-panel-model.ts'

/** Resident above the composer, so completed tool calls need not be expanded to find the article. */
export function ConversationArticleCard({ sessionId, running, client, onOpen }: { sessionId: string; running: boolean; client: ArticlePanelClient; onOpen: (sessionId: string, articleId: string) => void }) {
 const [articles, setArticles] = useState<readonly ArticlePanelArticle[]>([])
 const [selected, setSelected] = useState('')
 useEffect(() => { setArticles([]); setSelected('') }, [sessionId])
 useEffect(() => {
  const controller = new AbortController()
  void client.getArticles(sessionId, controller.signal).then(items => { if (!controller.signal.aborted) setArticles([...items].sort((a,b) => Date.parse(b.updatedAt)-Date.parse(a.updatedAt))) }).catch(() => {})
  return () => controller.abort()
 }, [client, sessionId, running])
 const article = articles.find(item => item.articleId === selected) ?? articles[0]
 if (!article) return null
 return <section className="md2-chat-card" aria-label="本对话文章"><div><span>文章</span><strong>{article.title || '未命名文章'}</strong><small>排版 · 标题 · 配图 · 保存草稿</small></div>{articles.length > 1 && <select aria-label="选择本对话文章" value={article.articleId} onChange={event => setSelected(event.target.value)}>{articles.map(item => <option key={item.articleId} value={item.articleId}>{item.title}</option>)}</select>}<button onClick={() => onOpen(sessionId, article.articleId)}>预览与调整</button></section>
}
