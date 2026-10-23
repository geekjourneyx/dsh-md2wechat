// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ConversationArticleCard } from '../../src/client/ConversationArticleCard.tsx'
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
let dispose: (()=>void)|undefined
afterEach(async()=>{await act(async()=>dispose?.());document.body.innerHTML=''})
it('shows a card in the exact conversation, opens without navigation and discards late results after switching', async()=>{
 const node=document.createElement('div');document.body.append(node);const root=createRoot(node);dispose=()=>root.unmount()
 let late!: (value: unknown[])=>void
 const client={getArticles:vi.fn((id:string)=>id==='A'?new Promise<unknown[]>(resolve=>late=resolve):Promise.resolve([{articleId:'b',title:'B的文章',updatedAt:'2026-10-21'}]))}
 const onOpen=vi.fn()
 await act(async()=>root.render(createElement(ConversationArticleCard,{client:client as never,sessionId:'A',running:false,onOpen})))
 await act(async()=>root.render(createElement(ConversationArticleCard,{client:client as never,sessionId:'B',running:false,onOpen})))
 await act(async()=>late([{articleId:'a',title:'A的文章'}]))
 await act(async()=>node.querySelector<HTMLButtonElement>('.md2-article-toggle')!.click())
 expect(node.textContent).toContain('B的文章');expect(node.textContent).not.toContain('A的文章')
 await act(async()=>node.querySelector<HTMLButtonElement>('.md2-open-article')!.click())
 expect(onOpen).toHaveBeenCalledWith('B','b')
})
