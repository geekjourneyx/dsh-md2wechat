import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { PLUGIN_VERSION } from '../version.ts'
import { validateArtifactId, validateArtifactRelativePath } from './artifact-store.ts'
import type { ArtifactPublicationOwnership, ArtifactStore } from './artifact-store.ts'

const PREVIEW_SCHEMA_VERSION = 1
const PROOF_KEY_LABEL = 'dsh-md2wechat/preview-proof-key/v1'
const ACCOUNT_PROVENANCE_LABEL = 'dsh-md2wechat/preview-account-provenance/v1'
const MAX_PREVIEW_HTML_BYTES = 8 * 1024 * 1024
const publicationQueues = new Map<string, Promise<void>>()

/** One local Markdown image bound into preview freshness. */
export interface PreviewLocalImage {
  path: string
  sha256: string
}

/** Expected rendering choices that affect preview currentness. */
export interface PreviewSettings {
  mode: 'api'
  theme: string
  fontSize: 'small' | 'medium' | 'large'
  backgroundType: 'default' | 'grid' | 'none'
  output: string
}

/** Safe, deterministic state of every input used for one preview. */
export interface PreviewSnapshot {
  schemaVersion: 1
  id: string
  revisionId: string
  articlePath: string
  articleSha256: string
  localImages: readonly PreviewLocalImage[]
  transformations: {
    layoutBaseUrl: string
    preview: PreviewSettings
  }
  accountProvenance: string
  pluginVersion: string
  cliVersion: string
}

/** Inputs used to create or re-create one preview snapshot. */
export interface PreviewSnapshotInput {
  revisionId: string
  articlePath: string
  articleBytes: Uint8Array
  localImages: readonly { path: string; bytes: Uint8Array }[]
  layoutBaseUrl: string
  previewSettings: PreviewSettings
  credentialReference: string
  credentialValue: string
  pluginVersion: string
  cliVersion: string
}

/** Signed proof that one preview HTML artifact belongs to one exact snapshot. */
export interface PreviewReceipt {
  schemaVersion: 1
  id: string
  snapshotId: string
  revisionId: string
  previewHtmlPath: string
  previewHtmlSha256: string
  metadata: PreviewMetadata
  assets: readonly PreviewAsset[]
  accountProvenance: string
  issuedAt: string
  expiresAt: string
  pluginVersion: string
  cliVersion: string
  signature: string
}

/** Strict article metadata signed by the preview receipt for later draft creation. */
export interface PreviewMetadata { title: string; author: string; digest: string }

/** Ordered Markdown asset inventory signed without retaining process paths. */
export type PreviewAsset =
  | { index: number; kind: 'local'; source: string; path: string; sha256: string }
  | { index: number; kind: 'online'; source: string }
  | { index: number; kind: 'ai'; source: string }

/** Per-attempt ownership proof for each content-addressed preview artifact. */
export interface PreviewPublicationOwnership {
  html: ArtifactPublicationOwnership
  snapshot: ArtifactPublicationOwnership
  receipt: ArtifactPublicationOwnership
}

/** Explicit lifecycle for one preview publication attempt. */
export type PreviewTransaction =
  | { state: 'prepared'; snapshot: PreviewSnapshot }
  | { state: 'published'; snapshot: PreviewSnapshot; receipt: PreviewReceipt; ownership: PreviewPublicationOwnership }
  | { state: 'committed'; snapshot: PreviewSnapshot; receipt: PreviewReceipt; ownership: PreviewPublicationOwnership; manifestPath: string }

/** Inputs used to create the signed receipt after staged HTML validation. */
export interface PreviewReceiptInput {
  snapshot: PreviewSnapshot
  previewHtmlPath: string
  previewHtmlBytes: Uint8Array
  credentialValue: string
  issuedAt: string
  expiresAt: string
  metadata: PreviewMetadata
  assets: readonly PreviewAsset[]
}

/** Currentness inputs that must reproduce the persisted snapshot and receipt. */
export interface CurrentPreviewInput {
  snapshotInput: PreviewSnapshotInput
  credentialValue: string
  now: Date
  signal?: AbortSignal
}

/** One fully verified current preview. */
export interface CurrentPreview {
  snapshot: PreviewSnapshot
  receipt: PreviewReceipt
  manifestPath: string
  htmlPath: string
  htmlBytes: Uint8Array
}

/** Maximum complete preview HTML accepted from the external CLI. */
export const PREVIEW_HTML_LIMIT_BYTES = MAX_PREVIEW_HTML_BYTES

/** Structurally match the current pointer and receipt before asking for approval. */
export async function preflightCurrentPreview(
  store: ArtifactStore,
  revisionId: string,
  receiptId: string,
  now: Date,
  signal?: AbortSignal,
): Promise<{ receipt: PreviewReceipt; htmlPath: string }> {
  try {
    hashString(revisionId, 'preview revision ID'); hashString(receiptId, 'preview receipt ID')
    if (Number.isNaN(now.getTime())) throw new Error('invalid current time')
    const pointer = parsePointer(await store.read(currentManifestPath(revisionId), signal), revisionId)
    if (pointer.receiptId !== receiptId) throw new Error('receipt changed')
    const receipt = parseReceipt(await store.read(pointer.receiptPath, signal))
    if (receipt.id !== receiptId || receipt.revisionId !== revisionId || receipt.previewHtmlPath !== pointer.previewHtmlPath) throw new Error('receipt changed')
    if (now.getTime() < Date.parse(receipt.issuedAt) || Date.parse(receipt.expiresAt) <= now.getTime()) throw new Error('receipt expired')
    return { receipt, htmlPath: pointer.previewHtmlPath }
  } catch {
    if (signal?.aborted) throw safePreviewValidationError('preview validation cancelled')
    throw safePreviewValidationError('stale preview')
  }
}

/**
 * Create empty per-attempt ownership proof for content-addressed preview artifacts.
 * @returns Mutable ownership flags set only by successful first publication.
 */
export function createPreviewPublicationOwnership(): PreviewPublicationOwnership {
  return {
    html: { created: false },
    snapshot: { created: false },
    receipt: { created: false },
  }
}

/**
 * Create a relocation-stable snapshot from exact article, image, transformation, account, and version inputs.
 * @param input - Complete currentness material, including credentials used only for one-way derivation.
 * @returns Safe snapshot without credential references or values.
 */
export function createPreviewSnapshot(input: PreviewSnapshotInput): PreviewSnapshot {
  validateArtifactId(input.revisionId)
  if (!/^[a-f0-9]{64}$/u.test(input.revisionId)) throw new TypeError('preview revision ID must be 64 lowercase hexadecimal characters')
  validateArtifactRelativePath(input.articlePath)
  const expectedArticlePath = `revisions/${input.revisionId}/article.md`
  if (input.articlePath !== expectedArticlePath) throw new TypeError('preview article artifact path does not match its revision')
  requiredSafeString(input.layoutBaseUrl, 'preview layout base URL')
  requiredSafeString(input.credentialReference, 'preview credential reference')
  requiredSafeString(input.credentialValue, 'preview credential value')
  requiredSafeString(input.pluginVersion, 'preview plugin version')
  requiredSafeString(input.cliVersion, 'preview CLI version')
  const settings = validatePreviewSettings(input.previewSettings)
  const prefix = `revisions/${input.revisionId}/`
  const seen = new Set<string>()
  const localImages = input.localImages.map(image => {
    requiredSafeString(image.path, 'preview image artifact path')
    validateArtifactRelativePath(image.path)
    if (!image.path.startsWith(prefix) || image.path === input.articlePath) {
      throw new TypeError('preview image artifact must stay in the same immutable revision')
    }
    const portablePath = image.path.normalize('NFC').toLowerCase()
    if (seen.has(portablePath)) throw new TypeError('preview images contain a duplicate portable artifact path')
    seen.add(portablePath)
    return { path: image.path.normalize('NFC'), sha256: sha256(image.bytes) }
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const material = {
    schemaVersion: PREVIEW_SCHEMA_VERSION,
    revisionId: input.revisionId,
    articlePath: input.articlePath,
    articleSha256: sha256(input.articleBytes),
    localImages,
    transformations: { layoutBaseUrl: input.layoutBaseUrl, preview: settings },
    accountProvenance: accountProvenance(input.credentialReference, input.credentialValue),
    pluginVersion: input.pluginVersion,
    cliVersion: input.cliVersion,
  } as const
  return { ...material, id: sha256Text(canonicalJson(material)) }
}

/**
 * Bind one validated HTML artifact to a snapshot with an expiring HMAC receipt.
 * @param input - Snapshot, HTML bytes/path, credential value, and exact validity interval.
 * @returns Safe signed receipt.
 */
export function createPreviewReceipt(input: PreviewReceiptInput): PreviewReceipt {
  const snapshot = validateSnapshot(input.snapshot)
  const expectedPath = previewHtmlPath(snapshot)
  if (input.previewHtmlPath !== expectedPath) throw new TypeError('preview HTML path does not match its snapshot')
  if (input.previewHtmlBytes.byteLength < 1 || input.previewHtmlBytes.byteLength > MAX_PREVIEW_HTML_BYTES) {
    throw new TypeError('preview HTML size is outside the allowed range')
  }
  const issuedAt = canonicalTimestamp(input.issuedAt, 'preview receipt issue time')
  const expiresAt = canonicalTimestamp(input.expiresAt, 'preview receipt expiry time')
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new TypeError('preview receipt expiry must follow its issue time')
  requiredSafeString(input.credentialValue, 'preview credential value')
  const unsigned = {
    schemaVersion: PREVIEW_SCHEMA_VERSION,
    snapshotId: snapshot.id,
    revisionId: snapshot.revisionId,
    previewHtmlPath: input.previewHtmlPath,
    previewHtmlSha256: sha256(input.previewHtmlBytes),
    metadata: validatePreviewMetadata(input.metadata),
    assets: validatePreviewAssets(input.assets, snapshot),
    accountProvenance: snapshot.accountProvenance,
    issuedAt,
    expiresAt,
    pluginVersion: snapshot.pluginVersion,
    cliVersion: snapshot.cliVersion,
  } as const
  const signature = sign(unsigned, input.credentialValue)
  const receipt = { ...unsigned, signature, id: sha256Text(canonicalJson({ ...unsigned, signature })) }
  assertReceiptBindings(snapshot, receipt)
  return receipt
}

/**
 * Publish immutable snapshot and receipt artifacts, then atomically replace the current pointer last.
 * @param store - Contained artifact store.
 * @param transaction - Published transaction whose HTML artifact already exists.
 * @param signal - Optional cancellation signal.
 * @returns Committed transaction retaining the current pointer path.
 */
export async function publishPreviewSnapshot(
  store: ArtifactStore,
  transaction: Extract<PreviewTransaction, { state: 'published' }>,
  signal?: AbortSignal,
): Promise<Extract<PreviewTransaction, { state: 'committed' }>> {
  const snapshot = validateSnapshot(transaction.snapshot)
  const receipt = validateReceipt(transaction.receipt)
  assertReceiptBindings(snapshot, receipt)
  const paths = previewPaths(snapshot, receipt)
  const html = await store.read(paths.previewHtmlPath, signal)
  if (html.byteLength < 1 || html.byteLength > MAX_PREVIEW_HTML_BYTES || sha256(html) !== receipt.previewHtmlSha256) {
    throw new Error('preview HTML does not match its signed receipt')
  }
  const identity = await store.canonicalIdentity(paths.manifestPath, signal)
  await enqueuePublication(identity, async () => {
    signal?.throwIfAborted()
    await store.writeIdenticalOrNew(paths.snapshotPath, encodeCanonical(snapshot), signal, transaction.ownership.snapshot)
    await store.writeIdenticalOrNew(paths.receiptPath, encodeCanonical(receipt), signal, transaction.ownership.receipt)
    signal?.throwIfAborted()
    await store.writeAtomic(paths.manifestPath, encodeCanonical({
      schemaVersion: PREVIEW_SCHEMA_VERSION,
      snapshotId: snapshot.id,
      receiptId: receipt.id,
      snapshotPath: paths.snapshotPath,
      receiptPath: paths.receiptPath,
      previewHtmlPath: paths.previewHtmlPath,
    }), signal)
  })
  return { state: 'committed', snapshot, receipt, ownership: transaction.ownership, manifestPath: paths.manifestPath }
}

/**
 * Load the current pointer and prove every stored byte, path, version, account, expiry, and signature binding.
 * @param store - Contained artifact store.
 * @param input - Re-created current inputs, proof credential, clock, and optional cancellation.
 * @returns Fully verified current preview.
 */
export async function validateCurrentPreview(store: ArtifactStore, input: CurrentPreviewInput): Promise<CurrentPreview> {
  try {
    input.signal?.throwIfAborted()
    if (Number.isNaN(input.now.getTime())) throw new Error('invalid current time')
    const expected = createPreviewSnapshot(input.snapshotInput)
    if (expected.pluginVersion !== PLUGIN_VERSION) throw new Error('version changed')
    const manifestPath = currentManifestPath(expected.revisionId)
    const pointer = parsePointer(await store.read(manifestPath, input.signal), expected.revisionId)
    if (pointer.snapshotId !== expected.id) throw new Error('snapshot changed')
    const paths = previewPathsFromPointer(pointer, expected.revisionId)
    const snapshotBytes = await store.read(paths.snapshotPath, input.signal)
    const snapshot = parseSnapshot(snapshotBytes)
    if (sha256(snapshotBytes) !== sha256(encodeCanonical(snapshot))) throw new Error('snapshot artifact bytes changed')
    if (canonicalJson(snapshot) !== canonicalJson(expected)) throw new Error('snapshot bytes changed')
    const receiptBytes = await store.read(paths.receiptPath, input.signal)
    const receipt = parseReceipt(receiptBytes)
    if (sha256(receiptBytes) !== sha256(encodeCanonical(receipt))) throw new Error('receipt artifact bytes changed')
    assertReceiptBindings(snapshot, receipt)
    if (receipt.id !== pointer.receiptId || receipt.previewHtmlPath !== paths.previewHtmlPath) throw new Error('receipt path changed')
    if (receipt.pluginVersion !== PLUGIN_VERSION || receipt.cliVersion !== expected.cliVersion) throw new Error('version changed')
    if (input.now.getTime() < Date.parse(receipt.issuedAt) || Date.parse(receipt.expiresAt) <= input.now.getTime()) {
      throw new Error('receipt is outside its validity interval')
    }
    const unsigned = unsignedReceipt(receipt)
    const expectedSignature = sign(unsigned, input.credentialValue)
    if (!safeHexEqual(receipt.signature, expectedSignature)) throw new Error('signature changed')
    const html = await store.read(paths.previewHtmlPath, input.signal)
    if (html.byteLength < 1 || html.byteLength > MAX_PREVIEW_HTML_BYTES || sha256(html) !== receipt.previewHtmlSha256) {
      throw new Error('preview HTML changed')
    }
    return { snapshot, receipt, manifestPath, htmlPath: paths.previewHtmlPath, htmlBytes: html }
  } catch {
    if (input.signal?.aborted) throw safePreviewValidationError('preview validation cancelled')
    throw safePreviewValidationError('stale preview')
  }
}

/**
 * Remove only exact uncommitted transaction artifacts; committed state is retained.
 * @param store - Contained artifact store.
 * @param transaction - Prepared, published, or committed preview lifecycle state.
 * @param signal - Optional cleanup cancellation signal.
 */
export async function cleanupPreviewSnapshot(
  store: ArtifactStore,
  transaction: PreviewTransaction,
  signal?: AbortSignal,
): Promise<void> {
  switch (transaction.state) {
    case 'prepared': {
      return
    }
    case 'published': {
      const paths = previewPaths(transaction.snapshot, transaction.receipt)
      const current = await currentPointer(store, transaction.snapshot.revisionId, signal)
      if (current === 'unknown' || current?.receiptId === transaction.receipt.id) return
      if (transaction.ownership.receipt.created) {
        await store.removeIfMatching(paths.receiptPath, sha256(encodeCanonical(transaction.receipt)), signal)
      }
      if (transaction.ownership.snapshot.created && current?.snapshotId !== transaction.snapshot.id) {
        await store.removeIfMatching(paths.snapshotPath, sha256(encodeCanonical(transaction.snapshot)), signal)
      }
      if (transaction.ownership.html.created && current?.previewHtmlPath !== paths.previewHtmlPath) {
        await store.removeIfMatching(paths.previewHtmlPath, transaction.receipt.previewHtmlSha256, signal)
      }
      return
    }
    case 'committed':
      return
    default:
      return assertNever(transaction)
  }
}

function safePreviewValidationError(message: 'stale preview' | 'preview validation cancelled'): Error {
  const error = new Error(message)
  error.stack = `Error: ${message}`
  return error
}

function previewPaths(snapshot: PreviewSnapshot, receipt?: PreviewReceipt) {
  const root = `revisions/${snapshot.revisionId}/previews`
  return {
    manifestPath: `${root}/current.json`,
    snapshotPath: `${root}/snapshots/${snapshot.id}.json`,
    receiptPath: receipt === undefined ? `${root}/receipts/unpublished.json` : `${root}/receipts/${receipt.id}.json`,
    previewHtmlPath: previewHtmlPath(snapshot),
  }
}

function previewHtmlPath(snapshot: PreviewSnapshot): string {
  return `revisions/${snapshot.revisionId}/previews/html/${snapshot.id}.html`
}

function currentManifestPath(revisionId: string): string {
  return `revisions/${revisionId}/previews/current.json`
}

interface PreviewPointer {
  schemaVersion: 1
  snapshotId: string
  receiptId: string
  snapshotPath: string
  receiptPath: string
  previewHtmlPath: string
}

function parsePointer(bytes: Uint8Array, revisionId: string): PreviewPointer {
  const value = parseJsonRecord(bytes, 'preview pointer')
  assertExactKeys(value, ['schemaVersion', 'snapshotId', 'receiptId', 'snapshotPath', 'receiptPath', 'previewHtmlPath'], 'preview pointer')
  if (value.schemaVersion !== PREVIEW_SCHEMA_VERSION) throw new TypeError('unsupported preview pointer schema')
  const snapshotId = hashString(value.snapshotId, 'preview pointer snapshot ID')
  const receiptId = hashString(value.receiptId, 'preview pointer receipt ID')
  const expected = {
    snapshotPath: `revisions/${revisionId}/previews/snapshots/${snapshotId}.json`,
    receiptPath: `revisions/${revisionId}/previews/receipts/${receiptId}.json`,
    previewHtmlPath: `revisions/${revisionId}/previews/html/${snapshotId}.html`,
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) throw new TypeError(`preview pointer ${key} does not match its content address`)
  }
  return { schemaVersion: 1, snapshotId, receiptId, ...expected }
}

function previewPathsFromPointer(pointer: PreviewPointer, revisionId: string) {
  if (!pointer.snapshotPath.startsWith(`revisions/${revisionId}/previews/`)) throw new TypeError('preview pointer leaves its revision')
  return { manifestPath: currentManifestPath(revisionId), ...pointer }
}

function parseSnapshot(bytes: Uint8Array): PreviewSnapshot {
  return validateSnapshot(parseJsonRecord(bytes, 'preview snapshot'))
}

function validateSnapshot(value: unknown): PreviewSnapshot {
  const snapshot = plainRecord(value, 'preview snapshot must be an object')
  assertExactKeys(snapshot, [
    'schemaVersion', 'id', 'revisionId', 'articlePath', 'articleSha256', 'localImages',
    'transformations', 'accountProvenance', 'pluginVersion', 'cliVersion',
  ], 'preview snapshot')
  if (snapshot.schemaVersion !== PREVIEW_SCHEMA_VERSION) throw new TypeError('unsupported preview snapshot schema')
  const id = hashString(snapshot.id, 'preview snapshot ID')
  const revisionId = hashString(snapshot.revisionId, 'preview revision ID')
  const articlePath = requiredSafeString(snapshot.articlePath, 'preview article path')
  if (articlePath !== `revisions/${revisionId}/article.md`) throw new TypeError('preview snapshot article path does not match its revision')
  const localImages = requiredArray(snapshot.localImages, 'preview local images').map((entry) => {
    const image = plainRecord(entry, 'preview local image must be an object')
    assertExactKeys(image, ['path', 'sha256'], 'preview local image')
    return { path: requiredSafeString(image.path, 'preview local image path'), sha256: hashString(image.sha256, 'preview local image hash') }
  })
  const transformations = plainRecord(snapshot.transformations, 'preview transformations must be an object')
  assertExactKeys(transformations, ['layoutBaseUrl', 'preview'], 'preview transformations')
  const safe: Omit<PreviewSnapshot, 'id'> = {
    schemaVersion: 1,
    revisionId,
    articlePath,
    articleSha256: hashString(snapshot.articleSha256, 'preview article hash'),
    localImages,
    transformations: {
      layoutBaseUrl: requiredSafeString(transformations.layoutBaseUrl, 'preview layout base URL'),
      preview: validatePreviewSettings(transformations.preview),
    },
    accountProvenance: hashString(snapshot.accountProvenance, 'preview account provenance'),
    pluginVersion: requiredSafeString(snapshot.pluginVersion, 'preview plugin version'),
    cliVersion: requiredSafeString(snapshot.cliVersion, 'preview CLI version'),
  }
  if (sha256Text(canonicalJson(safe)) !== id) throw new TypeError('preview snapshot ID does not match its content')
  return { ...safe, id }
}

function parseReceipt(bytes: Uint8Array): PreviewReceipt {
  return validateReceipt(parseJsonRecord(bytes, 'preview receipt'))
}

function validateReceipt(value: unknown): PreviewReceipt {
  const receipt = plainRecord(value, 'preview receipt must be an object')
  assertExactKeys(receipt, [
    'schemaVersion', 'id', 'snapshotId', 'revisionId', 'previewHtmlPath', 'previewHtmlSha256',
    'metadata', 'assets', 'accountProvenance', 'issuedAt', 'expiresAt', 'pluginVersion', 'cliVersion', 'signature',
  ], 'preview receipt')
  if (receipt.schemaVersion !== PREVIEW_SCHEMA_VERSION) throw new TypeError('unsupported preview receipt schema')
  const safe: Omit<PreviewReceipt, 'id'> = {
    schemaVersion: 1,
    snapshotId: hashString(receipt.snapshotId, 'preview receipt snapshot ID'),
    revisionId: hashString(receipt.revisionId, 'preview receipt revision ID'),
    previewHtmlPath: requiredSafeString(receipt.previewHtmlPath, 'preview receipt HTML path'),
    previewHtmlSha256: hashString(receipt.previewHtmlSha256, 'preview receipt HTML hash'),
    metadata: validatePreviewMetadata(receipt.metadata),
    assets: validatePreviewAssets(receipt.assets, { revisionId: safeRevisionId(receipt.revisionId) }),
    accountProvenance: hashString(receipt.accountProvenance, 'preview receipt account provenance'),
    issuedAt: canonicalTimestamp(receipt.issuedAt, 'preview receipt issue time'),
    expiresAt: canonicalTimestamp(receipt.expiresAt, 'preview receipt expiry time'),
    pluginVersion: requiredSafeString(receipt.pluginVersion, 'preview receipt plugin version'),
    cliVersion: requiredSafeString(receipt.cliVersion, 'preview receipt CLI version'),
    signature: hashString(receipt.signature, 'preview receipt signature'),
  }
  const id = hashString(receipt.id, 'preview receipt ID')
  if (sha256Text(canonicalJson(safe)) !== id) throw new TypeError('preview receipt ID does not match its content')
  return { ...safe, id }
}

function assertReceiptBindings(snapshot: PreviewSnapshot, receipt: PreviewReceipt): void {
  if (receipt.snapshotId !== snapshot.id
    || receipt.revisionId !== snapshot.revisionId
    || receipt.previewHtmlPath !== previewHtmlPath(snapshot)
    || receipt.accountProvenance !== snapshot.accountProvenance
    || receipt.pluginVersion !== snapshot.pluginVersion
    || receipt.cliVersion !== snapshot.cliVersion) {
    throw new TypeError('preview receipt does not match its snapshot')
  }
  const receiptLocals = receipt.assets.filter((asset): asset is Extract<PreviewAsset, { kind: 'local' }> => asset.kind === 'local')
    .map(asset => ({ path: asset.path, sha256: asset.sha256 })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  if (canonicalJson(receiptLocals) !== canonicalJson(snapshot.localImages)) throw new TypeError('preview receipt local assets do not match its snapshot')
}

function unsignedReceipt(receipt: PreviewReceipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    snapshotId: receipt.snapshotId,
    revisionId: receipt.revisionId,
    previewHtmlPath: receipt.previewHtmlPath,
    previewHtmlSha256: receipt.previewHtmlSha256,
    metadata: receipt.metadata,
    assets: receipt.assets,
    accountProvenance: receipt.accountProvenance,
    issuedAt: receipt.issuedAt,
    expiresAt: receipt.expiresAt,
    pluginVersion: receipt.pluginVersion,
    cliVersion: receipt.cliVersion,
  }
}

function safeRevisionId(value: unknown): string { return hashString(value, 'preview receipt revision ID') }

function validatePreviewMetadata(value: unknown): PreviewMetadata {
  const metadata = plainRecord(value, 'preview metadata must be an object')
  assertExactKeys(metadata, ['title', 'author', 'digest'], 'preview metadata')
  const title = boundedCodePoints(metadata.title, 32, 'preview title', false)
  const author = boundedCodePoints(metadata.author, 16, 'preview author', true)
  const digest = boundedCodePoints(metadata.digest, 128, 'preview digest', true)
  return { title, author, digest }
}

function validatePreviewAssets(value: unknown, snapshot: Pick<PreviewSnapshot, 'revisionId'>): readonly PreviewAsset[] {
  const assets = requiredArray(value, 'preview assets')
  if (assets.length > 512) throw new TypeError('preview asset inventory is too large')
  const localPaths = new Set<string>()
  return assets.map((entry, index) => {
    const asset = plainRecord(entry, 'preview asset must be an object')
    const kind = oneOf(asset.kind, ['local', 'online', 'ai'] as const, 'preview asset kind')
    const source = boundedCodePoints(asset.source, 4096, 'preview asset source', false)
    if (asset.index !== index) throw new TypeError('preview asset index is not canonical')
    if (kind !== 'local') {
      assertExactKeys(asset, ['index', 'kind', 'source'], 'preview asset')
      return { index, kind, source }
    }
    assertExactKeys(asset, ['index', 'kind', 'source', 'path', 'sha256'], 'preview local asset')
    const path = boundedCodePoints(asset.path, 1200, 'preview local asset path', false)
    validateArtifactRelativePath(path)
    if (!path.startsWith(`revisions/${snapshot.revisionId}/`)) throw new TypeError('preview local asset leaves its revision')
    const portable = path.normalize('NFC').toLowerCase()
    if (localPaths.has(portable)) throw new TypeError('preview local asset path is duplicated')
    localPaths.add(portable)
    return { index, kind: 'local', source, path, sha256: hashString(asset.sha256, 'preview local asset hash') }
  })
}

function boundedCodePoints(value: unknown, limit: number, field: string, empty: boolean): string {
  if (typeof value !== 'string' || (!empty && value.trim().length === 0) || [...value].length > limit || containsControl(value)) throw new TypeError(`${field} is invalid`)
  return value
}

function sign(value: ReturnType<typeof unsignedReceipt>, credentialValue: string): string {
  const proofKey = createHmac('sha256', credentialValue).update(PROOF_KEY_LABEL, 'utf8').digest()
  return createHmac('sha256', proofKey).update(canonicalJson(value), 'utf8').digest('hex')
}

function accountProvenance(reference: string, value: string): string {
  return createHash('sha256')
    .update(ACCOUNT_PROVENANCE_LABEL, 'utf8')
    .update('\0')
    .update(reference, 'utf8')
    .update('\0')
    .update(value, 'utf8')
    .digest('hex')
}

function safeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function validatePreviewSettings(value: unknown): PreviewSettings {
  const settings = plainRecord(value, 'preview settings must be an object')
  assertExactKeys(settings, ['mode', 'theme', 'fontSize', 'backgroundType', 'output'], 'preview settings')
  if (settings.mode !== 'api') throw new TypeError('preview mode must be api')
  const fontSize = oneOf(settings.fontSize, ['small', 'medium', 'large'], 'preview font size')
  const backgroundType = oneOf(settings.backgroundType, ['default', 'grid', 'none'], 'preview background type')
  return {
    mode: 'api',
    theme: requiredSafeString(settings.theme, 'preview theme'),
    fontSize,
    backgroundType,
    output: requiredSafeString(settings.output, 'preview output setting'),
  }
}

function oneOf<const T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new TypeError(`${field} is unsupported`)
  return value as T
}

function encodeCanonical(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(value)}\n`)
}

function parseJsonRecord(bytes: Uint8Array, field: string): Record<string, unknown> {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new TypeError(`${field} must be UTF-8`, { cause: error })
  }
  return plainRecord(JSON.parse(text), `${field} must contain an object`)
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON requires finite numbers')
    return value
  }
  if (Array.isArray(value)) return value.map(sortJson)
  const record = plainRecord(value, 'canonical JSON requires plain objects')
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, sortJson(record[key])]))
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function hashString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${field} must be 64 lowercase hexadecimal characters`)
  return value
}

function requiredSafeString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || containsControl(value)) throw new TypeError(`${field} must be a non-empty safe string`)
  return value
}

function containsControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function canonicalTimestamp(value: unknown, field: string): string {
  const timestamp = requiredSafeString(value, field)
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime()) || date.toISOString() !== timestamp) throw new TypeError(`${field} must be a canonical ISO timestamp`)
  return timestamp
}

function plainRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(message)
  return value as Record<string, unknown>
}

function requiredArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  return value
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const expected = new Set(keys)
  if (Object.keys(value).length !== expected.size || Object.keys(value).some(key => !expected.has(key))) {
    throw new TypeError(`${field} contains an unsupported field`)
  }
}

async function currentPointer(
  store: ArtifactStore,
  revisionId: string,
  signal?: AbortSignal,
): Promise<PreviewPointer | 'unknown' | undefined> {
  try {
    return parsePointer(await store.read(currentManifestPath(revisionId), signal), revisionId)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'FS_NOT_FOUND') return undefined
    return 'unknown'
  }
}

async function enqueuePublication(identity: string, operation: () => Promise<void>): Promise<void> {
  const previous = publicationQueues.get(identity) ?? Promise.resolve()
  const current = previous.then(operation, operation)
  const tail = current.then(() => undefined, () => undefined)
  publicationQueues.set(identity, tail)
  try {
    await current
  } finally {
    if (publicationQueues.get(identity) === tail) publicationQueues.delete(identity)
  }
}

function assertNever(value: never): never {
  throw new TypeError(`unsupported preview transaction ${String(value)}`)
}
