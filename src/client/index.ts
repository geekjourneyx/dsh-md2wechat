import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { createElement, useMemo } from 'react'
import contribution from '../../lib/typert.remote-client.js'
import { CreatorWorkspace } from './CreatorWorkspace.tsx'
import type { CreatorClient } from './CreatorWorkspace.tsx'
import styleText from './CreatorWorkspace.css'

export const inject = ['remote', 'slots']
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(contribution)
  ctx.effect(() => { const style = document.createElement('style'); style.textContent = styleText; document.head.append(style); return () => style.remove() })
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'md2wechat_open_workspace' }, function Workspace(props: ToolCallViewProps) {
    const meta = 'meta' in props.block ? props.block.meta : undefined
    const articleId = meta && typeof meta === 'object' && !Array.isArray(meta) && meta.kind === 'md2wechat-creator' && meta.schemaVersion === 1 && typeof meta.articleId === 'string' ? meta.articleId : ''
    const client = useMemo<CreatorClient>(() => ({
      async get(signal) { const result = await ctx.remote.md2wechat.get(props.sessionId, articleId, signal); if (!result.ok) throw result.error; return result.value },
      async dispatch(version, action, signal) { const result = await ctx.remote.md2wechat.dispatch(props.sessionId, articleId, version, action, signal); if (!result.ok) throw result.error; return result.value },
      async readPreview(preview, signal) {
        const result = await ctx.remote.workspaceFiles.readBytes(props.sessionId, preview.path, {}, signal)
        if (!result.ok) throw result.error
        await verifyBytes(result.value.data, preview.sha256)
        let html = new TextDecoder('utf-8', { fatal: true }).decode(result.value.data)
        for (const asset of preview.assets) {
          const image = await ctx.remote.workspaceFiles.readBytes(props.sessionId, asset.path, {}, signal)
          if (!image.ok) throw image.error
          await verifyBytes(image.value.data, asset.sha256)
          const bytes = image.value.data
          let binary = ''
          for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
          const dataUrl = `data:${asset.contentType};base64,${btoa(binary)}`
          html = html.replaceAll(`src="${asset.source}"`, `src="${dataUrl}"`).replaceAll(`src='${asset.source}'`, `src='${dataUrl}'`)
        }
        return html
      },
    }), [props.sessionId, articleId])
    return articleId ? createElement(CreatorWorkspace, { client }) : createElement('p', { role: 'status' }, '正在准备文章工作区…')
  }))
}

async function verifyBytes(bytes: Uint8Array, expected: string): Promise<void> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  if (actual !== expected) throw new Error('预览内容发生变化，请重新生成。')
}
