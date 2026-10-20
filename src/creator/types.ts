/** Browser-safe, versioned creator vocabulary. No credentials or internal authority. */
export interface CreatorTheme { name: string; description: string }
export interface CreatorPreviewAsset { source: string; path: string; sha256: string; contentType: string }
export interface CreatorPreview { sha256: string; assets: CreatorPreviewAsset[]; status: 'empty' | 'loading' | 'ready' | 'stale' | 'error'; path: string; message: string }
export interface CreatorSuggestion { id: string; title: string; reason: string; before: string; after: string }
export interface CreatorSuggestionRequest { id: string; kind: 'layout' | 'title' | 'polish'; status: 'pending' | 'ready' | 'error' }
export interface CreatorImageCandidate { id: string; revisionId: string; kind: 'cover' | 'body'; path: string; sha256: string; contentType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; byteSize: number; alt: string }
export interface CreatorImagePlacement { id: string; context: string; hasImage: boolean }
export interface CreatorImageRequest { id: string; kind: 'cover' | 'body'; anchorId: string; status: 'pending' | 'ready' | 'error' }
export interface CreatorDelivery { kind: 'export' | 'draft' | 'materials'; status: 'completed' | 'unknown'; path: string; message: string }
export interface CreatorView {
  schemaVersion: 1
  articleId: string
  version: number
  title: string
  publicationTitle: string
  markdown: string
  theme: string
  themes: CreatorTheme[]
  preview: CreatorPreview
  reviewed: boolean
  preparedForDraft: boolean
  draftEnabled: boolean
  imageCandidates: CreatorImageCandidate[]
  imagePlacements: CreatorImagePlacement[]
  imageRequest: CreatorImageRequest | null
  coverId: string
  delivery: CreatorDelivery | null
  canUndo: boolean
  suggestions: CreatorSuggestion[]
  suggestionRequest: CreatorSuggestionRequest | null
}
export type CreatorAction =
  | { type: 'select-theme'; theme: string }
  | { type: 'refresh-preview' }
  | { type: 'review-current'; previewPath: string; previewSha256: string; publicationTitle: string }

  | { type: 'request-suggestions'; kind: 'layout' | 'title' | 'polish' }
  | { type: 'apply-suggestion'; suggestionId: string }
  | { type: 'dismiss-suggestion'; suggestionId: string }
  | { type: 'undo-edit' }
  | { type: 'export-html'; destination: string }
  | { type: 'request-images'; kind: 'cover' | 'body'; anchorId: string }
  | { type: 'select-cover'; candidateId: string }
  | { type: 'place-image'; candidateId: string; anchorId: string }
  | { type: 'remove-image'; anchorId: string }
  | { type: 'import-local-image'; kind: 'cover' | 'body'; anchorId: string; sourcePath: string; alt: string }
  | { type: 'prepare-delivery' }
  | { type: 'create-draft'; confirmed: boolean }
