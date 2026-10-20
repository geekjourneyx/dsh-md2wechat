import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ArtifactStore } from '../workspace/artifact-store.ts'
import { validateImageBytes } from '../workspace/images.ts'
import type { SupportedImageMime } from '../workspace/images.ts'
import { verifyImageCandidate } from './image-choices.ts'
import type { ImageCandidate } from './image-choices.ts'

export interface CreatorImageImportDependencies { fs: Context['fs']; workspace: string; store: ArtifactStore }

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const formats: ReadonlyArray<{ contentType: SupportedImageMime; extension: string }> = [
  { contentType: 'image/png', extension: 'png' },
  { contentType: 'image/jpeg', extension: 'jpg' },
  { contentType: 'image/gif', extension: 'gif' },
  { contentType: 'image/webp', extension: 'webp' },
]

/** Import an already-authorized local file; never generate, download, or upload an image. */
export async function importCreatorImage(
  { fs, workspace, store }: CreatorImageImportDependencies,
  revisionId: string,
  sourcePath: string,
  kind: ImageCandidate['kind'],
  alt: string,
  signal: AbortSignal,
): Promise<ImageCandidate> {
  signal.throwIfAborted()
  if (typeof revisionId !== 'string' || !/^[a-f0-9]{64}$/u.test(revisionId)) throw new Error('文章版本无效。')
  if (kind !== 'cover' && kind !== 'body') throw new Error('图片用途无效。')
  if (typeof sourcePath !== 'string' || !sourcePath.trim() || sourcePath.length > 4096
    || /^[a-z][a-z\d+.-]*:/iu.test(sourcePath) || hasControl(sourcePath)) throw new Error('请选择当前工作区中的本地图片。')
  if (typeof alt !== 'string' || alt.length > 16_000) throw new Error('图片说明过长。')
  const root = await fs.resolve(workspace, { signal })
  const source = await fs.resolve(sourcePath, { cwd: workspace, signal })
  if (!fs.contains(root, source)) throw new Error('图片必须位于当前会话工作区内。')
  const info = await fs.stat(source, signal)
  if (!info || info.type !== 'file') throw new Error('图片不存在或不是普通文件。')
  if (info.size !== undefined && info.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 8 MiB。')
  const bytes = await fs.readBytes(source, signal, MAX_IMAGE_BYTES)
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 8 MiB。')
  const sha256 = digest(bytes)
  const format = formats.find(format => {
    try { validateImageBytes(format.contentType, bytes); return true } catch { return false }
  })
  if (!format) throw new Error('图片格式不支持，请选择 PNG、JPEG、GIF 或 WebP。')
  const image: ImageCandidate = {
    id: `creator-${kind}-${sha256}`, revisionId, kind,
    path: `revisions/${revisionId}/images/creator-${sha256}.${format.extension}`,
    sha256, byteSize: bytes.byteLength, contentType: format.contentType,
    alt: [...alt].map(character => hasControl(character) ? ' ' : character).join('').trim().slice(0, 500).toWellFormed(),
  }
  const recheck = async (): Promise<void> => {
    signal.throwIfAborted()
    const currentRoot = await fs.resolve(workspace, { signal })
    const currentSource = await fs.resolve(sourcePath, { cwd: workspace, signal })
    if (currentRoot.targetKey !== root.targetKey || !fs.contains(currentRoot, currentSource)
      || currentSource.targetKey !== source.targetKey) throw new Error('图片位置已经变化，请重新导入。')
    const currentInfo = await fs.stat(currentSource, signal)
    if (!currentInfo || currentInfo.type !== 'file' || currentInfo.version !== info.version) throw new Error('图片已经变化，请重新导入。')
    const currentBytes = await fs.readBytes(currentSource, signal, MAX_IMAGE_BYTES)
    if (currentBytes.byteLength !== bytes.byteLength || digest(currentBytes) !== sha256) throw new Error('图片内容已经变化，请重新导入。')
    const finalSource = await fs.resolve(sourcePath, { cwd: workspace, signal })
    const finalInfo = await fs.stat(finalSource, signal)
    if (finalSource.targetKey !== source.targetKey || finalInfo?.type !== 'file' || finalInfo.version !== info.version) throw new Error('图片已经变化，请重新导入。')
  }
  await recheck()
  try { await store.createExclusive(image.path, bytes, signal) }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ARTIFACT_EXISTS')) throw error
    const existing = await store.readBounded(image.path, MAX_IMAGE_BYTES, signal)
    if (existing.byteLength !== bytes.byteLength || digest(existing) !== sha256) throw new Error('existing immutable image contains different bytes')
  }
  // A late source change invalidates the returned choice. Never delete reusable content-addressed bytes.
  await recheck()
  return verifyImageCandidate(store, revisionId, image, signal)
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function hasControl(value: string): boolean { return [...value].some(character => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127) }
