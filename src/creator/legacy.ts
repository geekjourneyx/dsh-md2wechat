import { relative } from 'node:path'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { ArtifactStore } from '../workspace/artifact-store.ts'
import { validateRevisionManifest } from '../workspace/revision.ts'
import { creatorErrorInfo, creatorRemoteError } from './errors.ts'
import type { CreatorRevisionSummary } from './types.ts'

const MANIFEST = /^revisions\/([a-f0-9]{64})\/manifest\.json$/u
const MAX_CANDIDATES = 100
const MAX_MANIFEST_BYTES = 16 * 1024
export const LEGACY_RECOVERY_MESSAGE = '已恢复所选保存版本。旧版本没有保存原文路径，现以该版本的 article.md 为来源；原主题、封面和候选选择、撤回历史无法确认，已使用可用主题。历史授权、预览证明和未完成请求不会恢复；历史交付结果未知，请先到公众号后台核对，不会自动重试。'

export function legacyRevisionSource(artifactRoot: string, manifestPath: string): string {
  const match = MANIFEST.exec(manifestPath)
  if (!match) throw new Error('manifestPath must match revisions/<revision-id>/manifest.json')
  return `${artifactRoot}/revisions/${match[1]!}/article.md`
}
export function isLegacyRevisionSource(artifactRoot: string, sourcePath: string): boolean {
  return sourcePath.startsWith(`${artifactRoot}/revisions/`) && /^[a-f0-9]{64}\/article\.md$/u.test(sourcePath.slice(`${artifactRoot}/revisions/`.length))
}

/** Bind one canonical direct revision directory; never follow a link into another subtree. */
export async function bindLegacyRevision(store: ArtifactStore, manifestPath: string, signal: AbortSignal): Promise<() => Promise<void>> {
  const match = MANIFEST.exec(manifestPath)
  if (!match) throw new Error('manifestPath must match revisions/<revision-id>/manifest.json')
  const root = await containedTarget(store, 'revisions', signal)
  const directoryPath = `revisions/${match[1]!}`
  const directory = await containedTarget(store, directoryPath, signal)
  if (!store.fs.contains(root, directory) || relative(store.fs.processPath(root), store.fs.processPath(directory)) !== match[1]) throw new Error('legacy revision must be a direct contained directory')
  await store.assertContainedWithin(directoryPath, manifestPath, signal)
  await store.assertContainedWithin(directoryPath, `${directoryPath}/article.md`, signal)
  return async () => {
    if ((await containedTarget(store, 'revisions', signal)).targetKey !== root.targetKey
      || (await containedTarget(store, directoryPath, signal)).targetKey !== directory.targetKey) throw new Error('legacy revision directory changed during recovery')
    await store.assertContainedWithin(directoryPath, manifestPath, signal)
    await store.assertContainedWithin(directoryPath, `${directoryPath}/article.md`, signal)
  }
}

/** Metadata-only, single-level discovery. Full identity and image validation happens on explicit recovery. */
export async function discoverLegacyRevisions(store: ArtifactStore, signal: AbortSignal): Promise<CreatorRevisionSummary[]> {
  signal.throwIfAborted()
  const root = await containedTarget(store, 'revisions', signal)
  const info = await store.fs.stat(root, signal)
  if (!info) return []
  if (info.type !== 'directory') throw new Error('legacy revision root is not a directory')
  const entries = await store.fs.listDir(root, signal)
  const candidates = entries.filter(entry => entry.type === 'directory' && /^[a-f0-9]{64}$/u.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_CANDIDATES)
  const summaries: CreatorRevisionSummary[] = []
  for (const entry of candidates) {
    signal.throwIfAborted()
    if (!store.fs.contains(root, entry.target) || relative(store.fs.processPath(root), store.fs.processPath(entry.target)) !== entry.name) continue
    const manifestPath = `revisions/${entry.name}/manifest.json`
    try {
      const verify = await bindLegacyRevision(store, manifestPath, signal)
      const manifestIdentity = await store.canonicalIdentity(manifestPath, signal)
      const manifest = validateRevisionManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await store.readBounded(manifestPath, MAX_MANIFEST_BYTES, signal))))
      if (manifest.articlePath !== 'article.md' || manifest.manifestPath !== 'manifest.json'
        || (manifest.title !== undefined && (manifest.title.length > 500 || [...manifest.title].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)))) continue
      await verify()
      if (await store.canonicalIdentity(manifestPath, signal) !== manifestIdentity) throw new Error('legacy revision directory changed during recovery')
      summaries.push({ revisionId: entry.name, manifestPath, title: manifest.title ?? '已保存文章', createdAt: manifest.createdAt })
    } catch (error) {
      signal.throwIfAborted()
      const safe = creatorRemoteError(error, 'ARTIFACT_INVALID')
      if (creatorErrorInfo(safe).code !== 'ARTIFACT_INVALID') throw safe
      // A corrupt/missing individual candidate cannot justify scanning elsewhere or reading its body.
    }
  }
  if ((await containedTarget(store, 'revisions', signal)).targetKey !== root.targetKey) throw new Error('legacy revision directory changed during recovery')
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.revisionId.localeCompare(b.revisionId))
}
async function containedTarget(store: ArtifactStore, path: string, signal: AbortSignal): Promise<FsTarget> {
  const identity = await store.canonicalIdentity(path, signal)
  const target = await store.fs.resolve(store.resolve(path), { signal })
  if (target.targetKey !== identity) throw new Error('legacy revision directory changed during recovery')
  if (path === 'revisions') {
    const artifactRoot = await store.fs.resolve(store.rootRelative, { cwd: store.workspace, signal })
    if (!store.fs.contains(artifactRoot, target) || relative(store.fs.processPath(artifactRoot), store.fs.processPath(target)) !== 'revisions') throw new Error('legacy revision must be a direct contained directory')
  }
  return target
}
