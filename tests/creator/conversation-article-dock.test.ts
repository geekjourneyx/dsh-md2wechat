// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationArticleCard } from '../../src/client/ConversationArticleCard.tsx'
import type { ArticlePanelClient } from '../../src/client/article-panel-model.ts'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: ReturnType<typeof createRoot>
afterEach(async () => { await act(async () => root?.unmount()); document.body.innerHTML = '' })
it('starts compact, opens the selected article, closes with Escape and resets on conversation changes', async () => {
 const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
 const onOpen = vi.fn()
 const client = {getArticles: vi.fn(async () => ['a','b'].map(articleId => ({articleId,title:`文章 ${articleId}`,sourcePath:'',updatedAt:'2026-10-24T00:00:00Z'})))} as unknown as ArticlePanelClient
 const render = (sessionId: string) => act(async () => root.render(createElement(ConversationArticleCard, {sessionId,running:false,client,onOpen})))
 await render('A')
 const toggle = () => container.querySelector('.md2-article-toggle') as HTMLButtonElement
 expect(toggle().getAttribute('aria-expanded')).toBe('false')
 expect(container.querySelector('select')).toBeNull()
 await act(async () => toggle().click())
 const select = container.querySelector('select')!
 await act(async () => { select.value='b'; select.dispatchEvent(new Event('change',{bubbles:true})) })
 await act(async () => (container.querySelector('.md2-open-article') as HTMLButtonElement).click())
 expect(onOpen).toHaveBeenCalledWith('A','b')
 expect(toggle().getAttribute('aria-expanded')).toBe('false')
 await act(async () => toggle().click())
 await act(async () => container.querySelector('select')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
 expect(toggle().getAttribute('aria-expanded')).toBe('false')
 expect(document.activeElement).toBe(toggle())
 await act(async () => toggle().click())
 await render('B')
 expect(toggle().getAttribute('aria-expanded')).toBe('false')
})
