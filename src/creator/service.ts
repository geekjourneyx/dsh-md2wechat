import { applyExactChange } from './edits.ts'
import type { ProposedChange } from './edits.ts'
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import { CreatorSession } from './session.ts'
import type { CreatorRevision, CreatorPreviewProof } from './session.ts'
import type { CreatorAction, CreatorTheme, CreatorView } from './types.ts'

/** Session-scoped domain operations retain their own approval and filesystem checks. */
export interface CreatorOperations {
  assertWritable(signal: AbortSignal): Promise<void>
  themes(signal: AbortSignal): Promise<CreatorTheme[]>
  start(source: string, title: string, signal: AbortSignal): Promise<CreatorRevision>
  exportHtml(revision: CreatorRevision, theme: string, proof: CreatorPreviewProof, destination: string, signal: AbortSignal): Promise<{ path: string }>
  suggest(revision: CreatorRevision, kind: 'layout' | 'title' | 'polish', request: { articleId: string; version: number; requestId: string }, signal: AbortSignal): Promise<void>
  revise(revision: CreatorRevision, markdown: string, signal: AbortSignal): Promise<CreatorRevision>
  restore(revision: CreatorRevision, signal: AbortSignal): Promise<CreatorRevision>
  preview(revision: CreatorRevision, theme: string, signal: AbortSignal): Promise<CreatorPreviewProof>
}

/** One bounded in-process article controller; immutable article files survive reconnects. */
export class CreatorService {
  private readonly delivering = new Set<string>()
  private readonly articles = new Map<string, CreatorSession>()
  constructor(private readonly operations: (agent: Agent) => CreatorOperations, private readonly defaultTheme: string) {}

  async open(agent: Agent, source: string, title: string, signal: AbortSignal): Promise<CreatorView> {
    if (this.articles.size >= 100) throw new Error('打开的文章较多，请重启工作区后继续。已保存文章不会丢失。')
    const operations = this.operations(agent)
    await operations.assertWritable(signal)
    const themes = await operations.themes(signal)
    if (!themes.length) throw new Error('没有可用的排版主题，请检查 md2wechat。')
    const revision = await operations.start(source, title, signal)
    const theme = themes.some(item => item.name === this.defaultTheme) ? this.defaultTheme : themes[0]!.name
    const state = new CreatorSession(randomUUID(), agent.id, revision, themes, theme)
    this.articles.set(state.id, state)
    return state.view()
  }
  get(agent: Agent, articleId: string): CreatorView { return this.owned(agent, articleId).view() }
  async dispatch(agent: Agent, articleId: string, version: number, action: CreatorAction, signal: AbortSignal): Promise<CreatorView> {
    const state = this.owned(agent, articleId)
    state.assertVersion(version)
    if (this.delivering.has(articleId)) throw new Error('正在完成导出或草稿操作，请稍候。')
    signal.throwIfAborted()
    const operations = this.operations(agent)
    await operations.assertWritable(signal)
    switch (action.type) {
      case 'export-html': {
        state.assertReviewed(version)
        this.delivering.add(articleId)
        try {
          const result = await operations.exportHtml(state.revision, state.theme, state.proof(), action.destination, signal)
          state.delivered({ kind: 'export', status: 'completed', path: result.path, message: '已导出当前审阅版本的 HTML。' })
        } finally { this.delivering.delete(articleId) }
        break
      }
      case 'request-suggestions': {
        const request = state.requestSuggestions(version, action.kind)
        try { await operations.suggest(state.revision, action.kind, { articleId, version, requestId: request.id }, signal) }
        catch (error) { state.failSuggestions(request.id); throw error }
        break
      }
      case 'dismiss-suggestion': state.dismiss(version, action.suggestionId); break
      case 'apply-suggestion': {
        const markdown = applyExactChange(state.revision.markdown, state.suggestion(version, action.suggestionId))
        const revised = await operations.revise(state.revision, markdown, signal)
        signal.throwIfAborted(); state.replaceRevision(version, revised, true)
        break
      }
      case 'undo-edit': {
        const target = state.undoTarget(version)
        if (!target) throw new Error('没有可以撤回的修改。')
        const restored = await operations.restore(target, signal)
        signal.throwIfAborted(); state.replaceRevision(version, restored, false)
        break
      }
      case 'select-theme': state.selectTheme(version, action.theme); break
      case 'review-current': state.review(version); break
      case 'refresh-preview': {
        const attempt = state.beginPreview(version)
        const combined = AbortSignal.any([signal, attempt.signal])
        try {
          const proof = await operations.preview(state.revision, state.theme, combined)
          state.finishPreview(attempt, proof)
        } catch {
          state.failPreview(attempt, combined.aborted ? '预览已取消，原预览仍保留。' : '预览未完成。请检查排版配置或重试；原文未更改。')
        }
        break
      }
      default: throw new Error('不支持的文章操作。')
    }
    return state.view()
  }
  propose(agent: Agent, articleId: string, version: number, requestId: string, changes: ProposedChange[]): void {
    this.owned(agent, articleId).propose(version, requestId, changes)
  }
  private owned(agent: Agent, articleId: string): CreatorSession {
    const state = this.articles.get(articleId)
    if (!state) throw new Error('文章工作区已关闭，请重新打开原文。')
    state.assertOwner(agent.id)
    return state
  }
}
