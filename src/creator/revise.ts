import { createHash } from 'node:crypto'
import type { ArtifactReadAuthorization, ArtifactStore } from '../workspace/artifact-store.ts'
import { computeArticleRevision } from '../workspace/revision.ts'
import type { ArticleManifest } from '../workspace/revision.ts'
import { discoverMarkdownImageDestinations, preparePreviewInputs, resolveLocalImagePath } from '../tools/preview.ts'
import type { CreatorRevision } from './session.ts'
import { verifyImageCandidate } from './image-choices.ts'
import type { ImageCandidate } from './image-choices.ts'

const MAX_MARKDOWN_BYTES = 8 * 1024 * 1024

/**
 * Save an exact user-selected edit as a new revision, without reusing preview authority.
 * approvedImages is the server-owned candidate collection, never unchecked Remote input.
 */
export async function reviseCreatorArticle(
  store: ArtifactStore,
  previous: CreatorRevision,
  markdown: string,
  signal: AbortSignal,
  approvedImages: readonly ImageCandidate[] = [],
): Promise<CreatorRevision> {
  signal.throwIfAborted()
  if (typeof markdown !== 'string' || !markdown.isWellFormed()) throw new Error('文章必须是有效的 Unicode Markdown。')
  if (markdown.startsWith('\uFEFF')) throw new Error('文章开头含有 BOM，请先移除 BOM 后再保存；原文未更改。')
  if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) throw new Error('article exceeds the 8-MiB limit')
  const bytes = new TextEncoder().encode(markdown)
  const manifestBytes = await store.readBounded(previous.manifestPath, MAX_MARKDOWN_BYTES, signal)
  const manifestAuthorization = await store.authorizeRead(previous.manifestPath, sha256(manifestBytes), signal)
  const prepared = await preparePreviewInputs(store, previous.manifestPath, signal)
  const current = prepared.current
  if (current.revision.id !== previous.id
    || !Buffer.from(current.articleBytes).equals(Buffer.from(previous.markdown, 'utf8'))) {
    throw new Error('stale creator revision: article changed before saving')
  }

  const allowedDestinations = new Set(discoverMarkdownImageDestinations(current.articleBytes))
  const destinations = discoverMarkdownImageDestinations(bytes)
  if (!Array.isArray(approvedImages) || approvedImages.length > 128) throw new Error('图片候选过多，请重新选择。')
  const candidates: Array<{ source: string; bytes: Uint8Array; authorization: ArtifactReadAuthorization }> = []
  for (const candidate of approvedImages) {
    const image = await verifyImageCandidate(store, previous.id, candidate, signal)
    const authorization = await store.authorizeRead(image.path, image.sha256, signal)
    const imageBytes = await store.readBounded(image.path, image.byteSize, signal)
    if (imageBytes.byteLength !== image.byteSize || sha256(imageBytes) !== image.sha256) throw new Error('图片候选已经变化，请重新导入。')
    const source = image.path.slice(`revisions/${previous.id}/`.length)
    allowedDestinations.add(source)
    candidates.push({ source, bytes: imageBytes, authorization })
  }
  if (destinations.some(destination => !allowedDestinations.has(destination))) throw new Error('新增图片尚未确认，请先使用原文中的图片。')
  // Raw HTML images bypass Markdown destination discovery, so do not introduce them through an edit.
  const previousHtmlImages = new Set(htmlImages(previous.markdown))
  if (htmlImages(markdown).some(tag => !previousHtmlImages.has(tag))) throw new Error('新增 HTML 图片尚未确认，请使用 Markdown 图片。')
  const retained = prepared.localImages.filter(image => destinations.includes(image.source))
  const localDestinations = new Set<string>()
  for (const destination of destinations) {
    if (/^https?:\/\//u.test(destination) || destination.startsWith('__generate:')) continue
    const key = resolveLocalImagePath(`revisions/${previous.id}`, destination).normalize('NFC').toLowerCase()
    if (localDestinations.has(key)) throw new Error('preview local images contain duplicate aliases')
    localDestinations.add(key)
  }
  const copies = new Map<string, { source: string; bytes: Uint8Array; authorizations: ArtifactReadAuthorization[] }>()
  for (const image of [...retained, ...candidates]) {
    const source = resolveLocalImagePath('revision', image.source).slice('revision/'.length)
    const key = source.normalize('NFC').toLowerCase()
    const existing = copies.get(key)
    if (existing) {
      if (existing.source !== source || sha256(existing.bytes) !== sha256(image.bytes)) throw new Error('image candidate aliases contain different bytes or paths')
      existing.authorizations.push(image.authorization)
    } else copies.set(key, { source, bytes: image.bytes, authorizations: [image.authorization] })
  }

  const heading = firstHeading(markdown)
  const title = heading && heading !== firstHeading(previous.markdown) ? heading : previous.title
  const manifest: ArticleManifest = {
    schemaVersion: 1,
    articlePath: 'article.md',
    manifestPath: 'manifest.json',
    createdAt: new Date().toISOString(),
    parentRevisionId: current.revision.id,
    title,
  }
  const revision = computeArticleRevision(bytes, manifest)
  const root = `revisions/${revision.id}`
  const articlePath = `${root}/article.md`
  const manifestPath = `${root}/manifest.json`
  const outputs: ArtifactReadAuthorization[] = []
  await publishImmutable(store, articlePath, bytes, signal)
  outputs.push(await store.authorizeRead(articlePath, sha256(bytes), signal))
  for (const image of copies.values()) {
    for (const authorization of image.authorizations) await authorization.beforeSpawn(signal)
    const path = resolveLocalImagePath(root, image.source)
    await publishImmutable(store, path, image.bytes, signal)
    outputs.push(await store.authorizeRead(path, sha256(image.bytes), signal))
  }

  // The manifest is the commit marker. Authenticate every input and copied output again before it exists.
  await manifestAuthorization.beforeSpawn(signal)
  await current.articleAuthorization.beforeSpawn(signal)
  for (const image of copies.values()) for (const authorization of image.authorizations) await authorization.beforeSpawn(signal)
  for (const output of outputs) await output.beforeSpawn(signal)
  signal.throwIfAborted()
  await publishImmutable(store, manifestPath, new TextEncoder().encode(`${JSON.stringify(manifest)}\n`), signal)
  return { id: revision.id, manifestPath, title, markdown }
}

async function publishImmutable(store: ArtifactStore, path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  try { await store.createExclusive(path, bytes, signal) }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ARTIFACT_EXISTS')) throw error
    if (sha256(await store.read(path, signal)) !== sha256(bytes)) throw new Error('existing immutable revision contains different bytes')
  }
}

function firstHeading(markdown: string): string | undefined {
  let fence: string | undefined
  for (const line of markdown.split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined
      continue
    }
    if (marker) { fence = marker[1]; continue }
    const heading = /^ {0,3}#[ \t]+(.+)$/u.exec(line)?.[1]?.replace(/[ \t]+#+[ \t]*$/u, '').trim()
    if (heading) return heading
  }
  return undefined
}

function htmlImages(markdown: string): string[] {
  return markdown.match(/<\s*(?:img|image|source)\b[^>]*>/giu) ?? []
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
