import type { CreatorDeliveryProof, CreatorLocalProof } from './delivery.ts'
import { paragraphImageAnchors } from './image-choices.ts'
import type { ImageCandidate, ParagraphImageAnchor } from './image-choices.ts'
import { discoverMarkdownImageDestinations, resolveLocalImagePath } from '../tools/preview.ts'
import { randomUUID } from 'node:crypto'
import { applyExactChange, validateSuggestions } from './edits.ts'
import type { ProposedChange } from './edits.ts'
import type { CreatorTheme, CreatorView, CreatorPreviewAsset, CreatorSuggestion, CreatorSuggestionRequest, CreatorDelivery, CreatorImageRequest, CreatorDocumentV1, CreatorRecovery } from './types.ts'

export interface CreatorRevision { id: string; manifestPath: string; title: string; markdown: string }
export interface PreviewAttempt { version: number; signal: AbortSignal; controller: AbortController }
export interface CreatorPreviewProof { localProof?: CreatorLocalProof; publicationTitle?: string; path: string; receipt: string; sha256?: string; assets?: CreatorPreviewAsset[] }

function sameCandidateIdentity(left: ImageCandidate, right: ImageCandidate): boolean {
  return left.id === right.id && left.revisionId === right.revisionId && left.kind === right.kind
    && left.path === right.path && left.sha256 === right.sha256 && left.contentType === right.contentType && left.byteSize === right.byteSize
}

/** Small article state owner: async render results never override a newer choice. */
export class CreatorSession {
  version = 1
  private deferCancellation = false
  private recovery: CreatorRecovery | null = null
  private imageCandidates: ImageCandidate[] = []
  private imageRequest: CreatorImageRequest | null = null
  private imageBatch: { version: number; revisionId: string; candidateIds: Set<string> } | undefined
  private coverId = ''
  private finalProof: CreatorDeliveryProof | undefined
  private finalVersion = 0
  private inspection: { version: number; result: import('./types.ts').CreatorInspection } | undefined
  private delivery: CreatorDelivery | null = null
  private suggestions: CreatorSuggestion[] = []
  private suggestionRequest: CreatorSuggestionRequest | null = null
  private undo: CreatorRevision[] = []
  private attempt: PreviewAttempt | undefined
  private preview: CreatorPreviewProof | undefined
  private previewVersion = 0
  private error = ''
  private reviewedVersion = 0
  constructor(
    readonly id: string,
    private readonly owner: string,
    public revision: CreatorRevision,
    readonly themes: CreatorTheme[],
    public theme: string,
    private readonly artifactRoot = '.md2wechat',
    private readonly draftEnabled = false,
    private readonly source = { path: '', sha256: '' },
  ) { if (!themes.some(item => item.name === theme)) throw new Error('当前主题不可用，请重新选择。') }

  /** Durable data projection deliberately omits every approval, proof and pending job. */
  toDocument(): CreatorDocumentV1 {
    return {
      schemaVersion: 1, articleId: this.id, ownerSessionId: this.owner,
      sourcePath: this.source.path, sourceSha256: this.source.sha256, title: this.revision.title,
      revision: { id: this.revision.id, manifestPath: this.revision.manifestPath }, theme: this.theme,
      imageCandidates: this.candidates(), coverId: this.coverId,
      undo: this.undo.map(({ id, manifestPath }) => ({ id, manifestPath })),
      version: this.version, updatedAt: new Date().toISOString(),
    }
  }
  static fromDocument(document: CreatorDocumentV1, revision: CreatorRevision, undo: CreatorRevision[], themes: CreatorTheme[], theme: string, artifactRoot: string, draftEnabled: boolean, recovery: CreatorRecovery): CreatorSession {
    const state = new CreatorSession(document.articleId, document.ownerSessionId, revision, themes, theme, artifactRoot, draftEnabled, { path: document.sourcePath, sha256: document.sourceSha256 })
    state.version = document.version; state.undo = undo; state.imageCandidates = document.imageCandidates.map(image => ({ ...image })); state.coverId = document.coverId
    state.recovery = recovery
    return state
  }
  /** A failed save discards only this candidate, never rolls back a concurrently committed state. */
  fork(): CreatorSession {
    const copy = Object.assign(Object.create(CreatorSession.prototype) as CreatorSession, this)
    copy.imageCandidates = this.candidates(); copy.undo = [...this.undo]; copy.suggestions = this.suggestions.map(item => ({ ...item }))
    copy.imageRequest = this.imageRequest ? { ...this.imageRequest } : null
    copy.suggestionRequest = this.suggestionRequest ? { ...this.suggestionRequest } : null
    copy.imageBatch = this.imageBatch ? { ...this.imageBatch, candidateIds: new Set(this.imageBatch.candidateIds) } : undefined
    copy.deferCancellation = true
    return copy
  }
  committed(previous: CreatorSession): void {
    if (previous.attempt && previous.attempt !== this.attempt) previous.attempt.controller.abort()
    this.deferCancellation = false
  }
  private cancelPreview(): void { if (!this.deferCancellation) this.attempt?.controller.abort(); this.attempt = undefined }

  assertOwner(owner: string): void { if (owner !== this.owner) throw new Error('这篇文章不属于当前会话，请重新打开。') }
  assertVersion(version: number): void { if (version !== this.version) throw new Error('文章已经更新，请查看最新预览后重试。') }
  selectTheme(version: number, theme: string): void {
    this.assertVersion(version)
    if (!this.themes.some(item => item.name === theme)) throw new Error('该主题不可用，请选择列表中的主题。')
    if (this.theme === theme) return
    this.cancelPreview()
    this.delivery = null; this.theme = theme; this.version++; this.error = ''; this.reviewedVersion = 0
    this.suggestions = []; this.suggestionRequest = null; this.imageRequest = null
  }
  requestImages(version: number, kind: 'cover' | 'body', anchorId: string): CreatorImageRequest {
    this.assertVersion(version)
    if (kind !== 'cover' && kind !== 'body') throw new Error('图片请求用途无效。')
    if (kind === 'body') this.anchor(version, anchorId)
    // Reserve the full three-result batch before any provider can be asked to work.
    let remove = Math.max(0, this.imageCandidates.length + 3 - 24)
    let retained = this.imageCandidates
    if (remove) {
      const used = new Set(discoverMarkdownImageDestinations(new TextEncoder().encode(this.revision.markdown))
        .filter(source => !/^https?:\/\//u.test(source) && !source.startsWith('__generate:'))
        .map(source => resolveLocalImagePath(`revisions/${this.revision.id}`, source).normalize('NFC').toLowerCase()))
      retained = this.imageCandidates.filter(candidate => {
        if (!remove || candidate.id === this.coverId || used.has(candidate.path.normalize('NFC').toLowerCase())) return true
        remove--
        return false
      })
      if (remove) throw new Error('已使用的图片较多，没有足够空间保存新一轮候选；请先移除不需要的正文图片或取消封面选择。')
    }
    this.imageCandidates = retained
    this.imageRequest = { id: randomUUID(), kind, anchorId, status: 'pending' }
    this.imageBatch = { version, revisionId: this.revision.id, candidateIds: new Set() }
    return { ...this.imageRequest }
  }
  imageRequestFor(version: number, id: string, requireCapacity = false): CreatorImageRequest {
    this.assertVersion(version)
    if (this.imageRequest?.id !== id || this.imageRequest.status === 'error'
      || this.imageBatch?.version !== version || this.imageBatch.revisionId !== this.revision.id) throw new Error('图片请求已失效，请重新选择。')
    if (requireCapacity && this.imageBatch.candidateIds.size + (this.imageRequest.kind === 'cover' ? 3 : 1) > 3) throw new Error('每轮最多 3 张图片，当前剩余空间不足以执行备用生成；请先发起新一轮请求。')
    return { ...this.imageRequest }
  }
  failImages(id: string): void { if (this.imageRequest?.id === id) this.imageRequest.status = 'error' }
  addImage(version: number, requestId: string, candidate: ImageCandidate): void {
    const request = this.imageRequestFor(version, requestId)
    if (candidate.revisionId !== this.revision.id || candidate.kind !== request.kind) throw new Error('图片不属于当前文章请求。')
    const existing = this.imageCandidates.find(item => item.id === candidate.id)
    if (existing && !sameCandidateIdentity(existing, candidate)) throw new Error('同一图片候选的内容已经变化，请重新导入。')
    const accepted = this.imageBatch!.candidateIds
    if (accepted.has(candidate.id)) return
    if (accepted.size >= 3) throw new Error('每轮最多接收 3 张候选图片，请发起新一轮请求。')
    if (!existing) {
      if (this.imageCandidates.length >= 24) throw new Error('候选图片空间已满，请重新发起图片请求。')
      this.imageCandidates.push({ ...candidate })
    }
    accepted.add(candidate.id)
    this.imageRequest!.status = 'ready'
  }
  candidates(): ImageCandidate[] { return this.imageCandidates.map(item => ({ ...item })) }
  candidate(version: number, id: string): ImageCandidate {
    this.assertVersion(version)
    const candidate = this.imageCandidates.find(item => item.id === id)
    if (!candidate) throw new Error('候选图片已失效，请重新生成。')
    return { ...candidate }
  }
  anchor(version: number, id: string): ParagraphImageAnchor {
    this.assertVersion(version)
    const anchor = paragraphImageAnchors(this.revision.id, this.revision.markdown).find(item => item.id === id)
    if (!anchor) throw new Error('图片位置已变化，请重新选择。')
    return anchor
  }
  selectCover(version: number, id: string): void {
    if (id && this.candidate(version, id).kind !== 'cover') throw new Error('请选择封面候选。')
    this.assertVersion(version)
    if (this.coverId === id) return
    const currentPreview = this.view().preview.status === 'ready'
    this.coverId = id; this.version++; this.reviewedVersion = 0; this.delivery = null
    if (currentPreview) this.previewVersion = this.version
    this.finalProof = undefined
    this.cancelPreview(); this.imageRequest = null; this.suggestions = []; this.suggestionRequest = null
  }
  rebindCandidates(candidates: ImageCandidate[]): void {
    const retained = new Map<string, ImageCandidate>()
    for (const candidate of candidates) {
      if (candidate.revisionId !== this.revision.id) throw new Error('候选图片仍属于旧版本，请重新绑定。')
      const existing = retained.get(candidate.id)
      if (existing && !sameCandidateIdentity(existing, candidate)) throw new Error('同一图片候选的内容已经变化，请重新导入。')
      if (!existing) retained.set(candidate.id, { ...candidate })
    }
    if (retained.size > 24) throw new Error('候选图片空间已满，请重新选择。')
    this.imageCandidates = [...retained.values()]
    if (!retained.has(this.coverId)) this.coverId = ''
    this.imageRequest = null; this.imageBatch = undefined
  }
  requestSuggestions(version: number, kind: CreatorSuggestionRequest['kind']): CreatorSuggestionRequest {
    this.assertVersion(version)
    this.suggestions = []
    this.suggestionRequest = { id: randomUUID(), kind, status: 'pending' }
    return { ...this.suggestionRequest }
  }
  failSuggestions(requestId: string): void {
    if (this.suggestionRequest?.id === requestId) this.suggestionRequest.status = 'error'
  }
  propose(version: number, requestId: string, changes: ProposedChange[]): void {
    this.assertVersion(version)
    if (this.suggestionRequest?.id !== requestId || this.suggestionRequest.status !== 'pending') throw new Error('建议请求已经失效，请重新分析。')
    const valid = validateSuggestions(changes)
    for (const change of valid) applyExactChange(this.revision.markdown, change)
    this.suggestions = valid.map(change => ({ ...change, id: randomUUID() }))
    this.suggestionRequest.status = 'ready'
  }
  suggestion(version: number, id: string): ProposedChange {
    this.assertVersion(version)
    const change = this.suggestions.find(item => item.id === id)
    if (!change) throw new Error('这条建议已经失效，请重新分析。')
    return { title: change.title, reason: change.reason, before: change.before, after: change.after }
  }
  dismiss(version: number, id: string): void {
    this.suggestion(version, id)
    this.suggestions = this.suggestions.filter(item => item.id !== id)
  }
  undoTarget(version: number): CreatorRevision | undefined { this.assertVersion(version); return this.undo.at(-1) }
  replaceRevision(version: number, revision: CreatorRevision, remember: boolean): void {
    this.assertVersion(version)
    if (remember) { this.undo.push(this.revision); if (this.undo.length > 20) this.undo.shift() }
    else this.undo.pop()
    this.cancelPreview()
    this.revision = revision; this.version++; this.reviewedVersion = 0; this.delivery = null; this.error = ''
    this.suggestions = []; this.suggestionRequest = null; this.imageRequest = null
  }
  beginPreview(version: number): PreviewAttempt {
    this.assertVersion(version)
    this.attempt?.controller.abort()
    const controller = new AbortController()
    this.attempt = { version, signal: controller.signal, controller }
    this.error = ''
    return this.attempt
  }
  finishPreview(attempt: PreviewAttempt, preview: CreatorPreviewProof): boolean {
    if (attempt !== this.attempt || attempt.signal.aborted || attempt.version !== this.version) return false
    this.finalProof = undefined; this.preview = preview; this.previewVersion = this.version; this.attempt = undefined; this.error = ''
    this.reviewedVersion = 0
    return true
  }
  failPreview(attempt: PreviewAttempt, message: string): boolean {
    if (this.attempt !== attempt) return false
    this.attempt = undefined; this.error = message; this.reviewedVersion = 0
    return true
  }
  review(version: number): void {
    this.assertVersion(version)
    if (this.view().preview.status !== 'ready') throw new Error('请先生成当前文章的最新预览。')
    this.reviewedVersion = version
  }
  prepared(version: number, proof: CreatorDeliveryProof): void { this.assertVersion(version); this.finalProof = proof; this.finalVersion = version; this.reviewedVersion = 0; this.delivery = null }
  final(): CreatorDeliveryProof | undefined { return this.finalVersion === this.version ? this.finalProof : undefined }
  selectedCover(): ImageCandidate | undefined { return this.coverId ? this.candidate(this.version, this.coverId) : undefined }
  assertReviewed(version: number): void {
    this.assertVersion(version)
    if (this.reviewedVersion !== version) throw new Error('请先审阅当前版本，再导出或保存草稿。')
    this.proof()
  }
  delivered(result: CreatorDelivery | null): void { this.delivery = result ? { ...result } : null }
  proof(): CreatorPreviewProof {
    if (!this.preview || this.previewVersion !== this.version || this.view().preview.status !== 'ready') throw new Error('请先更新预览。')
    return this.preview
  }
  inspected(version: number, result: import('./types.ts').CreatorInspection): void { this.assertVersion(version); this.inspection = { version, result } }
  view(): CreatorView {
    return {
      ...(this.inspection?.version === this.version ? { inspection: structuredClone(this.inspection.result) } : {}),
      recovery: this.recovery ? { ...this.recovery } : null,
      preparedForDraft: !!this.final(), draftEnabled: this.draftEnabled,
      imageCandidates: this.candidates().map(image => ({ ...image, path: `${this.artifactRoot}/${image.path}` })), imagePlacements: /^[a-f0-9]{64}$/u.test(this.revision.id) ? paragraphImageAnchors(this.revision.id, this.revision.markdown).map(anchor => ({ id: anchor.id, context: anchor.context, hasImage: !!anchor.image })) : [],
      imageRequest: this.imageRequest ? { ...this.imageRequest } : null, coverId: this.coverId,
      delivery: this.delivery ? { ...this.delivery } : null,
      canUndo: this.undo.length > 0, suggestions: this.suggestions.map(item => ({ ...item })),
      suggestionRequest: this.suggestionRequest ? { ...this.suggestionRequest } : null,
      schemaVersion: 1, articleId: this.id, version: this.version,
      title: this.revision.title, publicationTitle: this.previewVersion === this.version ? this.preview?.publicationTitle ?? this.revision.title : this.revision.title, markdown: this.revision.markdown, theme: this.theme,
      themes: this.themes.map(item => ({ ...item })), reviewed: this.reviewedVersion === this.version,
      preview: {
        status: this.attempt ? 'loading' : this.error ? 'error' : this.preview ? this.previewVersion === this.version ? 'ready' : 'stale' : 'empty',
        sha256: this.final()?.sha256 ?? this.preview?.sha256 ?? '', assets: (this.final()?.assets ?? this.preview?.assets)?.map(asset => ({ ...asset })) ?? [],
        path: this.final()?.path ?? this.preview?.path ?? '', message: this.error,
      },
    }
  }
}

/** Use real CLI discovery; collections, AI presets and malformed entries are not choices. */
export function selectableThemes(value: unknown): CreatorTheme[] {
  if (!value || typeof value !== 'object' || !('themes' in value) || !Array.isArray(value.themes)) throw new Error('暂时无法读取主题，请重试。')
  const seen = new Set<string>()
  return value.themes.flatMap((item: unknown): CreatorTheme[] => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    if (row.type !== 'api' || row.selectable !== true || typeof row.name !== 'string' || !/^[\w-]{1,100}$/u.test(row.name) || seen.has(row.name)) return []
    seen.add(row.name)
    return [{ name: row.name, description: typeof row.description === 'string' ? row.description.slice(0, 400) : row.name }]
  })
}
