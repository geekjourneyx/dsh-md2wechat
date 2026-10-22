import { replaceArticleTitle } from './title.ts'
import { creatorRemoteError } from './errors.ts'
import { isLegacyRevisionSource, legacyRevisionSource, LEGACY_RECOVERY_MESSAGE } from './legacy.ts'
import type { DocumentStore } from './documents.ts'
import { CreatorDeliveryUnknownError } from './delivery.ts'
import type { CreatorDeliveryProof } from './delivery.ts'
import { applyBodyImage } from './image-choices.ts'
import type { ImageCandidate } from './image-choices.ts'
import { applyExactChange } from './edits.ts'
import type { ProposedChange } from './edits.ts'
import { createHash, randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import { CreatorSession } from './session.ts'
import type { CreatorRevision, CreatorPreviewProof } from './session.ts'
import type { ImageBytesRequest, ArticleImportRequest, ArticleSummary, CreatorAction, CreatorOpenOptions, CreatorRevisionSummary, CreatorTheme, CreatorView } from './types.ts'

/** Session-scoped domain operations retain their own approval and filesystem checks. */
export interface CreatorOperations {
  inspect?(revision: CreatorRevision, theme: string, cover: ImageCandidate | undefined, signal: AbortSignal): Promise<import('./types.ts').CreatorInspection>
  importImageBytes?(input: ImageBytesRequest, signal: AbortSignal): Promise<string>
  importSource?(input: ArticleImportRequest, signal: AbortSignal): Promise<string>
  documents: Pick<DocumentStore, 'list' | 'read' | 'save' | 'deliveryStatus' | 'beginDelivery' | 'completeDelivery' | 'reconcileDelivery'>
  assertReadable(signal: AbortSignal): Promise<void>
  sourceSnapshot(source: string, signal: AbortSignal): Promise<{ path: string; sha256: string }>
  discoverRevisions(signal: AbortSignal): Promise<CreatorRevisionSummary[]>
  loadRevision(manifestPath: string, signal: AbortSignal): Promise<CreatorRevision>
  validateCandidates(revision: CreatorRevision, candidates: readonly ImageCandidate[], signal: AbortSignal): Promise<ImageCandidate[]>

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

  private readonly commits = new Map<string, Promise<unknown>>()

  async importImageBytes(agent: Agent, input: ImageBytesRequest, signal: AbortSignal): Promise<{ sourcePath: string }> {
    const operations = this.operations(agent)
    await operations.assertReadable(signal); await operations.assertWritable(signal)
    if (!operations.importImageBytes) throw new Error('unavailable')
    return { sourcePath: await operations.importImageBytes(input, signal) }
  }
  async importSource(agent: Agent, input: ArticleImportRequest, signal: AbortSignal): Promise<CreatorView> {
    const operations = this.operations(agent)
    await operations.assertReadable(signal); await operations.assertWritable(signal)
    if (!operations.importSource) throw new Error('unavailable')
    const source = await operations.importSource(input, signal)
    return this.open(agent, source, '', signal)
  }
  async list(agent: Agent, signal: AbortSignal): Promise<ArticleSummary[]> {
    const operations = this.operations(agent)
    await operations.assertReadable(signal)
    const documents = await operations.documents.list(signal)
    return documents.map(({ articleId, title, sourcePath, theme, version, updatedAt }) => ({ articleId, title, sourcePath, theme, version, updatedAt }))
  }
  async discoverRevisions(agent: Agent, signal: AbortSignal): Promise<CreatorRevisionSummary[]> {
    const operations = this.operations(agent)
    await operations.assertReadable(signal)
    return operations.discoverRevisions(signal)
  }
  async recoverRevision(agent: Agent, manifestPath: string, signal: AbortSignal): Promise<CreatorView> {
    const operations = this.operations(agent)
    await operations.assertReadable(signal)
    const source = legacyRevisionSource(this.artifactRoot, manifestPath)
    const load = () => operations.loadRevision(manifestPath, signal).catch(error => { signal.throwIfAborted(); throw creatorRemoteError(error, 'ARTIFACT_INVALID') })
    return this.serialize(`legacy:${agent.id}:${manifestPath}`, async () => {
      // Exact immutable bytes and referenced assets, not directory metadata, authorize recovery.
      const revision = await load()
      const existing = (await operations.documents.list(signal)).find(document => document.sourcePath === source
        || (document.revision.id === revision.id && document.revision.manifestPath === manifestPath))
      if (existing) return this.resume(agent, existing.articleId, signal)
      if (this.articles.size >= 100) throw new Error('打开的文章较多，请重启工作区后继续。已保存文章不会丢失。')
      await operations.assertWritable(signal)
      const snapshot = await operations.sourceSnapshot(source, signal)
      if (snapshot.sha256 !== createHash('sha256').update(revision.markdown).digest('hex')) throw new Error('已保存文章版本不匹配，请检查恢复文件。')
      const themes = await operations.themes(signal)
      if (!themes.length) throw new Error('没有可用的排版主题，请检查 md2wechat。')
      const theme = (themes.find(item => item.name === this.defaultTheme) ?? themes[0]!).name
      const verified = await load()
      if (verified.id !== revision.id || verified.markdown !== revision.markdown) throw new Error('已保存文章版本不匹配，请检查恢复文件。')
      const initial = new CreatorSession(randomUUID(), agent.id, revision, themes, theme, this.artifactRoot, this.draftEnabled, snapshot)
      const state = CreatorSession.fromDocument(initial.toDocument(), revision, [], themes, theme, this.artifactRoot, this.draftEnabled,
        { message: LEGACY_RECOVERY_MESSAGE, sourceChanged: false, themeUnavailable: true })
      signal.throwIfAborted()
      await operations.assertWritable(signal)
      await operations.documents.save(state.toDocument(), signal)
      this.articles.set(state.id, state)
      return state.view()
    })
  }
  async open(agent: Agent, source: string, title: string, signal: AbortSignal, options: CreatorOpenOptions = {}): Promise<CreatorView> {
    if (options.mode !== undefined && options.mode !== 'continue' && options.mode !== 'import-new') throw new Error('请选择继续已保存版本或重新导入原文。')
    const operations = this.operations(agent)
    await operations.assertReadable(signal)
    const snapshot = await operations.sourceSnapshot(source, signal)
    return this.serialize(`source:${agent.id}:${snapshot.path}`, async () => {
      const existing = (await operations.documents.list(signal)).find(document => document.sourcePath === snapshot.path)
      if (existing && options.mode !== 'import-new') {
        if (existing.sourceSha256 !== snapshot.sha256 && options.mode !== 'continue') throw new Error('原文已变化，请明确选择继续已保存版本或重新导入；不会覆盖原文。')
        return this.resume(agent, existing.articleId, signal)
      }
      if (this.articles.size >= 100) throw new Error('打开的文章较多，请重启工作区后继续。已保存文章不会丢失。')
      await operations.assertWritable(signal)
      const themes = await operations.themes(signal)
      if (!themes.length) throw new Error('没有可用的排版主题，请检查 md2wechat。')
      const revision = await operations.start(source, title, signal)
      const after = await operations.sourceSnapshot(source, signal)
      if (after.path !== snapshot.path || after.sha256 !== snapshot.sha256) throw new Error('原文已变化，请重新打开；已保存文章和原文未覆盖。')
      const theme = themes.some(item => item.name === this.defaultTheme) ? this.defaultTheme : themes[0]!.name
      const state = new CreatorSession(randomUUID(), agent.id, revision, themes, theme, this.artifactRoot, this.draftEnabled, snapshot)
      await operations.documents.save(state.toDocument(), signal)
      this.articles.set(state.id, state)
      return state.view()
    })
  }
  async get(agent: Agent, articleId: string, signal: AbortSignal = new AbortController().signal): Promise<CreatorView> {
    try { return await this.resume(agent, articleId, signal) }
    catch (error) {
      // A historical shortcut has no trusted source mapping. Never guess or auto-import a revision.
      if (error instanceof Error && error.message === '文章工作区已关闭或没有保存记录，请重新打开原文。') throw creatorRemoteError(undefined, 'RECOVERY_REQUIRED')
      throw error
    }
  }
  async resume(agent: Agent, articleId: string, signal: AbortSignal): Promise<CreatorView> {
    const operations = this.operations(agent)
    await operations.assertReadable(signal)
    return this.serialize(articleId, async () => {
      const document = await operations.documents.read(articleId, signal)
      if (!document) throw new Error('文章工作区已关闭或没有保存记录，请重新打开原文。')
      if (document.ownerSessionId !== agent.id) throw new Error('这篇文章不属于当前会话，请重新打开。')
      const existing = this.articles.get(articleId)
      if (existing) {
        existing.assertOwner(agent.id)
        await operations.restore(existing.revision, signal)
        await operations.validateCandidates(existing.revision, existing.candidates(), signal)
        await this.applyDeliveryBarrier(existing, operations, signal)
        signal.throwIfAborted()
        return existing.view()
      }
      const revision = await operations.loadRevision(document.revision.manifestPath, signal)
      if (revision.id !== document.revision.id) throw new Error('已保存文章版本不匹配，请检查恢复文件。')
      const undo: CreatorRevision[] = []
      for (const reference of document.undo) {
        const previous = await operations.loadRevision(reference.manifestPath, signal)
        if (previous.id !== reference.id) throw new Error('历史版本不匹配，无法恢复撤回记录。')
        undo.push(previous)
      }
      const candidates = await operations.validateCandidates(revision, document.imageCandidates, signal)
      const themes = await operations.themes(signal)
      if (!themes.length) throw new Error('没有可用的排版主题，请检查 md2wechat。')
      const themeUnavailable = !themes.some(item => item.name === document.theme)
      const theme = themeUnavailable ? (themes.find(item => item.name === this.defaultTheme) ?? themes[0]!).name : document.theme
      let sourceChanged = true
      try { sourceChanged = (await operations.sourceSnapshot(document.sourcePath, signal)).sha256 !== document.sourceSha256 }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'FS_NOT_FOUND'))) throw error
      }
      const recovery = {
        sourceChanged, themeUnavailable,
        message: [isLegacyRevisionSource(this.artifactRoot, document.sourcePath) ? LEGACY_RECOVERY_MESSAGE : '', sourceChanged ? '原文已变化或不可用，当前显示已保存版本；重新导入需要明确选择。' : '已恢复文件保存进度，请重新生成预览并审阅。', themeUnavailable ? '原主题不可用，已回到可用主题，请重新选择并审阅。' : '', '未完成请求和历史授权不会恢复。'].filter(Boolean).join(' '),
      }
      const state = CreatorSession.fromDocument({ ...document, imageCandidates: candidates }, { ...revision, title: document.title }, undo, themes, theme, this.artifactRoot, this.draftEnabled, recovery)
      await this.applyDeliveryBarrier(state, operations, signal)
      signal.throwIfAborted(); this.articles.set(articleId, state)
      return state.view()
    })
  }
  async dispatch(agent: Agent, articleId: string, version: number, action: CreatorAction, signal: AbortSignal): Promise<CreatorView> {
    await this.get(agent, articleId, signal)
    let original = this.owned(agent, articleId)
    original.assertVersion(version)
    if (this.delivering.has(articleId)) throw new Error('正在完成导出或草稿操作，请稍候。')
    signal.throwIfAborted()
    const operations = this.operations(agent)
    await operations.assertWritable(signal)
    original = this.owned(agent, articleId)
    original.assertVersion(version)
    if (this.delivering.has(articleId)) throw new Error('正在完成导出或草稿操作，请稍候。')
    if (action.type === 'prepare-delivery' || action.type === 'create-draft') {
      if (await operations.documents.deliveryStatus(articleId, signal)) throw new Error('微信交付结果尚未核对，请先到公众号后台核对后明确确认。')
      return this.deliver(agent, articleId, version, action, operations, signal)
    }
    if (action.type === 'check-article') {
      if (!operations.inspect) throw new Error('当前版本暂不支持文章检查。')
      const inspection = await operations.inspect(original.revision, original.theme, original.selectedCover(), signal)
      signal.throwIfAborted()
      if (this.owned(agent, articleId) !== original) throw new Error('文章已经更新，请重新检查。')
      original.assertVersion(version)
      original.inspected(version, inspection)
      return original.view()
    }
    if (action.type === 'refresh-preview') return this.refresh(agent, articleId, version, operations, signal)
    const state = original.fork()
    switch (action.type) {
      case 'reconcile-delivery': {
        if (!action.confirmed) throw new Error('请明确确认已到公众号后台核对交付结果。')
        return this.serialize(articleId, async () => {
          if (this.owned(agent, articleId) !== original) throw new Error('文章已经更新，请重新核对。')
          await operations.assertWritable(signal)
          await operations.documents.save(state.toDocument(), signal)
          await operations.documents.reconcileDelivery(articleId, signal)
          state.delivered(null); state.committed(original); this.articles.set(articleId, state)
          return state.view()
        })
      }
      case 'import-local-image': {
        const request = state.requestImages(version, action.kind, action.anchorId)
        const candidate = await operations.importImage(state.revision, action.sourcePath, action.kind, action.alt, signal)
        signal.throwIfAborted(); if (this.delivering.has(articleId)) throw new Error('正在交付当前版本，请完成后再导入图片。'); state.addImage(version, request.id, candidate)
        break
      }
      case 'request-images': {
        const request = state.requestImages(version, action.kind, action.anchorId)
        await this.commit(agent, original, state, operations, signal)
        try { await operations.requestImages(state.revision, action.kind, action.kind === 'body' ? state.anchor(version, action.anchorId).context : '', { articleId, version, requestId: request.id }, signal) }
        catch (error) { await this.failRequest(agent, articleId, operations, signal, next => next.failImages(request.id)); throw error }
        return this.owned(agent, articleId).view()
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
        await this.commit(agent, original, state, operations, signal)
        try { await operations.suggest(state.revision, action.kind, { articleId, version, requestId: request.id }, signal) }
        catch (error) { await this.failRequest(agent, articleId, operations, signal, next => next.failSuggestions(request.id)); throw error }
        return this.owned(agent, articleId).view()
      }
      case 'dismiss-suggestion': state.dismiss(version, action.suggestionId); break
      case 'set-title':
      case 'apply-suggestion': {
        const markdown = action.type === 'set-title' ? replaceArticleTitle(state.revision.markdown, action.title) : applyExactChange(state.revision.markdown, state.suggestion(version, action.suggestionId))
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
      default: throw new Error('不支持的文章操作。')
    }
    return this.commit(agent, original, state, operations, signal)
  }
  async generateImages(agent: Agent, articleId: string, version: number, requestId: string, signal: AbortSignal) {
    await this.get(agent, articleId, signal)
    this.owned(agent, articleId).imageRequestFor(version, requestId)
    const operations = this.operations(agent)
    await operations.assertWritable(signal)
    // Launch, validate and deduplicate in one short boundary; never await the provider here.
    const job = await this.serialize(articleId, async () => {
      signal.throwIfAborted()
      const state = this.owned(agent, articleId)
      const request = state.imageRequestFor(version, requestId)
      if (this.delivering.has(articleId)) throw new Error('正在交付文章，请稍候。')
      const existing = this.imageJobs.get(articleId)
      if (existing?.requestId === requestId) return existing
      state.imageRequestFor(version, requestId, true)
      const context = request.kind === 'body' ? state.anchor(version, request.anchorId).context : ''
      const result = operations.generateImages(state.revision, request.kind, context, signal, requestId)
      const job = { requestId, result }
      this.imageJobs.set(articleId, job)
      return job
    })
    return job.result
  }
  async importImage(agent: Agent, articleId: string, version: number, requestId: string, source: string, alt: string, signal: AbortSignal): Promise<void> {
    await this.get(agent, articleId, signal)
    const operations = this.operations(agent)
    await operations.assertWritable(signal)
    const sourceState = this.owned(agent, articleId)
    const request = sourceState.imageRequestFor(version, requestId)
    const revision = sourceState.revision
    const candidate = await operations.importImage(revision, source, request.kind, alt, signal)
    // Compatible members of one batch merge into the latest state, not a pre-import fork.
    await this.serialize(articleId, async () => {
      signal.throwIfAborted()
      const current = this.owned(agent, articleId)
      current.imageRequestFor(version, requestId)
      if (current.revision.id !== revision.id) throw new Error('文章版本已经变化，请重新请求图片。')
      const next = current.fork()
      next.addImage(version, requestId, candidate)
      await this.publish(agent, current, next, operations, signal)
    })
  }
  async propose(agent: Agent, articleId: string, version: number, requestId: string, changes: ProposedChange[], signal: AbortSignal = new AbortController().signal): Promise<void> {
    await this.get(agent, articleId, signal)
    const operations = this.operations(agent)
    await operations.assertWritable(signal)
    const original = this.owned(agent, articleId); const state = original.fork()
    state.propose(version, requestId, changes)
    await this.commit(agent, original, state, operations, signal)
  }
  private async deliver(agent: Agent, articleId: string, version: number, action: Extract<CreatorAction, { type: 'prepare-delivery' | 'create-draft' }>, operations: CreatorOperations, signal: AbortSignal): Promise<CreatorView> {
    const { original, state, cover, preview, final } = await this.serialize(articleId, async () => {
      signal.throwIfAborted()
      const original = this.owned(agent, articleId)
      original.assertVersion(version)
      if (this.delivering.has(articleId)) throw new Error('正在完成导出或草稿操作，请稍候。')
      const state = original.fork()
      if (!this.draftEnabled) throw new Error('未启用微信草稿，可直接审阅并导出 HTML。')
      let cover: ImageCandidate | undefined; let preview: CreatorPreviewProof | undefined; let final: CreatorDeliveryProof | undefined
      if (action.type === 'prepare-delivery') {
        cover = state.selectedCover()
        if (!cover) throw new Error('保存微信草稿前请先选择一张封面。')
        preview = state.proof()
      } else {
        if (!action.confirmed) throw new Error('请明确确认保存未发布的微信草稿。')
        state.assertReviewed(version)
        final = state.final()
        if (!final) throw new Error('请先准备微信素材并审阅最终版本。')
      }
      this.delivering.add(articleId)
      return { original, state, cover, preview, final }
    })
    let token: string | undefined
    try {
      token = await operations.documents.beginDelivery(articleId, action.type === 'prepare-delivery' ? 'materials' : 'draft', signal)
      // The private marker can await I/O; revalidate before any effect-capable adapter is invoked.
      if (this.owned(agent, articleId) !== original) throw new Error('文章已经更新，请查看最新预览后重试。')
      original.assertVersion(version); signal.throwIfAborted()
      try {
        if (action.type === 'prepare-delivery') {
          const proof = await operations.prepareDelivery(state.revision, state.theme, preview!, cover!, signal)
          state.prepared(version, proof)
        } else {
          const result = await operations.createDraft(state.revision, state.theme, final!, state.view().coverId, signal)
          state.delivered({ kind: 'draft', status: 'completed', path: result.draftUrl ?? result.draftId, message: '已保存未发布的微信草稿。请到公众号后台检查，没有群发或发布。' })
        }
        await operations.documents.completeDelivery(articleId, token, signal)
      } catch (error) {
        if (!(error instanceof CreatorDeliveryUnknownError)) throw error
        state.delivered({ kind: action.type === 'prepare-delivery' ? 'materials' : 'draft', status: 'unknown', path: '', message: '微信交付结果未知，请先到公众号后台核对。为避免重复，已阻止自动重试。' })
      }
      return await this.serialize(articleId, () => this.publish(agent, original, state, operations, signal, true))
    } catch (error) {
      // Known preflight failures did not start an uncertain write. Unknown outcomes keep the marker.
      if (token && !(error instanceof CreatorDeliveryUnknownError)) {
        const pending = await operations.documents.deliveryStatus(articleId)
        if (pending?.token === token && state.view().delivery?.status !== 'unknown') await operations.documents.completeDelivery(articleId, token)
      }
      throw error
    } finally { this.delivering.delete(articleId) }
  }
  private async applyDeliveryBarrier(state: CreatorSession, operations: CreatorOperations, signal: AbortSignal): Promise<void> {
    const pending = await operations.documents.deliveryStatus(state.id, signal)
    if (pending) state.delivered({ kind: pending.kind, status: 'unknown', path: '', message: '上次微信素材或草稿交付结果尚未核对。请到公众号后台检查，再明确确认已核对；新预览不会解除重试限制。' })
    else if (state.view().delivery?.status === 'unknown') state.delivered(null)
  }
  private async failRequest(agent: Agent, articleId: string, operations: CreatorOperations, signal: AbortSignal, fail: (state: CreatorSession) => void): Promise<void> {
    const current = this.owned(agent, articleId); const next = current.fork(); fail(next)
    await this.commit(agent, current, next, operations, signal)
  }
  private async refresh(agent: Agent, articleId: string, version: number, operations: CreatorOperations, signal: AbortSignal): Promise<CreatorView> {
    const { attempt, revision, theme } = await this.serialize(articleId, async () => {
      if (this.delivering.has(articleId)) throw new Error('正在完成导出或草稿操作，请稍候。')
      const current = this.owned(agent, articleId); const state = current.fork()
      const attempt = state.beginPreview(version)
      state.committed(current); this.articles.set(articleId, state)
      return { attempt, revision: state.revision, theme: state.theme }
    })
    const combined = AbortSignal.any([signal, attempt.signal])
    try {
      const proof = await operations.preview(revision, theme, combined)
      await this.serialize(articleId, async () => {
        const current = this.owned(agent, articleId); const state = current.fork()
        if (state.finishPreview(attempt, proof)) { state.committed(current); this.articles.set(articleId, state) }
      })
    } catch (error) {
      const missingLayoutKey = error instanceof Error && error.message === 'MD2WECHAT_API_KEY is not configured for article preview'
      await this.serialize(articleId, async () => {
        const current = this.owned(agent, articleId); const state = current.fork()
        if (state.failPreview(attempt, combined.aborted ? '预览已取消，原预览仍保留。' : missingLayoutKey ? '尚未连接排版密钥，请在 DSH 中配置 MD2WECHAT_API_KEY 后重试。原文未更改。' : '预览未完成。请检查排版配置或重试；原文未更改。')) { state.committed(current); this.articles.set(articleId, state) }
      })
    }
    const state = this.owned(agent, articleId)
    await this.applyDeliveryBarrier(state, operations, signal.aborted ? new AbortController().signal : signal)
    return state.view()
  }
  private commit(agent: Agent, original: CreatorSession, next: CreatorSession, operations: CreatorOperations, signal: AbortSignal): Promise<CreatorView> {
    return this.serialize(original.id, () => this.publish(agent, original, next, operations, signal))
  }
  /** Caller holds the short article queue; ordinary edits still require exact state identity. */
  private async publish(agent: Agent, original: CreatorSession, next: CreatorSession, operations: CreatorOperations, signal: AbortSignal, ownsDelivery = false): Promise<CreatorView> {
    if (this.owned(agent, original.id) !== original) throw new Error('文章已经更新，请查看最新预览后重试。')
    if (this.delivering.has(original.id) && !ownsDelivery) throw new Error('正在完成导出或草稿操作，请稍候。')
    await operations.assertWritable(signal)
    await this.applyDeliveryBarrier(next, operations, signal)
    await operations.documents.save(next.toDocument(), signal)
    next.committed(original)
    this.articles.set(next.id, next)
    return next.view()
  }
  private async serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.commits.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(action)
    this.commits.set(key, next)
    try { return await next } finally { if (this.commits.get(key) === next) this.commits.delete(key) }
  }
  private owned(agent: Agent, articleId: string): CreatorSession {
    const state = this.articles.get(articleId)
    if (!state) throw new Error('文章工作区已关闭，请重新打开原文。')
    state.assertOwner(agent.id)
    return state
  }
}
