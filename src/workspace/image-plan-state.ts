import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { ArtifactStore } from './artifact-store.ts'

const HASH_PATTERN = /^[a-f0-9]{64}$/u
const PLAN_PATH_PATTERN = /^revisions\/([a-f0-9]{64})\/plans\/([a-f0-9]{64})\.json$/u
const MAX_PLAN_BYTES = 1024 * 1024
const MAX_AUTHORITY_DIRECTORIES = 100_000
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** Deterministic Task 5 plan proposed for external authority publication or verification. */
export interface ImagePlanAuthorityProposal {
  readonly planPath: string
  readonly planId: string
  readonly revisionId: string
  readonly items: readonly unknown[]
  readonly planBytes: Uint8Array
}

/** Directory-only external authority for immutable image plans. */
export class ImagePlanStateStore {
  /**
   * Create an external image-plan state store without touching the filesystem.
   * @param stateDir - Absolute plugin-specific state directory outside workspace and platform temp roots.
   */
  constructor(readonly stateDir: string) {
    if (!isAbsolute(stateDir)) throw new TypeError('stateDir must be an absolute path')
  }

  /**
   * Validate the external state root against one session workspace.
   * @param store - Session artifact store whose workspace must not overlap state.
   * @param create - Whether Task 5 may create a missing external state root.
   * @param signal - Optional cancellation signal.
   * @returns Canonical workspace identity digest used in authority paths.
   */
  async initialize(store: ArtifactStore, create: boolean, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const stateCandidate = await canonicalProspective(this.stateDir)
    await rejectSymlinkedExistingComponents(this.stateDir)
    const protectedPaths = await Promise.all([
      canonicalProspective(store.workspace),
      canonicalProspective(join(store.workspace, store.rootRelative)),
      ...platformTemporaryRoots().map(canonicalProspective),
    ])
    if (protectedPaths.some(path => pathsOverlap(stateCandidate, path))) {
      throw new Error('stateDir must stay outside the workspace, artifacts root, and platform temporary root')
    }
    if (create) await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    await rejectSymlinkedExistingComponents(this.stateDir)
    await validatePrivateDirectory(this.stateDir)
    const canonicalState = await realpath(this.stateDir)
    if (canonicalState !== stateCandidate || protectedPaths.some(path => pathsOverlap(canonicalState, path))) {
      throw new Error('stateDir canonical identity overlaps a writable session root')
    }
    signal?.throwIfAborted()
    return sha256Text(await store.canonicalIdentity('revisions', signal))
  }

  /**
   * Atomically publish one deterministic plan authority as directories only.
   * @param store - Session artifact store used only to bind workspace identity.
   * @param proposal - Exact deterministic plan bytes and their semantic identity.
   * @param signal - Optional cancellation signal.
   */
  async publish(store: ArtifactStore, proposal: ImagePlanAuthorityProposal, signal?: AbortSignal): Promise<void> {
    const validated = validateProposal(proposal)
    const workspaceIdentity = await this.initialize(store, true, signal)
    const planRoot = join(this.stateDir, 'image-plans', workspaceIdentity, validated.revisionId, validated.planId)
    await ensurePrivateAncestry(this.stateDir, planRoot, true, signal)
    const terminal = join(planRoot, validated.planSha256)
    try { await mkdir(terminal, { mode: 0o700 }) }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
    await validatePrivateDirectory(terminal)
    await requireOnlyDigest(planRoot, validated.planSha256)
    await syncDirectory(planRoot)
    await ensurePrivateAncestry(this.stateDir, terminal, false, signal)
    await auditDirectoryOnlyAuthority(join(this.stateDir, 'image-plans'))
  }

  /**
   * Authenticate current deterministic plan bytes without creating or changing authority state.
   * @param store - Session artifact store used only to bind workspace identity.
   * @param proposal - Current strict plan bytes and their semantic identity.
   * @param signal - Optional cancellation signal.
   */
  async verify(store: ArtifactStore, proposal: ImagePlanAuthorityProposal, signal?: AbortSignal): Promise<void> {
    const validated = validateProposal(proposal)
    const workspaceIdentity = await this.initialize(store, false, signal)
    const planRoot = join(this.stateDir, 'image-plans', workspaceIdentity, validated.revisionId, validated.planId)
    const terminal = join(planRoot, validated.planSha256)
    await ensurePrivateAncestry(this.stateDir, terminal, false, signal)
    await requireOnlyDigest(planRoot, validated.planSha256)
    await auditDirectoryOnlyAuthority(join(this.stateDir, 'image-plans'))
  }
}

function validateProposal(proposal: ImagePlanAuthorityProposal): ImagePlanAuthorityProposal & { planSha256: string } {
  if (!HASH_PATTERN.test(proposal.revisionId) || !HASH_PATTERN.test(proposal.planId)) throw new TypeError('image plan authority identity is invalid')
  const match = PLAN_PATH_PATTERN.exec(proposal.planPath)
  if (match === null || match[1] !== proposal.revisionId || match[2] !== proposal.planId) throw new TypeError('image plan authority path is invalid')
  if (!(proposal.planBytes instanceof Uint8Array) || proposal.planBytes.byteLength < 1 || proposal.planBytes.byteLength > MAX_PLAN_BYTES) throw new TypeError('image plan authority bytes are invalid')
  let parsed: unknown
  try { parsed = JSON.parse(decoder.decode(proposal.planBytes)) } catch { throw new TypeError('image plan authority bytes are not canonical JSON') }
  if (!Buffer.from(proposal.planBytes).equals(Buffer.from(encodeCanonical(parsed)))) throw new TypeError('image plan authority bytes are not canonical JSON')
  const root = plainRecord(parsed)
  exactKeys(root, ['schemaVersion', 'planId', 'revisionId', 'createdAt', 'items'])
  if (root.schemaVersion !== 1 || root.planId !== proposal.planId || root.revisionId !== proposal.revisionId) throw new TypeError('image plan authority bytes do not match their identity')
  canonicalTimestamp(root.createdAt)
  if (!Array.isArray(root.items) || canonicalJson(root.items) !== canonicalJson(proposal.items)) throw new TypeError('image plan authority items do not match their bytes')
  if (sha256Text(canonicalJson({ revisionId: proposal.revisionId, items: proposal.items })) !== proposal.planId) throw new TypeError('image plan authority ID does not match its items')
  return { ...proposal, planSha256: sha256Bytes(proposal.planBytes) }
}

async function ensurePrivateAncestry(root: string, destination: string, create: boolean, signal?: AbortSignal): Promise<void> {
  const rootCanonical = await realpath(root)
  const candidate = resolve(destination)
  const child = relative(rootCanonical, candidate)
  if (child === '' || child.startsWith('..') || isAbsolute(child)) throw new Error('image plan authority path escapes stateDir')
  let current = rootCanonical
  for (const component of child.split(sep)) {
    signal?.throwIfAborted()
    current = join(current, component)
    if (create) await mkdir(current, { mode: 0o700 }).catch(error => { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error })
    await validatePrivateDirectory(current)
    const canonical = await realpath(current)
    if (canonical !== current || !isContained(rootCanonical, canonical)) throw new Error('image plan authority directory changed or escaped')
  }
}

async function requireOnlyDigest(planRoot: string, digest: string): Promise<void> {
  await validatePrivateDirectory(planRoot)
  const entries = await readdir(planRoot, { withFileTypes: true })
  if (entries.length !== 1 || entries[0]!.name !== digest || !entries[0]!.isDirectory() || entries[0]!.isSymbolicLink()) {
    throw new Error('image plan authority contains conflicting or invalid entries')
  }
  const terminal = join(planRoot, digest)
  await validatePrivateDirectory(terminal)
  if ((await readdir(terminal)).length !== 0) throw new Error('image plan authority terminal directory must be empty')
}

async function validatePrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('image plan authority must contain directories only')
  // Windows mode bits do not describe ACLs; external-root sandbox containment is the integrity control there.
  if (platform() !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('image plan authority directory permissions are not private')
  if (platform() !== 'win32' && typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('image plan authority directory owner is invalid')
  if (await realpath(path) !== resolve(path)) throw new Error('image plan authority directory is a reparse point or symlink alias')
}

async function auditDirectoryOnlyAuthority(root: string): Promise<void> {
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  let count = 0
  while (stack.length > 0) {
    const current = stack.pop()!
    await validatePrivateDirectory(current.path)
    const entries = await readdir(current.path, { withFileTypes: true })
    if (current.depth === 4 && entries.length !== 0) throw new Error('image plan authority terminal directory must be empty')
    for (const entry of entries) {
      count += 1
      if (count > MAX_AUTHORITY_DIRECTORIES) throw new Error('image plan authority contains too many directories')
      if (current.depth >= 4 || !HASH_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error('image plan authority contains a file, link, or invalid directory name')
      }
      stack.push({ path: join(current.path, entry.name), depth: current.depth + 1 })
    }
  }
}

async function rejectSymlinkedExistingComponents(path: string): Promise<void> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, component)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error('stateDir must not use symlink or reparse-point ancestors')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
  }
}

function platformTemporaryRoots(): string[] {
  const candidates = [tmpdir(), process.env.TMPDIR, process.env.TMP, process.env.TEMP]
  if (platform() !== 'win32') candidates.push('/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp')
  return [...new Set(candidates.filter((value): value is string => value !== undefined && value.length > 0).map(value => resolve(value)))]
}

async function canonicalProspective(path: string): Promise<string> {
  let candidate = resolve(path)
  const missing: string[] = []
  while (true) {
    try { await lstat(candidate); break } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      const parent = dirname(candidate)
      if (parent === candidate) throw error
      missing.unshift(basename(candidate)); candidate = parent
    }
  }
  return resolve(await realpath(candidate), ...missing)
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && ['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(String(error.code)))) throw error
  } finally {
    await handle?.close()
  }
}

function pathsOverlap(left: string, right: string): boolean { return isContained(left, right) || isContained(right, left) }
function isContained(parent: string, child: string): boolean { return child === parent || child.startsWith(`${parent}${sep}`) }
function plainRecord(value: unknown): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('image plan authority JSON must be an object'); return value as Record<string, unknown> }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void { const expected = new Set(keys); if (Object.keys(value).some(key => !expected.has(key)) || keys.some(key => !(key in value))) throw new TypeError('image plan authority JSON fields are invalid') }
function canonicalTimestamp(value: unknown): void { if (typeof value !== 'string') throw new TypeError('image plan authority timestamp is invalid'); const date = new Date(value); if (Number.isNaN(date.getTime()) || date.toISOString() !== value) throw new TypeError('image plan authority timestamp is invalid') }
function canonicalJson(value: unknown): string { return JSON.stringify(sortJson(value)) }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sortJson(item)])); return value }
function encodeCanonical(value: unknown): Uint8Array { return encoder.encode(`${canonicalJson(value)}\n`) }
function sha256Text(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function sha256Bytes(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
