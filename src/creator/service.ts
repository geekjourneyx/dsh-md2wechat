import { CreatorDeliveryUnknownError } from './delivery.ts'
import type { CreatorDeliveryProof } from './delivery.ts'
import { applyBodyImage } from './image-choices.ts'
import type { ImageCandidate } from './image-choices.ts'
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
  prepareDelivery(revision: CreatorRevision, theme: string, proof: CreatorPreviewProof, cover: ImageCandidate, signal: AbortSignal): Promise<CreatorDeliveryProof>
  exportFinal(revision: CreatorRevision, theme: string, proof: CreatorDeliveryProof, coverId: string, destination: string, signal: AbortSignal): Promise<{ path: string }>
  createDraft(revision: CreatorRevision, theme: string, proof: CreatorDeliveryProof, coverId: string, signal: AbortSignal): Promise<{ draftId: string; draftUrl?: string }>
  generateImages(revision: CreatorRevision, kind: 'cover' | 'body', context: string, signal: AbortSignal, requestId: string): Promise<{ kind: 'background' | 'completed'; jobId?: string; sourcePaths: string[] }>
  requestImages(revision: CreatorRevision, kind: 'cover' | 'body', context: string, request: { articleId: string; version: number; requestId: string }, signal: AbortSignal): Promise<void>
  importImage(revision: CreatorRevision, source: string, kind: 'cover' | 'body', alt: string, signal: AbortSignal): Promise<ImageCandidate>
  rebindImages(revision: CreatorRevision, candidates: readonly ImageCandidate[], signal: AbortSignal): Promise<ImageCandidate[]>
  exportHtml(revision: CreatorRevision, theme: string, proof: CreatorPreviewProof, destination: string, signal: AbortSignal): Promise<{ path: string }>
  suggest(revision: CreatorRevision, kind: 'layout' | 'title' | 'polish', request: { articleId: string; version: number; requestId: string }, signal: AbortSignal): Promise<void>
  revise(revision: CreatorRevision, markdown: string, signal: AbortSignal, candidates?: readonly ImageCandidate[]): Promise<CreatorRevision>
  restore(revision: CreatorRevision, signal: AbortSignal): Promise<CreatorRevision>
  preview(revision: CreatorRevision, theme: string, signal: AbortSignal): Promise<CreatorPreviewProof>
}

/** One bounded in-process article controller; immutable article files survive reconnects. */
export class CreatorService {
  private readonly imageJobs = new Map<string, { requestId: string; result: ReturnType<CreatorOperations['generateImages']> }>()
  private readonly delivering = new Set<string>()
  private readonly articles = new Map<string, CreatorSession>()
  constructor(private readonly operations: (agent: Agent) => CreatorOperations, private readonly defaultTheme: string, private readonly artifactRoot = '.md2wechat', private readonly draftEnabled = false) {}

  async open(agent: Agent, source: string, title: string, signal: AbortSignal): Promise<CreatorView> {
    if (this.articles.size >= 100) throw new Error('打开的文章较多，请重启工作区后继续。已保存文章不会丢失。')
    const operations = this.operations(agent)
    await operations.assertWritable(signal)
    const themes = await operations.themes(signal)
    if (!themes.length) throw new Error('没有可用的排版主题，请检查 md2wechat。')
    const revision = await operations.start(source, title, signal)
    const theme = themes.some(item => item.name === this.defaultTheme) ? this.defaultTheme : themes[0]!.name
    const state = new CreatorSession(randomUUID(), agent.id, revision, themes, theme, this.artifactRoot, this.draftEnabled)
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
    state.assertVersion(version)
    if (this.delivering.has(articleId)) throw new Error('正在完成导出或草稿操作，请稍候。')
    switch (action.type) {
      case 'import-local-image': {
        const request = state.requestImages(version, action.kind, action.anchorId)
        const candidate = await operations.importImage(state.revision, action.sourcePath, action.kind, action.alt, signal)
        signal.throwIfAborted(); if (this.delivering.has(articleId)) throw new Error('正在交付当前版本，请完成后再导入图片。'); state.addImage(version, request.id, candidate)
        break
      }
      case 'request-images': {
        const request = state.requestImages(version, action.kind, action.anchorId)
        try { await operations.requestImages(state.revision, action.kind, action.kind === 'body' ? state.anchor(version, action.anchorId).context : '', { articleId, version, requestId: request.id }, signal) }
        catch (error) { state.failImages(request.id); throw error }
        break
      }
      case 'select-cover': state.selectCover(version, action.candidateId); break
      case 'place-image':
      case 'remove-image': {
        const candidate = action.type === 'place-image' ? state.candidate(version, action.candidateId) : null
        if (candidate && candidate.kind !== 'body') throw new Error('请选择正文配图。')
        const markdown = applyBodyImage(state.revision.id, state.revision.markdown, state.anchor(version, action.anchorId), candidate)
        const revised = await operations.revise(state.revision, markdown, signal, state.candidates())
        const candidates = await operations.rebindImages(revised, state.candidates(), signal)
        signal.throwIfAborted(); if (this.delivering.has(articleId)) throw new Error('正在交付当前版本，请完成后再修改。'); state.replaceRevision(version, revised, true); state.rebindCandidates(candidates)
        break
      }
      case 'prepare-delivery': {
        if (!this.draftEnabled) throw new Error('未启用微信草稿，可直接审阅并导出 HTML。')
        if (state.view().delivery?.kind === 'materials' && state.view().delivery?.status === 'unknown') throw new Error('素材上传结果未知，请先到公众号素材库核对。')
        const cover = state.selectedCover()
        if (!cover) throw new Error('保存微信草稿前请先选择一张封面。')
        this.delivering.add(articleId)
        try { const proof = await operations.prepareDelivery(state.revision, state.theme, state.proof(), cover, signal); state.prepared(version, proof) }
        catch (error) {
          if (error instanceof CreatorDeliveryUnknownError) state.delivered({ kind: 'materials', status: 'unknown', path: '', message: '素材上传结果未知，请先到公众号素材库核对。为避免重复上传，已停止重试；原文未更改。' })
          else throw error
        }
        finally { this.delivering.delete(articleId) }
        break
      }
      case 'create-draft': {
        if (!this.draftEnabled || !action.confirmed) throw new Error('请明确确认保存未发布的微信草稿。')
        state.assertReviewed(version)
        const proof = state.final()
        if (!proof) throw new Error('请先准备微信素材并审阅最终版本。')
        this.delivering.add(articleId)
        try {
          const result = await operations.createDraft(state.revision, state.theme, proof, state.view().coverId, signal)
          state.assertVersion(version); state.delivered({ kind: 'draft', status: 'completed', path: result.draftUrl ?? result.draftId, message: '已保存未发布的微信草稿。请到公众号后台检查，没有群发或发布。' })
        } catch (error) {
          if (error instanceof CreatorDeliveryUnknownError) { state.assertVersion(version); state.delivered({ kind: 'draft', status: 'unknown', path: '', message: '草稿结果暂时未知，请先到公众号后台核对。为避免重复，已阻止自动重试。' }) }
          else throw error
        } finally { this.delivering.delete(articleId) }
        break
      }
      case 'export-html': {
        state.assertReviewed(version)
        this.delivering.add(articleId)
        try {
          const final = state.final()
          const result = final ? await operations.exportFinal(state.revision, state.theme, final, state.view().coverId, action.destination, signal) : await operations.exportHtml(state.revision, state.theme, state.proof(), action.destination, signal)
          state.assertVersion(version); state.delivered({ kind: 'export', status: 'completed', path: result.path, message: '已导出当前审阅版本的 HTML。' })
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
        const revised = await operations.revise(state.revision, markdown, signal, state.candidates())
        const candidates = await operations.rebindImages(revised, state.candidates(), signal)
        signal.throwIfAborted(); if (this.delivering.has(articleId)) throw new Error('正在交付当前版本，请完成后再修改。'); state.replaceRevision(version, revised, true); state.rebindCandidates(candidates)
        break
      }
      case 'undo-edit': {
        const target = state.undoTarget(version)
        if (!target) throw new Error('没有可以撤回的修改。')
        const restored = await operations.restore(target, signal)
        const candidates = await operations.rebindImages(restored, state.candidates(), signal)
        signal.throwIfAborted(); if (this.delivering.has(articleId)) throw new Error('正在交付当前版本，请完成后再修改。'); state.replaceRevision(version, restored, false); state.rebindCandidates(candidates)
        break
      }
      case 'select-theme': state.selectTheme(version, action.theme); break
      case 'review-current': {
        const preview = state.view().preview
        if (action.publicationTitle !== state.view().publicationTitle) throw new Error('微信标题已变化，请检查标题后重新审阅。')
        if (!action.previewSha256 || preview.path !== action.previewPath || preview.sha256 !== action.previewSha256) throw new Error('显示的预览已经变化，请等待当前版本加载完成后重新审阅。')
        state.review(version); break
      }
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
  async generateImages(agent: Agent, articleId: string, version: number, requestId: string, signal: AbortSignal) {
    const state = this.owned(agent, articleId)
    state.imageRequestFor(version, requestId)
    const existing = this.imageJobs.get(articleId)
    if (existing?.requestId === requestId) return existing.result
    const operations = this.operations(agent)
    await operations.assertWritable(signal)
    const request = state.imageRequestFor(version, requestId, true)
    if (this.delivering.has(articleId)) throw new Error('正在交付文章，请稍候。')
    const concurrent = this.imageJobs.get(articleId)
    if (concurrent?.requestId === requestId) return concurrent.result
    const revision = state.revision
    const context = request.kind === 'body' ? state.anchor(version, request.anchorId).context : ''
    const result = Promise.resolve().then(() => operations.generateImages(revision, request.kind, context, signal, requestId))
    this.imageJobs.set(articleId, { requestId, result })
    return result
  }
  async importImage(agent: Agent, articleId: string, version: number, requestId: string, source: string, alt: string, signal: AbortSignal): Promise<void> {
    const state = this.owned(agent, articleId)
    const request = state.imageRequestFor(version, requestId)
    const operations = this.operations(agent)
    await operations.assertWritable(signal)
    const candidate = await operations.importImage(state.revision, source, request.kind, alt, signal)
    signal.throwIfAborted(); if (this.delivering.has(articleId)) throw new Error('正在交付当前版本，请完成后再导入图片。'); state.addImage(version, requestId, candidate)
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
