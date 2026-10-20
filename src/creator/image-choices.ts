import { createHash } from 'node:crypto'
import { validateArtifactId, validateArtifactRelativePath } from '../workspace/artifact-store.ts'
import type { ArtifactStore } from '../workspace/artifact-store.ts'
import { validateImageBytes, validatePlannedImageTarget } from '../workspace/images.ts'
import type { ImagePlanItem, SupportedImageMime } from '../workspace/images.ts'

/** Server-owned metadata for one already imported local candidate, never upload authority. */
export interface ImageCandidate {
  id: string
  revisionId: string
  kind: 'cover' | 'body'
  path: string
  sha256: string
  contentType: SupportedImageMime
  byteSize: number
  alt: string
}

/** Exact paragraph and optional following image, bound to the complete source revision. */
export interface ParagraphImageAnchor {
  id: string
  revisionId: string
  articleSha256: string
  start: number
  end: number
  context: string
  image?: { start: number; end: number; source: string }
}

type CandidateStore = Pick<ArtifactStore, 'readBounded'>
const HASH = /^[a-f0-9]{64}$/u
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Optional planning only. CLI execution still needs its existing approval for all three uploads. */
export function createCoverRequests(revisionId: string, prompt: string): ImagePlanItem[] {
  assertRevision(revisionId)
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new Error('请提供简短的封面主题。')
  return ['cover-editorial', 'cover-minimal', 'cover-illustrated'].map(preset => {
    const id = `cover-${sha256(`${revisionId}\0${prompt}\0${preset}`).slice(0, 24)}`
    return { id, kind: 'cover', prompt, targetPath: `images/${id}.png`, preset, aspect: '16:9' }
  })
}

/**
 * Conservative plain-paragraph placements, not a second Markdown renderer.
 * Complex blocks remain untouched. Offsets distinguish repeated text.
 */
export function paragraphImageAnchors(revisionId: string, markdown: string): ParagraphImageAnchor[] {
  assertRevision(revisionId)
  const articleSha256 = sha256(markdown)
  const anchors: ParagraphImageAnchor[] = []
  let paragraph: { start: number; end: number } | undefined
  let previous: ParagraphImageAnchor | undefined
  let fence = ''
  let frontmatter = false
  let moduleDepth = 0
  let htmlTag = ''
  let math = false
  let excludedBlock = false
  let sectionTitle = ''
  let offset = 0
  const flush = (): void => {
    if (!paragraph) return
    const { start, end } = paragraph
    previous = {
      id: sha256(`${revisionId}\0${articleSha256}\0${start}\0${end}`),
      revisionId, articleSha256, start, end, context: markdown.slice(start, end),
    }
    anchors.push(previous)
    paragraph = undefined
  }
  const skip = (): void => { flush(); previous = undefined }
  for (const raw of markdown.split(/(?<=\n)/u)) {
    const start = offset
    offset += raw.length
    const line = raw.replace(/\r?\n$/u, '')
    const trimmed = line.trim()
    if (start === 0 && trimmed === '---') { frontmatter = true; skip(); continue }
    if (frontmatter) { if (trimmed === '---' || trimmed === '...') frontmatter = false; continue }
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && new RegExp(`^ {0,3}${marker[0]}{${fence.length},}\\s*$`, 'u').test(line)) fence = ''
      continue
    }
    if (marker) { skip(); fence = marker; continue }
    if (moduleDepth) {
      if (/^:{3,}\s*$/u.test(trimmed)) moduleDepth--
      else if (/^:{3,}\S/u.test(trimmed)) moduleDepth++
      continue
    }
    if (/^:{3,}/u.test(trimmed)) { skip(); moduleDepth = 1; continue }
    if (trimmed === '$$') { skip(); math = !math; continue }
    if (math) continue
    if (htmlTag) {
      if (htmlTag === '!--' ? trimmed.includes('-->') : new RegExp(`</${htmlTag}\\s*>`, 'iu').test(trimmed)) htmlTag = ''
      continue
    }
    const html = trimmed.startsWith('<!--') ? '!--' : /^<([a-z][\w-]*)\b/iu.exec(trimmed)?.[1]
    if (html) {
      skip()
      if (html === '!--' ? !trimmed.includes('-->') : !new RegExp(`</${html}\\s*>|/>`, 'iu').test(trimmed)) htmlTag = html
      continue
    }
    if (!trimmed) { flush(); excludedBlock = false; continue }
    if (excludedBlock) continue
    if (/^ {0,3}(?:=+|-+)\s*$/u.test(line) && paragraph) { paragraph = undefined; previous = undefined; continue }
    if (/^(?: {0,3}>| {0,3}(?:[-+*]|\d+[.)])\s| {4}|\t|\s*\|)/u.test(line)) { skip(); excludedBlock = true; continue }
    const image = /^!\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)$/u.exec(trimmed)
    if (image) {
      flush()
      const placement = {
        start: start + line.indexOf(trimmed), end: start + line.indexOf(trimmed) + trimmed.length,
        source: image[1]!.replace(/^<|>$/gu, ''),
      }
      if (previous && !previous.image) {
        previous.image = placement
      } else anchors.push({
        id: sha256(`${revisionId}\0${articleSha256}\0${placement.start}\0${placement.end}`),
        revisionId, articleSha256, start: placement.start, end: placement.end,
        context: sectionTitle || '文章图片', image: placement,
      })
      previous = undefined
      continue
    }
    const heading = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/u.exec(line)
    if (heading) { skip(); sectionTitle = heading[1]!; continue }
    if (/^(?:\s*#{1,6}\s| {0,3}>| {0,3}(?:[-+*]|\d+[.)])\s| {4}|\t|\s*<|\s*\||\s*\[|\s*\$\$|\s*(?:[-*_]\s*){3,}$|\s*=+\s*$)/u.test(line)
      || /!\[|<[^>]+>|\|/u.test(line)) { skip(); continue }
    if (paragraph) paragraph.end = start + line.length
    else paragraph = { start, end: start + line.length }
  }
  flush()
  return anchors
}

/** Return new source; the caller must publish a new revision and invalidate its old preview. */
export function applyBodyImage(revisionId: string, markdown: string, anchor: ParagraphImageAnchor, candidate: ImageCandidate | null): string {
  assertRevision(revisionId)
  if (anchor.revisionId !== revisionId) throw new Error('图片位置属于旧版本，请重新选择。')
  if (anchor.articleSha256 !== sha256(markdown)) throw new Error('文章已经变化，请重新选择图片位置。')
  const current = paragraphImageAnchors(revisionId, markdown).find(item => item.id === anchor.id)
  if (!current || current.start !== anchor.start || current.end !== anchor.end || current.context !== anchor.context
    || JSON.stringify(current.image) !== JSON.stringify(anchor.image)) throw new Error('图片位置无效，请重新选择。')
  let replacement = ''
  if (candidate) {
    const image = normalizeCandidate(revisionId, candidate)
    if (image.kind !== 'body') throw new Error('请选择正文图片候选。')
    const local = image.path.slice(`revisions/${revisionId}/`.length)
    const destination = /[\s()]/u.test(local) ? `<${local}>` : local
    const alt = [...image.alt.replace(/[\r\n\t]/gu, ' ')].filter(character => !containsControl(character)).join('')
      .replace(/[\][\\<>]/gu, character => ({ '[': '［', ']': '］', '\\': '＼', '<': '＜', '>': '＞' })[character]!)
    replacement = `![${alt}](${destination})`
  }
  if (current.image) return markdown.slice(0, current.image.start) + replacement + markdown.slice(current.image.end)
  if (!replacement) return markdown
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n'
  return markdown.slice(0, current.end) + newline + newline + replacement + markdown.slice(current.end)
}

/** Filter server-held candidates only; neither candidate presence nor selection authorizes uploading. */
export function selectImageCandidates(revisionId: string, candidates: readonly ImageCandidate[], selection: { coverId?: string; bodyIds: readonly string[] }): { cover?: ImageCandidate; body: ImageCandidate[] } {
  assertRevision(revisionId)
  if (!Array.isArray(candidates) || candidates.length > 128 || !Array.isArray(selection.bodyIds) || selection.bodyIds.length > 128) throw new Error('图片候选过多。')
  const known = new Map<string, ImageCandidate>()
  for (const candidate of candidates) {
    const image = normalizeCandidate(revisionId, candidate)
    if (known.has(image.id)) throw new Error('图片候选重复，请重新加载。')
    known.set(image.id, image)
  }
  if (new Set(selection.bodyIds).size !== selection.bodyIds.length) throw new Error('正文图片选择重复。')
  const get = (id: string, kind: ImageCandidate['kind']): ImageCandidate => {
    const image = known.get(id)
    if (!image) throw new Error('图片候选不存在，请重新选择。')
    if (image.kind !== kind) throw new Error(kind === 'cover' ? '请选择封面候选。' : '请选择正文图片候选。')
    return { ...image }
  }
  const body = selection.bodyIds.map(id => get(id, 'body'))
  return selection.coverId === undefined ? { body } : { cover: get(selection.coverId, 'cover'), body }
}

/** Revalidate local content through the workspace-contained store; never fetch a URL or trust a media ID. */
export async function verifyImageCandidate(store: CandidateStore, revisionId: string, candidate: ImageCandidate, signal?: AbortSignal): Promise<ImageCandidate> {
  signal?.throwIfAborted()
  const image = normalizeCandidate(revisionId, candidate)
  const bytes = await store.readBounded(image.path, image.byteSize, signal)
  signal?.throwIfAborted()
  if (bytes.byteLength !== image.byteSize || sha256(bytes) !== image.sha256) throw new Error('图片内容已经变化，请重新导入。')
  validateImageBytes(image.contentType, bytes)
  return image
}

/**
 * Bind an already-copied asset to the next immutable revision after checking both copies.
 * CLI plans and upload provenance intentionally do not survive by copying their paths.
 */
export async function rebindImageCandidate(store: CandidateStore, candidate: ImageCandidate, revisionId: string, signal?: AbortSignal): Promise<ImageCandidate> {
  assertRevision(revisionId)
  const old = await verifyImageCandidate(store, candidate.revisionId, candidate, signal)
  const path = `revisions/${revisionId}/${old.path.slice(`revisions/${old.revisionId}/`.length)}`
  return verifyImageCandidate(store, revisionId, { ...old, revisionId, path }, signal)
}

function normalizeCandidate(revisionId: string, candidate: ImageCandidate): ImageCandidate {
  assertRevision(revisionId)
  if (!candidate || candidate.revisionId !== revisionId) throw new Error('图片候选属于旧版本，请重新选择。')
  if (typeof candidate.id !== 'string' || candidate.id.length > 128) throw new Error('图片候选标识无效。')
  validateArtifactId(candidate.id)
  if (candidate.kind !== 'cover' && candidate.kind !== 'body') throw new Error('图片候选类型无效。')
  if (typeof candidate.path !== 'string' || candidate.path.length > 1200 || !candidate.path.startsWith(`revisions/${revisionId}/images/`)
    || /[\\%?#<>]/u.test(candidate.path) || containsControl(candidate.path)) throw new Error('图片候选路径无效。')
  validateArtifactRelativePath(candidate.path)
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(candidate.contentType)) throw new Error('图片格式不支持。')
  validatePlannedImageTarget(candidate.path, candidate.contentType)
  if (!HASH.test(candidate.sha256) || !Number.isSafeInteger(candidate.byteSize) || candidate.byteSize < 1 || candidate.byteSize > MAX_IMAGE_BYTES
    || typeof candidate.alt !== 'string' || candidate.alt.length > 1000) throw new Error('图片候选内容无效。')
  return {
    id: candidate.id, revisionId, kind: candidate.kind, path: candidate.path, sha256: candidate.sha256,
    contentType: candidate.contentType, byteSize: candidate.byteSize, alt: candidate.alt,
  }
}

function assertRevision(revisionId: string): void { if (typeof revisionId !== 'string' || !HASH.test(revisionId)) throw new Error('文章版本无效，请重新打开。') }
function containsControl(value: string): boolean { return [...value].some(character => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127) }
function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
