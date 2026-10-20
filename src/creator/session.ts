import { paragraphImageAnchors } from './image-choices.ts'
import type { ImageCandidate, ParagraphImageAnchor } from './image-choices.ts'
import { randomUUID } from 'node:crypto'
import { applyExactChange, validateSuggestions } from './edits.ts'
import type { ProposedChange } from './edits.ts'
import type { CreatorTheme, CreatorView, CreatorPreviewAsset, CreatorSuggestion, CreatorSuggestionRequest, CreatorDelivery, CreatorImageRequest } from './types.ts'

export interface CreatorRevision { id: string; manifestPath: string; title: string; markdown: string }
export interface PreviewAttempt { version: number; signal: AbortSignal; controller: AbortController }
export interface CreatorPreviewProof { path: string; receipt: string; sha256?: string; assets?: CreatorPreviewAsset[] }

/** Small article state owner: async render results never override a newer choice. */
export class CreatorSession {
  version = 1
  private imageCandidates: ImageCandidate[] = []
  private imageRequest: CreatorImageRequest | null = null
  private coverId = ''
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
  ) { if (!themes.some(item => item.name === theme)) throw new Error('当前主题不可用，请重新选择。') }

  assertOwner(owner: string): void { if (owner !== this.owner) throw new Error('这篇文章不属于当前会话，请重新打开。') }
  assertVersion(version: number): void { if (version !== this.version) throw new Error('文章已经更新，请查看最新预览后重试。') }
  selectTheme(version: number, theme: string): void {
    this.assertVersion(version)
    if (!this.themes.some(item => item.name === theme)) throw new Error('该主题不可用，请选择列表中的主题。')
    if (this.theme === theme) return
    this.attempt?.controller.abort()
    this.attempt = undefined
    this.delivery = null; this.theme = theme; this.version++; this.error = ''; this.reviewedVersion = 0
    this.suggestions = []; this.suggestionRequest = null; this.imageRequest = null
  }
  requestImages(version: number, kind: 'cover' | 'body', anchorId: string): CreatorImageRequest {
    this.assertVersion(version)
    if (kind === 'body') this.anchor(version, anchorId)
    this.imageRequest = { id: randomUUID(), kind, anchorId, status: 'pending' }
    return { ...this.imageRequest }
  }
  imageRequestFor(version: number, id: string): CreatorImageRequest {
    this.assertVersion(version)
    if (this.imageRequest?.id !== id || this.imageRequest.status === 'error') throw new Error('图片请求已失效，请重新选择。')
    return { ...this.imageRequest }
  }
  failImages(id: string): void { if (this.imageRequest?.id === id) this.imageRequest.status = 'error' }
  addImage(version: number, requestId: string, candidate: ImageCandidate): void {
    const request = this.imageRequestFor(version, requestId)
    if (candidate.revisionId !== this.revision.id || candidate.kind !== request.kind) throw new Error('图片不属于当前文章请求。')
    if (this.imageCandidates.filter(item => item.kind === candidate.kind).length >= 3) throw new Error('最多保留 3 张同类候选图片，请重新打开文章再试。')
    if (!this.imageCandidates.some(item => item.id === candidate.id)) this.imageCandidates.push({ ...candidate })
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
    this.coverId = id; this.version++; this.reviewedVersion = 0; this.delivery = null
    this.attempt?.controller.abort(); this.attempt = undefined; this.imageRequest = null; this.suggestions = []; this.suggestionRequest = null
  }
  rebindCandidates(candidates: ImageCandidate[]): void { this.imageCandidates = candidates.map(item => ({ ...item })) }
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
    this.attempt?.controller.abort(); this.attempt = undefined
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
    this.preview = preview; this.previewVersion = this.version; this.attempt = undefined; this.error = ''
    this.reviewedVersion = 0
    return true
  }
  failPreview(attempt: PreviewAttempt, message: string): void {
    if (this.attempt !== attempt) return
    this.attempt = undefined; this.error = message; this.reviewedVersion = 0
  }
  review(version: number): void {
    this.assertVersion(version)
    if (this.view().preview.status !== 'ready') throw new Error('请先生成当前文章的最新预览。')
    this.reviewedVersion = version
  }
  assertReviewed(version: number): void {
    this.assertVersion(version)
    if (this.reviewedVersion !== version) throw new Error('请先审阅当前版本，再导出或保存草稿。')
    this.proof()
  }
  delivered(result: CreatorDelivery): void { this.delivery = { ...result } }
  proof(): CreatorPreviewProof {
    if (!this.preview || this.previewVersion !== this.version || this.view().preview.status !== 'ready') throw new Error('请先更新预览。')
    return this.preview
  }
  view(): CreatorView {
    return {
      imageCandidates: this.candidates(), imagePlacements: /^[a-f0-9]{64}$/u.test(this.revision.id) ? paragraphImageAnchors(this.revision.id, this.revision.markdown).map(anchor => ({ id: anchor.id, context: anchor.context, hasImage: !!anchor.image })) : [],
      imageRequest: this.imageRequest ? { ...this.imageRequest } : null, coverId: this.coverId,
      delivery: this.delivery ? { ...this.delivery } : null,
      canUndo: this.undo.length > 0, suggestions: this.suggestions.map(item => ({ ...item })),
      suggestionRequest: this.suggestionRequest ? { ...this.suggestionRequest } : null,
      schemaVersion: 1, articleId: this.id, version: this.version,
      title: this.revision.title, markdown: this.revision.markdown, theme: this.theme,
      themes: this.themes.map(item => ({ ...item })), reviewed: this.reviewedVersion === this.version,
      preview: {
        status: this.attempt ? 'loading' : this.error ? 'error' : this.preview ? this.previewVersion === this.version ? 'ready' : 'stale' : 'empty',
        sha256: this.preview?.sha256 ?? '', assets: this.preview?.assets?.map(asset => ({ ...asset })) ?? [],
        path: this.preview?.path ?? '', message: this.error,
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
