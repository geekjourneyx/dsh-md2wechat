import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ArticlePanelClient, ArticlePanelNavigation } from './article-panel-model.ts'
import { CreatorWorkspace } from './CreatorWorkspace.tsx'

/** The conversation card owns the exact session/article pair; opening it never changes chat. */
export function ConversationArticle({ client, navigation }: { client: ArticlePanelClient; navigation: ArticlePanelNavigation }) {
 const selection = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
 const { sessionId, articleId } = selection
 const [ready, setReady] = useState('')
 const [error, setError] = useState(false)
 const workspace = useMemo(() => articleId ? client.createWorkspaceClient(sessionId, articleId) : undefined, [client, sessionId, articleId])
 useEffect(() => {
  if (!articleId) return
  const controller = new AbortController()
  const ref = client.retainSession(sessionId, controller.signal)
  setReady(''); setError(false)
  void ref.ready.then(() => client.resume(sessionId, articleId, controller.signal)).then(() => { if (!controller.signal.aborted) setReady(articleId) }).catch(() => { if (!controller.signal.aborted) setError(true) })
  return () => { controller.abort(); ref.release() }
 }, [client, sessionId, articleId])
 if (!articleId || !workspace) return null
 return <section className="md2-native-article md2-article-panel" role="region" aria-label="对话中的文章">
  
  {error ? <p role="alert">文章暂时无法打开。请收起后重试，或在对话里让助手重新打开这篇文章。</p> : ready === articleId ? <CreatorWorkspace client={workspace} /> : <p role="status">正在打开文章…</p>}
 </section>
}
