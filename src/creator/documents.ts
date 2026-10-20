import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, rmdir } from 'node:fs/promises'
import { platform } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { validateArtifactRelativePath } from '../workspace/artifact-store.ts'
import type { ArtifactStore } from '../workspace/artifact-store.ts'
import { ImagePlanStateStore } from '../workspace/image-plan-state.ts'
import { selectImageCandidates } from './image-choices.ts'
import type { CreatorDocumentRevision, CreatorDocumentV1, CreatorImageCandidate } from './types.ts'

const HASH = /^[a-f0-9]{64}$/u
const ARTICLE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const MAX_DOCUMENT_BYTES = 128 * 1024
const MAX_ARTICLES = 100
const MAX_AUTHORITY_ENTRIES = 100_000
const encoder = new TextEncoder()
export interface CreatorDeliveryBarrier { kind: 'materials' | 'draft'; token: string }
const decoder = new TextDecoder('utf-8', { fatal: true })
/** Serialize host-local saves across store instances, including competing ownership claims. */
const saves = new Map<string, Promise<void>>()

/** Strict data-only parser. References are not evidence of access, review, or upload approval. */
export function parseCreatorDocument(value: unknown): CreatorDocumentV1 {
  const record = plainRecord(value)
  exactKeys(record, ['schemaVersion', 'articleId', 'ownerSessionId', 'sourcePath', 'sourceSha256', 'title', 'revision', 'theme', 'imageCandidates', 'coverId', 'undo', 'version', 'updatedAt'])
  if (record.schemaVersion !== 1) throw new TypeError('creator document schema version is invalid')
  const articleId = validateArticleId(record.articleId)
  const ownerSessionId = validateOwner(record.ownerSessionId)
  const sourcePath = canonicalPath(record.sourcePath, 4096, 'source')
  const sourceSha256 = validateHash(record.sourceSha256, 'source hash')
  if (typeof record.title !== 'string' || record.title.length > 500 || hasControl(record.title)) throw new TypeError('creator document title is invalid')
  const revision = parseRevision(record.revision)
  if (typeof record.theme !== 'string' || !/^[\w-]{1,100}$/u.test(record.theme)) throw new TypeError('creator document theme is invalid')
  if (!Array.isArray(record.imageCandidates) || record.imageCandidates.length > 24) throw new TypeError('creator document candidate limit is 24')
  const imageCandidates = record.imageCandidates.map(value => {
    const candidate = plainRecord(value)
    exactKeys(candidate, ['id', 'revisionId', 'kind', 'path', 'sha256', 'contentType', 'byteSize', 'alt'])
    canonicalPath(candidate.path, 1200, 'candidate')
    validateHash(candidate.sha256, 'candidate hash')
    return { ...candidate } as unknown as CreatorImageCandidate
  })
  if (typeof record.coverId !== 'string' || record.coverId.length > 128) throw new TypeError('creator document cover identity is invalid')
  // Reuse the existing candidate identity, format, revision, and selection validation.
  selectImageCandidates(revision.id, imageCandidates, { bodyIds: [], ...(record.coverId ? { coverId: record.coverId } : {}) })
  if (!Array.isArray(record.undo) || record.undo.length > 20) throw new TypeError('creator document undo limit is 20')
  const undo = record.undo.map(parseRevision)
  if (typeof record.version !== 'number' || !Number.isSafeInteger(record.version) || record.version < 1) throw new TypeError('creator document version is invalid')
  if (typeof record.updatedAt !== 'string') throw new TypeError('creator document timestamp is invalid')
  const date = new Date(record.updatedAt)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== record.updatedAt) throw new TypeError('creator document timestamp is invalid')
  return {
    schemaVersion: 1, articleId, ownerSessionId, sourcePath, sourceSha256, title: record.title, revision, theme: record.theme,
    imageCandidates, coverId: record.coverId, undo, version: record.version, updatedAt: record.updatedAt,
  }
}

/** Stable artifact-relative location; caller-supplied IDs can never become arbitrary paths. */
export function creatorDocumentPath(articleId: string): string { return `documents/${validateArticleId(articleId)}.json` }

/**
 * Data lives in the session ArtifactStore; immutable ownership lives only in host-private directories.
 * The owner argument must be the currently authenticated Agent.id, never a value from a request or record.
 * Current read access is enforced by the filesystem service and current write policy by ArtifactStore.
 */
export class DocumentStore {
  private readonly authority: ImagePlanStateStore
  private readonly ownerDigest: string
  constructor(private readonly store: ArtifactStore, readonly stateDir: string, readonly ownerSessionId: string, private readonly authorizeDeliveryMutation?: (signal?: AbortSignal) => Promise<void>) {
    this.authority = new ImagePlanStateStore(stateDir)
    this.ownerDigest = digest(`creator-document-owner/v1\0${validateOwner(ownerSessionId)}`)
  }

  /** List only this authenticated session's bound records. Missing private state is not created. */
  async list(signal?: AbortSignal): Promise<CreatorDocumentV1[]> {
    const root = await this.initialize(false, signal)
    if (root === undefined) return []
    const records: CreatorDocumentV1[] = []
    for (const articleId of await this.ownedIds(root, signal)) {
      const record = await this.read(articleId, signal)
      if (record !== undefined) records.push(record)
    }
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.articleId.localeCompare(right.articleId))
  }

  /** Revalidate private ownership before any workspace record read; orphan JSON is never adopted. */
  async read(articleId: string, signal?: AbortSignal): Promise<CreatorDocumentV1 | undefined> {
    validateArticleId(articleId)
    const root = await this.initialize(false, signal)
    if (root === undefined) return undefined
    const owner = await this.binding(root, articleId, signal)
    if (owner === undefined) return undefined
    if (owner !== this.ownerDigest) throw new Error('creator document owner does not match the authenticated session')
    let bytes: Uint8Array
    try { bytes = await this.store.readBounded(creatorDocumentPath(articleId), MAX_DOCUMENT_BYTES, signal) }
    catch (error) { if (isMissing(error)) return undefined; throw error }
    const document = parseCreatorDocument(JSON.parse(decoder.decode(bytes)))
    if (document.articleId !== articleId || document.ownerSessionId !== this.ownerSessionId) throw new Error('creator document owner or article identity does not match its trusted binding')
    await this.assertSourcePath(document.sourcePath, signal)
    // A changed private binding cannot authorize a result read earlier in this operation.
    if (await this.binding(root, articleId, signal) !== this.ownerDigest) throw new Error('creator document owner binding changed during read')
    signal?.throwIfAborted()
    return document
  }

  /** Atomically replace one bounded record only after separately binding its authenticated owner. */
  async save(value: CreatorDocumentV1, signal?: AbortSignal): Promise<void> {
    const document = parseCreatorDocument(value)
    if (document.ownerSessionId !== this.ownerSessionId) throw new Error('creator document owner does not match the authenticated session')
    await this.assertSourcePath(document.sourcePath, signal)
    const bytes = encoder.encode(`${JSON.stringify(document)}\n`)
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new TypeError('creator document exceeds its byte limit')
    const root = (await this.initialize(true, signal))!
    await serialize(root, async () => {
      signal?.throwIfAborted()
      const owner = await this.binding(root, document.articleId, signal)
      if (owner !== undefined && owner !== this.ownerDigest) throw new Error('creator document owner does not match its trusted binding')
      const owned = await this.ownedIds(root, signal)
      if (owned.length >= MAX_ARTICLES) {
        let stored = 0; let replacing = false
        for (const articleId of owned) {
          try {
            await this.store.readBounded(creatorDocumentPath(articleId), MAX_DOCUMENT_BYTES, signal)
            stored++; if (articleId === document.articleId) replacing = true
          } catch (error) { if (!isMissing(error)) throw error }
        }
        if (stored >= MAX_ARTICLES && !replacing) throw new Error('creator document limit is 100 articles per session')
      }
      if (owner === undefined) {
        // Existing workspace JSON cannot establish ownership, even when it claims this session.
        try {
          await this.store.readBounded(creatorDocumentPath(document.articleId), MAX_DOCUMENT_BYTES, signal)
          throw new Error('creator document is unbound; choose a new article identity instead of adopting workspace JSON')
        } catch (error) { if (!isMissing(error)) throw error }
        const articleRoot = join(root, document.articleId)
        await ensurePrivateAncestry(this.stateDir, articleRoot, true, signal)
        const terminal = join(articleRoot, this.ownerDigest)
        await mkdir(terminal, { mode: 0o700 }).catch(error => { if (!isExists(error)) throw error })
        await syncDirectory(articleRoot)
      }
      if (await this.binding(root, document.articleId, signal) !== this.ownerDigest) throw new Error('creator document owner binding could not be verified')
      await this.assertSourcePath(document.sourcePath, signal)
      await this.store.writeAtomic(creatorDocumentPath(document.articleId), bytes, signal)
    })
  }

  /** Host-private crash barrier, never inferred from editable document data or old approval. */
  async deliveryStatus(articleId: string, signal?: AbortSignal): Promise<CreatorDeliveryBarrier | undefined> {
    const root = await this.deliveryRoot(articleId, false, signal)
    return root === undefined ? undefined : this.readDeliveryBarrier(root, signal)
  }
  async beginDelivery(articleId: string, kind: CreatorDeliveryBarrier['kind'], signal?: AbortSignal): Promise<string> {
    if (kind !== 'materials' && kind !== 'draft') throw new TypeError('creator delivery kind is invalid')
    await this.authorizeDeliveryMutation?.(signal)
    const root = (await this.deliveryRoot(articleId, true, signal))!
    const token = `${kind}-${randomUUID()}`
    await serialize(root, async () => {
      if (await this.readDeliveryBarrier(root, signal)) throw new Error('微信交付结果尚未核对，请先到公众号后台核对后明确确认。')
      signal?.throwIfAborted()
      await this.authorizeDeliveryMutation?.(signal)
      const pending = join(root, 'pending')
      // The exclusive parent is the crash marker, including a crash before the token is created.
      await mkdir(pending, { mode: 0o700 })
      await syncDirectory(root)
      await mkdir(join(pending, token), { mode: 0o700 })
      await syncDirectory(pending)
    })
    return token
  }
  /** Clear only our own completed (or definitely never started) attempt, not another attempt. */
  async completeDelivery(articleId: string, token: string, signal?: AbortSignal): Promise<void> {
    const root = await this.deliveryRoot(articleId, false, signal)
    if (root === undefined) return
    await serialize(root, async () => {
      const status = await this.readDeliveryBarrier(root, signal)
      if (!status) return
      if (!token || status.token !== token) throw new Error('creator delivery attempt no longer matches its private barrier')
      await this.removeDeliveryBarrier(root, status, signal)
    })
  }
  /** Explicit user reconciliation only; it neither changes remote ledgers nor grants authority. */
  async reconcileDelivery(articleId: string, signal?: AbortSignal): Promise<void> {
    const root = await this.deliveryRoot(articleId, false, signal)
    if (root === undefined) return
    await serialize(root, async () => {
      const status = await this.readDeliveryBarrier(root, signal)
      if (status) await this.removeDeliveryBarrier(root, status, signal)
    })
  }
  private async deliveryRoot(articleId: string, create: boolean, signal?: AbortSignal): Promise<string | undefined> {
    validateArticleId(articleId)
    const authority = await this.initialize(false, signal)
    if (authority === undefined || await this.binding(authority, articleId, signal) !== this.ownerDigest) throw new Error('creator delivery owner does not match the authenticated session')
    const root = join(this.stateDir, 'creator-deliveries', basename(authority), articleId, this.ownerDigest)
    try { await ensurePrivateAncestry(this.stateDir, root, create, signal) }
    catch (error) { if (!create && isMissing(error)) return undefined; throw error }
    return root
  }
  private async readDeliveryBarrier(root: string, signal?: AbortSignal): Promise<CreatorDeliveryBarrier | undefined> {
    await ensurePrivateAncestry(this.stateDir, root, false, signal)
    const entries = await readdir(root, { withFileTypes: true })
    if (!entries.length) return undefined
    if (entries.length !== 1 || entries[0]!.name !== 'pending' || !entries[0]!.isDirectory() || entries[0]!.isSymbolicLink()) throw new Error('creator delivery barrier is invalid')
    const pending = join(root, 'pending')
    await ensurePrivateAncestry(this.stateDir, pending, false, signal)
    const attempts = await readdir(pending, { withFileTypes: true })
    if (!attempts.length) return { kind: 'materials', token: '' }
    const attempt = attempts[0]!
    if (attempts.length !== 1 || !attempt.isDirectory() || attempt.isSymbolicLink() || !/^(materials|draft)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(attempt.name)) throw new Error('creator delivery attempt is invalid')
    await ensurePrivateAncestry(this.stateDir, join(pending, attempt.name), false, signal)
    if ((await readdir(join(pending, attempt.name))).length) throw new Error('creator delivery attempt must be empty')
    return { kind: attempt.name.startsWith('draft-') ? 'draft' : 'materials', token: attempt.name }
  }
  private async removeDeliveryBarrier(root: string, status: CreatorDeliveryBarrier, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await this.authorizeDeliveryMutation?.(signal)
    const pending = join(root, 'pending')
    if (status.token) { await rmdir(join(pending, status.token)); await syncDirectory(pending) }
    await rmdir(pending); await syncDirectory(root)
  }

  private async initialize(create: boolean, signal?: AbortSignal): Promise<string | undefined> {
    let workspaceId: string
    try { workspaceId = await this.authority.initialize(this.store, create, signal) }
    catch (error) { if (!create && isMissing(error)) return undefined; throw error }
    const root = join(this.stateDir, 'creator-documents', workspaceId)
    try { await ensurePrivateAncestry(this.stateDir, root, create, signal) }
    catch (error) { if (!create && isMissing(error)) return undefined; throw error }
    return root
  }

  private async ownedIds(root: string, signal?: AbortSignal): Promise<string[]> {
    await ensurePrivateAncestry(this.stateDir, root, false, signal)
    const entries = await readdir(root, { withFileTypes: true })
    if (entries.length > MAX_AUTHORITY_ENTRIES) throw new Error('creator document authority contains too many entries')
    const owned: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !ARTICLE_ID.test(entry.name)) throw new Error('creator document authority contains an invalid directory or link')
      if (await this.binding(root, entry.name, signal) === this.ownerDigest) owned.push(entry.name)
    }
    return owned
  }

  private async binding(root: string, articleId: string, signal?: AbortSignal): Promise<string | undefined> {
    const articleRoot = join(root, articleId)
    try { await ensurePrivateAncestry(this.stateDir, articleRoot, false, signal) }
    catch (error) { if (isMissing(error)) return undefined; throw error }
    const entries = await readdir(articleRoot, { withFileTypes: true })
    if (entries.length === 0) return undefined // An interrupted claim grants no ownership.
    if (entries.length !== 1 || !entries[0]!.isDirectory() || entries[0]!.isSymbolicLink() || !HASH.test(entries[0]!.name)) throw new Error('creator document owner authority is conflicting or invalid')
    const terminal = join(articleRoot, entries[0]!.name)
    await ensurePrivateAncestry(this.stateDir, terminal, false, signal)
    if ((await readdir(terminal)).length !== 0) throw new Error('creator document owner authority terminal must be empty')
    return entries[0]!.name
  }

  private async assertSourcePath(path: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const root = await this.store.fs.resolve(this.store.workspace, signal === undefined ? undefined : { signal })
    const target = await this.store.fs.resolve(path, { cwd: this.store.workspace, ...(signal === undefined ? {} : { signal }) })
    if (!this.store.fs.contains(root, target)) throw new Error('creator document source path escapes the current workspace')
    const canonical = relative(this.store.fs.processPath(root), this.store.fs.processPath(target)).split(sep).join('/')
    if (canonical !== path) throw new Error('creator document source path is not canonical within the current workspace')
  }
}

function parseRevision(value: unknown): CreatorDocumentRevision {
  const revision = plainRecord(value); exactKeys(revision, ['id', 'manifestPath'])
  const id = validateHash(revision.id, 'revision identity')
  if (revision.manifestPath !== `revisions/${id}/manifest.json`) throw new TypeError('creator document revision manifest path is invalid')
  return { id, manifestPath: revision.manifestPath }
}
function canonicalPath(value: unknown, maxLength: number, kind: string): string {
  if (typeof value !== 'string' || value.length > maxLength || value.normalize('NFC') !== value || /\\/u.test(value) || hasControl(value)) throw new TypeError(`creator document ${kind} path is invalid`)
  validateArtifactRelativePath(value)
  return value
}
function validateArticleId(value: unknown): string { if (typeof value !== 'string' || !ARTICLE_ID.test(value)) throw new TypeError('creator document article identity is invalid'); return value }
function validateOwner(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 200 || value.trim() !== value || hasControl(value)) throw new TypeError('creator document owner identity is invalid'); return value }
function validateHash(value: unknown, kind: string): string { if (typeof value !== 'string' || !HASH.test(value)) throw new TypeError(`creator document ${kind} is invalid`); return value }
function plainRecord(value: unknown): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('creator document JSON must be a plain object'); return value as Record<string, unknown> }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void { if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) throw new TypeError('creator document fields are invalid') }
function hasControl(value: string): boolean { return [...value].some(character => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127) }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'FS_NOT_FOUND') }
function isExists(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'EEXIST' }

/** Reuse the established state stores' directory-only, owner-only, no-symlink safeguards. */
async function ensurePrivateAncestry(root: string, path: string, create: boolean, signal?: AbortSignal): Promise<void> {
  const canonicalRoot = await realpath(root); const child = relative(canonicalRoot, resolve(path))
  if (child === '' || child.startsWith('..') || isAbsolute(child)) throw new Error('creator document authority escapes stateDir')
  let current = canonicalRoot
  for (const component of child.split(sep)) {
    signal?.throwIfAborted(); current = join(current, component)
    if (create) await mkdir(current, { mode: 0o700 }).catch(error => { if (!isExists(error)) throw error })
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('creator document authority must contain directories only')
    if (platform() !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('creator document authority directory permissions are not private')
    if (platform() !== 'win32' && typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('creator document authority directory owner is invalid')
    if (await realpath(current) !== current) throw new Error('creator document authority uses a symlink or reparse point')
  }
}
async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try { handle = await open(path, 'r'); await handle.sync() }
  catch (error) { if (!(error instanceof Error && 'code' in error && ['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(String(error.code)))) throw error }
  finally { await handle?.close() }
}
async function serialize(key: string, action: () => Promise<void>): Promise<void> {
  const previous = saves.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(action)
  saves.set(key, next)
  try { await next } finally { if (saves.get(key) === next) saves.delete(key) }
}
