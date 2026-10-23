import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { createElement, useMemo } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import contribution from '../../lib/typert.remote-client.js'
import { ConversationArticleCard } from './ConversationArticleCard.tsx'
import { ConversationArticle } from './ConversationArticle.tsx'
import { ArticlePanel } from './ArticlePanel.tsx'
import { createArticlePanelNavigation, PANEL_ID } from './article-panel-model.ts'
import { createArticlePanelClient } from './creator-client.ts'
import workspaceStyle from './CreatorWorkspace.css'
import panelStyle from './ArticlePanel.css'

export const inject = ['remote', 'slots', 'sessions', 'layout', 'sidebarRight', 'sidebarRightTabs', 'uiWorkspace']

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' { interface SidebarRightTabParamsMap { 'md2wechat-article': { articleId: string } } }

/** Official global main + sidebar entry. Tool messages are shortcuts, not article containers. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(contribution)
  ctx.inject(['remote.md2wechat', 'remote.workspaceFiles'], mountArticlePanel)
}

function mountArticlePanel(ctx: Context): void {
  const navigation = createArticlePanelNavigation()
  const openConversationArticle = (sessionId: string, articleId: string) => {
    if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId as SessionId) return
    ctx.sidebarRight.openTab('md2wechat-article', { params: { articleId } })
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: 'md2wechat-article', kind: 'md2wechat-article', title: () => '文章', keepMounted: false }))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'md2wechat-article' }, function ArticleTab(props) {
    const info = props.useTabInfo()
    const params = info.tab.navigation.params
    const articleId = params && 'articleId' in params && typeof params.articleId === 'string' ? params.articleId : ''
    const target = useMemo(() => { const target = createArticlePanelNavigation(); if (articleId) target.openArticle(props.sessionId, articleId); return target }, [props.sessionId, articleId])
    return createElement(ConversationArticle, { client, navigation: target })
  }))
  const client = createArticlePanelClient(ctx)
  const panelId = PANEL_ID as MainPanelId
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = `${workspaceStyle}\n${panelStyle}`; document.head.append(style)
    return () => style.remove()
  })
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId }, function Articles() {
    return createElement(ArticlePanel, { client, navigation, onContinue: (sessionId: string, articleId: string) => { ctx.uiWorkspace.openSession(sessionId as SessionId); openConversationArticle(sessionId, articleId) } })
  }))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panelId, order: 1, label: '文章历史' }, function ArticleIcon({ size }: { size: number }) {
    return createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
      createElement('path', { d: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6' }))
  }))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'md2wechat-article-card', order: 10 }, props => createElement(ConversationArticleCard, { sessionId: props.sessionId, running: props.session.running, client, onOpen: openConversationArticle })))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'md2wechat_open_workspace' }, function ArticleShortcut(props: ToolCallViewProps) {
    const meta = 'meta' in props.block ? props.block.meta : undefined
    const articleId = meta && typeof meta === 'object' && !Array.isArray(meta) && meta.kind === 'md2wechat-creator' && meta.schemaVersion === 1 && typeof meta.articleId === 'string' && meta.articleId.trim() && meta.articleId.length <= 256 ? meta.articleId : ''
    return createElement('section', { className: 'md2-article-shortcut', 'aria-label': '文章快捷入口' },
      createElement('p', null, articleId ? '文章已准备好。查看正文，调整标题、排版和配图，满意后保存到公众号草稿箱。' : '这张旧文章卡片暂时无法打开。请在当前对话中让助手重新打开文章。'),
      createElement('button', { type: 'button', onClick: () => {
        // The renderer's session prop is the context, never a claimed metadata session id.
        if (articleId) openConversationArticle(props.sessionId, articleId)
        else { navigation.selectSession(props.sessionId); ctx.layout.selectPanel(panelId) }
      } }, articleId ? '预览与调整文章' : '查看文章历史'))
  }))
}
