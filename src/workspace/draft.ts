import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { ArtifactStore } from './artifact-store.ts'

const HASH = /^[a-f0-9]{64}$/u
const MAX_DIRECTORIES = 100_000

/** Durable directory-only state for one remote WeChat draft operation. */
export type DraftAuthorityState =
  | { readonly status: 'absent' }
  | { readonly status: 'started' }
  | { readonly status: 'completed'; readonly resultDigest: string }

/** External directory-only authority preventing automatic duplicate draft creation. */
export class DraftStateStore {
  /** @param stateDir - Absolute private plugin state outside workspaces and temporary roots. */
  constructor(readonly stateDir: string) {
    if (!isAbsolute(stateDir)) throw new TypeError('stateDir must be an absolute path')
  }

  /** Inspect exact durable state without modifying it. */
  async inspect(store: ArtifactStore, operationId: string, signal?: AbortSignal): Promise<DraftAuthorityState> {
    validateHash(operationId, 'draft operation identity')
    const workspaceId = await this.initialize(store, false, signal)
    const root = join(this.stateDir, 'draft-operations', workspaceId, operationId)
    try { await ensurePrivateAncestry(this.stateDir, root, false, signal) } catch (error) {
      if (isMissing(error)) return { status: 'absent' }
      throw error
    }
    const entries = await readdir(root, { withFileTypes: true })
    if (entries.some(entry => !entry.isDirectory() || entry.isSymbolicLink())) throw new Error('draft authority contains a file or link')
    const names = entries.map(entry => entry.name).sort()
    if (names.length === 1 && names[0] === 'started') {
      await validatePrivateDirectory(join(root, 'started'))
      if ((await readdir(join(root, 'started'))).length !== 0) throw new Error('draft started authority must be empty')
      await auditAuthority(join(this.stateDir, 'draft-operations'))
      return { status: 'started' }
    }
    if (names.length === 2 && names[0] === 'completed' && names[1] === 'started') {
      await validatePrivateDirectory(join(root, 'started'))
      const complete = join(root, 'completed'); await validatePrivateDirectory(complete)
      const digests = await readdir(complete, { withFileTypes: true })
      if (digests.length !== 1 || !digests[0]!.isDirectory() || digests[0]!.isSymbolicLink() || !HASH.test(digests[0]!.name)) throw new Error('draft authority completed digest is invalid')
      const terminal = join(complete, digests[0]!.name); await validatePrivateDirectory(terminal)
      if ((await readdir(terminal)).length !== 0) throw new Error('draft completed authority terminal must be empty')
      await auditAuthority(join(this.stateDir, 'draft-operations'))
      return { status: 'completed', resultDigest: digests[0]!.name }
    }
    throw new Error('draft authority contains conflicting state')
  }

  /** Exclusively establish started authority before any possible remote process spawn. */
  async start(store: ArtifactStore, operationId: string, signal?: AbortSignal): Promise<void> {
    validateHash(operationId, 'draft operation identity')
    const workspaceId = await this.initialize(store, true, signal)
    const root = join(this.stateDir, 'draft-operations', workspaceId, operationId)
    await ensurePrivateAncestry(this.stateDir, root, true, signal)
    try { await mkdir(join(root, 'started'), { mode: 0o700 }) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error('draft operation is already started')
      throw error
    }
    await syncDirectory(root)
    const state = await this.inspect(store, operationId, signal)
    if (state.status !== 'started') throw new Error('draft started authority could not be verified')
  }

  /** Record the one exact immutable result digest after workspace publication. */
  async complete(store: ArtifactStore, operationId: string, resultDigest: string, signal?: AbortSignal): Promise<void> {
    validateHash(operationId, 'draft operation identity'); validateHash(resultDigest, 'draft result digest')
    const before = await this.inspect(store, operationId, signal)
    if (before.status === 'absent') throw new Error('draft operation was not started')
    if (before.status === 'completed') {
      if (before.resultDigest !== resultDigest) throw new Error('draft authority contains a conflicting result')
      return
    }
    const workspaceId = await this.initialize(store, false, signal)
    const completed = join(this.stateDir, 'draft-operations', workspaceId, operationId, 'completed')
    try { await mkdir(completed, { mode: 0o700 }) } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
    await validatePrivateDirectory(completed)
    const terminal = join(completed, resultDigest)
    try { await mkdir(terminal, { mode: 0o700 }) } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
    await syncDirectory(completed)
    const after = await this.inspect(store, operationId, signal)
    if (after.status !== 'completed' || after.resultDigest !== resultDigest) throw new Error('draft authority contains a conflicting result')
  }

  /** Create and immediately verify an empty private runtime directory for one operation. */
  async prepareRuntime(store: ArtifactStore, operationId: string, signal?: AbortSignal): Promise<string> {
    validateHash(operationId, 'draft operation identity')
    const workspaceId = await this.initialize(store, true, signal)
    const runtime = join(this.stateDir, 'draft-runtime', workspaceId, operationId)
    await ensurePrivateAncestry(this.stateDir, runtime, true, signal)
    await this.validateEmptyRuntime(runtime, signal)
    return runtime
  }

  /** Revalidate runtime privacy, identity, and emptiness immediately before spawn. */
  async validateEmptyRuntime(runtime: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const canonicalState = await realpath(this.stateDir)
    const canonical = await realpath(runtime)
    if (!contains(canonicalState, canonical) || canonical !== resolve(runtime)) throw new Error('draft runtime changed or escaped')
    await validatePrivateDirectory(canonical)
    if ((await readdir(canonical)).length !== 0) throw new Error('draft runtime must be empty before spawn')
  }

  private async initialize(store: ArtifactStore, create: boolean, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const candidate = await canonicalProspective(this.stateDir)
    await rejectSymlinkedExistingComponents(this.stateDir)
    const protectedPaths = await Promise.all([canonicalProspective(store.workspace), canonicalProspective(join(store.workspace, store.rootRelative)), ...platformTemporaryRoots().map(canonicalProspective)])
    if (protectedPaths.some(path => overlaps(candidate, path))) throw new Error('stateDir must stay outside the workspace, artifacts root, and platform temporary root')
    if (create) await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    await rejectSymlinkedExistingComponents(this.stateDir); await validatePrivateDirectory(this.stateDir)
    if ((await readdir(this.stateDir, { withFileTypes: true })).some(entry => !entry.isDirectory() || entry.isSymbolicLink())) throw new Error('draft state must contain directories only')
    const canonical = await realpath(this.stateDir)
    if (canonical !== candidate || protectedPaths.some(path => overlaps(canonical, path))) throw new Error('stateDir canonical identity overlaps a writable session root')
    return createHash('sha256').update(await store.canonicalIdentity('revisions', signal), 'utf8').digest('hex')
  }
}

async function ensurePrivateAncestry(root: string, destination: string, create: boolean, signal?: AbortSignal): Promise<void> {
  const canonicalRoot = await realpath(root); const child = relative(canonicalRoot, resolve(destination))
  if (child === '' || child.startsWith('..') || isAbsolute(child)) throw new Error('draft authority path escapes stateDir')
  let current = canonicalRoot
  for (const component of child.split(sep)) {
    signal?.throwIfAborted(); current = join(current, component)
    if (create) await mkdir(current, { mode: 0o700 }).catch(error => { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error })
    await validatePrivateDirectory(current)
    if (await realpath(current) !== current) throw new Error('draft authority uses a symlink or reparse point')
  }
}

async function auditAuthority(root: string): Promise<void> {
  const stack: Array<{ path: string; depth: number; parent?: string }> = [{ path: root, depth: 0 }]; let count = 0
  while (stack.length > 0) {
    const current = stack.pop()!; await validatePrivateDirectory(current.path)
    const entries = await readdir(current.path, { withFileTypes: true })
    if ((current.parent === 'started' || current.depth === 4) && entries.length !== 0) throw new Error('draft authority terminal directory must be empty')
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('draft authority contains a file or link')
      if (++count > MAX_DIRECTORIES) throw new Error('draft authority contains too many directories')
      const validName = current.depth === 0 || current.depth === 1 || current.parent === 'completed' ? HASH.test(entry.name) : current.depth === 2 ? entry.name === 'started' || entry.name === 'completed' : false
      if (!validName || current.depth >= 4) throw new Error('draft authority contains an invalid directory name or depth')
      stack.push({ path: join(current.path, entry.name), depth: current.depth + 1, parent: entry.name })
    }
  }
}

async function validatePrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('draft authority must contain directories only')
  if (platform() !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('draft authority directory permissions are not private')
  if (platform() !== 'win32' && typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('draft authority directory owner is invalid')
  if (await realpath(path) !== resolve(path)) throw new Error('draft authority directory is a symlink or reparse point')
}

async function rejectSymlinkedExistingComponents(path: string): Promise<void> {
  const absolute = resolve(path); const root = parse(absolute).root; let current = root
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, component)
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('stateDir must not use symlink or reparse-point ancestors') } catch (error) { if (isMissing(error)) return; throw error }
  }
}
function platformTemporaryRoots(): string[] { const candidates = [tmpdir(), process.env.TMPDIR, process.env.TMP, process.env.TEMP, ...(platform() === 'win32' ? [] : ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'])]; return [...new Set(candidates.filter((value): value is string => value !== undefined && value !== '').map(value => resolve(value)))] }
async function canonicalProspective(path: string): Promise<string> { let candidate = resolve(path); const missing: string[] = []; while (true) { try { await lstat(candidate); break } catch (error) { if (!isMissing(error)) throw error; const parent = dirname(candidate); if (parent === candidate) throw error; missing.unshift(basename(candidate)); candidate = parent } } return resolve(await realpath(candidate), ...missing) }
async function syncDirectory(path: string): Promise<void> { let handle: Awaited<ReturnType<typeof open>> | undefined; try { handle = await open(path, 'r'); await handle.sync() } catch (error) { if (!(error instanceof Error && 'code' in error && ['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(String(error.code)))) throw error } finally { await handle?.close() } }
function validateHash(value: string, field: string): void { if (!HASH.test(value)) throw new TypeError(`${field} is invalid`) }
function overlaps(left: string, right: string): boolean { return contains(left, right) || contains(right, left) }
function contains(parent: string, child: string): boolean { return child === parent || child.startsWith(`${parent}${sep}`) }
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
