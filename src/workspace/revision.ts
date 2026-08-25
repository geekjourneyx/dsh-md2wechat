import { createHash } from 'node:crypto'
import { PLUGIN_VERSION, SUPPORTED_CLI_VERSION } from '../version.ts'
import { redactValue } from '../security/redaction.ts'
import { validateArtifactId, validateArtifactRelativePath } from './artifact-store.ts'
import type { ArtifactStore } from './artifact-store.ts'

const REVISION_SCHEMA_VERSION = 1
const manifestKeys = new Set<keyof ArticleManifest>([
  'schemaVersion',
  'articlePath',
  'manifestPath',
  'createdAt',
  'title',
  'parentRevisionId',
])
// One plugin process may construct multiple stores for the same session root;
// the backend-owned canonical identity lets those instances share this queue.
const appendQueues = new Map<string, Promise<void>>()

/** Persisted inputs used to derive one article revision. */
export interface ArticleManifest {
  schemaVersion: 1
  articlePath: string
  manifestPath: string
  createdAt: string
  title?: string
  parentRevisionId?: string
}

/** Immutable identity and paths for one prepared article revision. */
export interface ArticleRevision {
  id: string
  articlePath: string
  articleSha256: string
  manifestPath: string
  pluginVersion: typeof PLUGIN_VERSION
  cliVersion: typeof SUPPORTED_CLI_VERSION
  createdAt: string
}

/** One redacted persisted operation performed against a revision. */
export interface OperationRecord {
  schemaVersion: 1
  sequence: number
  revisionId: string
  operation: string
  createdAt: string
  details: Readonly<Record<string, unknown>>
}

/** Fields supplied before append assigns the revision and monotonic sequence. */
export interface OperationInput {
  operation: string
  createdAt: string
  details: Readonly<Record<string, unknown>>
}

/**
 * Validate a persisted article manifest and return normalized fields.
 * @param value - Untrusted manifest value.
 * @returns Strict normalized manifest.
 */
export function validateRevisionManifest(value: unknown): ArticleManifest {
  const manifest = plainRecord(value, 'revision manifest must be an object')
  for (const key of Object.keys(manifest)) {
    if (!manifestKeys.has(key as keyof ArticleManifest)) throw new TypeError('revision manifest contains an unknown field')
  }
  if (manifest.schemaVersion !== REVISION_SCHEMA_VERSION) throw new TypeError('unsupported revision manifest schema version')
  const articlePath = requiredString(manifest.articlePath, 'articlePath')
  const manifestPath = requiredString(manifest.manifestPath, 'manifestPath')
  validateArtifactRelativePath(articlePath)
  validateArtifactRelativePath(manifestPath)
  const createdAt = requiredString(manifest.createdAt, 'createdAt')
  if (Number.isNaN(Date.parse(createdAt))) throw new TypeError('revision manifest createdAt must be an ISO timestamp')
  const title = optionalString(manifest.title, 'title')
  const parentRevisionId = optionalString(manifest.parentRevisionId, 'parentRevisionId')
  if (parentRevisionId !== undefined) validateArtifactId(parentRevisionId)
  return {
    schemaVersion: 1,
    articlePath,
    manifestPath,
    createdAt,
    ...(title === undefined ? {} : { title }),
    ...(parentRevisionId === undefined ? {} : { parentRevisionId }),
  }
}

/**
 * Derive one deterministic revision from canonical UTF-8 article bytes and manifest fields.
 * @param articleBytes - Complete UTF-8 Markdown bytes.
 * @param manifestValue - Strict manifest fields describing the revision.
 * @returns Revision identity and safe persisted paths.
 */
export function computeArticleRevision(articleBytes: Uint8Array, manifestValue: ArticleManifest): ArticleRevision {
  const article = canonicalUtf8(articleBytes)
  const manifest = validateRevisionManifest(manifestValue)
  const articleSha256 = sha256(article)
  const normalized = canonicalJson({
    ...manifest,
    pluginVersion: PLUGIN_VERSION,
    cliVersion: SUPPORTED_CLI_VERSION,
  })
  const id = createHash('sha256').update(article).update('\0').update(normalized, 'utf8').digest('hex')
  return {
    id,
    articlePath: manifest.articlePath,
    articleSha256,
    manifestPath: manifest.manifestPath,
    pluginVersion: PLUGIN_VERSION,
    cliVersion: SUPPORTED_CLI_VERSION,
    createdAt: manifest.createdAt,
  }
}

/**
 * Append one canonical redacted operation line beneath a revision directory.
 * @param store - Contained artifact store.
 * @param revision - Revision that owns the operation.
 * @param input - Safe operation metadata before sequence assignment.
 * @param secrets - Resolved values that must not persist.
 * Concurrent appends are serialized by canonical file identity within this
 * process. The plugin runtime does not run multiple writers in separate
 * processes for one session workspace.
 * @returns The record written to storage.
 */
export async function appendOperation(
  store: ArtifactStore,
  revision: ArticleRevision,
  input: OperationInput,
  secrets: readonly string[],
): Promise<OperationRecord> {
  validateArtifactId(revision.id)
  requiredString(input.operation, 'operation')
  requiredString(input.createdAt, 'createdAt')
  const details = plainRecord(redactValue(input.details, secrets), 'operation details must be an object')
  const path = `revisions/${revision.id}/operations.jsonl`
  const identity = await store.canonicalIdentity(path)
  let result: OperationRecord | undefined
  await enqueueAppend(identity, async () => {
    const existing = await readOptionalText(store, path)
    const sequence = lastSequence(existing) + 1
    result = {
      schemaVersion: 1,
      sequence,
      revisionId: revision.id,
      operation: input.operation,
      createdAt: input.createdAt,
      details,
    }
    await store.writeAtomic(path, new TextEncoder().encode(`${existing}${canonicalJson(result)}\n`))
  })
  if (result === undefined) throw new Error('operation record was not appended')
  return result
}

function canonicalUtf8(bytes: Uint8Array): Uint8Array {
  try {
    return new TextEncoder().encode(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw new TypeError('article bytes must be valid UTF-8', { cause: error })
  }
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
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

async function readOptionalText(store: ArtifactStore, path: string): Promise<string> {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(await store.read(path))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'FS_NOT_FOUND') return ''
    throw error
  }
}

function lastSequence(text: string): number {
  if (text.length === 0) return 0
  if (!text.endsWith('\n')) throw new TypeError('operation record file must end with a newline')
  const lines = text.slice(0, -1).split('\n')
  const last = plainRecord(JSON.parse(lines.at(-1)!), 'operation record line must be an object')
  if (!Number.isSafeInteger(last.sequence) || (last.sequence as number) < 1) {
    throw new TypeError('operation record sequence must be a positive integer')
  }
  return last.sequence as number
}

async function enqueueAppend(identity: string, operation: () => Promise<void>): Promise<void> {
  const previous = appendQueues.get(identity) ?? Promise.resolve()
  const current = previous.then(operation, operation)
  const tail = current.then(() => undefined, () => undefined)
  appendQueues.set(identity, tail)
  try {
    return await current
  } finally {
    if (appendQueues.get(identity) === tail) appendQueues.delete(identity)
  }
}

function plainRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(message)
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be a non-empty string`)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, field)
}
