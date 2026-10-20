import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { createElement } from 'react'
import contribution from '../../lib/typert.remote-client.js'
import { ArticlePanel } from './ArticlePanel.tsx'
import { createArticlePanelNavigation, PANEL_ID } from './article-panel-model.ts'
import { createArticlePanelClient } from './creator-client.ts'
import workspaceStyle from './CreatorWorkspace.css'
import panelStyle from './ArticlePanel.css'

export const inject = ['remote', 'slots', 'sessions', 'layout']

/** Official global main + sidebar entry. Tool messages are shortcuts, not article containers. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(contribution)
  const navigation = createArticlePanelNavigation()
  const client = createArticlePanelClient(ctx)
  const panelId = PANEL_ID as MainPanelId
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = `${workspaceStyle}\n${panelStyle}`; document.head.append(style)
    return () => style.remove()
  })
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId }, function Articles() {
    return createElement(ArticlePanel, { client, navigation })
  }))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panelId, order: 1, label: '文章' }, function ArticleIcon({ size }: { size: number }) {
    return createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
      createElement('path', { d: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6' }))
  }))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'md2wechat_open_workspace' }, function ArticleShortcut(props: ToolCallViewProps) {
    const meta = 'meta' in props.block ? props.block.meta : undefined
    const articleId = meta && typeof meta === 'object' && !Array.isArray(meta) && meta.kind === 'md2wechat-creator' && meta.schemaVersion === 1 && typeof meta.articleId === 'string' && meta.articleId.trim() && meta.articleId.length <= 256 ? meta.articleId : ''
    return createElement('section', { className: 'md2-article-shortcut', 'aria-label': '文章快捷入口' },
      createElement('p', null, articleId ? '文章进度保存在独立文章工作区。打开后继续预览、调整和审阅。' : '这个旧入口没有可用的文章标识。请选择原文或已保存版本恢复，不会猜测或覆盖文章。'),
      createElement('button', { type: 'button', onClick: () => {
        // The renderer's session prop is the context, never a claimed metadata session id.
        if (articleId) navigation.openArticle(props.sessionId, articleId)
        else navigation.selectSession(props.sessionId)
        ctx.layout.selectPanel(panelId)
      } }, articleId ? '打开文章' : '选择原文恢复'))
  }))
}
