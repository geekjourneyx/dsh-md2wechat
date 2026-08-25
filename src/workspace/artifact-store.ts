import { randomUUID } from 'node:crypto'
import { open, mkdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const windowsDeviceName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu

/** Native publication hooks used only to inject storage-boundary failures in tests. */
export interface ArtifactStoreInternals {
  rename?: (source: string, destination: string) => Promise<void>
}

/** Workspace-contained binary artifact storage backed by the DSH filesystem identity service. */
export class ArtifactStore {
  /**
   * Create one store rooted beneath the canonical session workspace.
   * @param fs - DSH filesystem service used for canonical identity and reads.
   * @param workspace - Absolute session workspace root.
   * @param rootRelative - Relative plugin artifact directory below the workspace.
   * @param internals - Optional native publication hooks for boundary tests.
   */
  constructor(
    readonly fs: Context['fs'],
    readonly workspace: string,
    readonly rootRelative: string,
    private readonly internals: ArtifactStoreInternals = {},
  ) {
    if (!isAbsolute(workspace)) throw new TypeError('workspace must be an absolute path')
    validateArtifactRelativePath(rootRelative)
  }

  /**
   * Resolve a validated artifact path lexically beneath this store's root.
   * @param relative - Artifact-relative path.
   * @returns Absolute lexical path; I/O methods additionally verify canonical containment.
   */
  resolve(relative: string): string {
    validateArtifactRelativePath(relative)
    return join(this.workspace, this.rootRelative, ...splitPath(relative))
  }

  /**
   * Read one contained artifact as bytes.
   * @param relative - Artifact-relative path.
   * @param signal - Optional cancellation signal.
   * @returns Complete artifact bytes.
   */
  async read(relative: string, signal?: AbortSignal): Promise<Uint8Array> {
    const target = await this.resolveContained(relative, signal)
    return this.fs.readBytes(target, signal, MAX_ARTIFACT_BYTES)
  }

  /**
   * Atomically replace one contained artifact with complete bytes.
   * @param relative - Artifact-relative destination.
   * @param bytes - Complete bytes to publish.
   * @param signal - Optional cancellation signal.
   */
  async writeAtomic(relative: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    const target = await this.resolveContained(relative, signal)
    await this.publish(target, bytes, signal)
  }

  /**
   * Copy an explicit absolute file into contained artifact storage.
   * @param sourceAbsolute - Absolute external source path.
   * @param destinationRelative - Artifact-relative destination.
   * @param signal - Optional cancellation signal.
   */
  async copyIn(sourceAbsolute: string, destinationRelative: string, signal?: AbortSignal): Promise<void> {
    if (!isAbsolute(sourceAbsolute)) throw new TypeError('copyIn source must be an absolute path')
    const source = await this.fs.resolve(sourceAbsolute, resolveOptions(signal))
    const destination = await this.resolveContained(destinationRelative, signal)
    assertDifferentTargets(source, destination)
    const bytes = await this.fs.readBytes(source, signal, MAX_ARTIFACT_BYTES)
    await this.publish(destination, bytes, signal)
  }

  /**
   * Copy one contained artifact to an explicit absolute destination.
   * @param sourceRelative - Artifact-relative source path.
   * @param destinationAbsolute - Absolute external destination path.
   * @param signal - Optional cancellation signal.
   */
  async copyOut(sourceRelative: string, destinationAbsolute: string, signal?: AbortSignal): Promise<void> {
    if (!isAbsolute(destinationAbsolute)) throw new TypeError('copyOut destination must be an absolute path')
    const source = await this.resolveContained(sourceRelative, signal)
    const destination = await this.fs.resolve(destinationAbsolute, resolveOptions(signal))
    assertDifferentTargets(source, destination)
    const bytes = await this.fs.readBytes(source, signal, MAX_ARTIFACT_BYTES)
    await this.publish(destination, bytes, signal)
  }

  private async resolveContained(relative: string, signal?: AbortSignal): Promise<FsTarget> {
    this.resolve(relative)
    const workspace = await this.fs.resolve(this.workspace, resolveOptions(signal))
    const rootParts = splitPath(this.rootRelative)
    const pathParts: string[] = []
    let artifactRoot: FsTarget | undefined
    for (const component of rootParts) {
      pathParts.push(component)
      artifactRoot = await this.fs.resolve(join(this.workspace, ...pathParts), resolveOptions(signal))
      if (!this.fs.contains(workspace, artifactRoot)) throw new Error('artifact path escapes the session workspace')
    }
    if (artifactRoot === undefined) throw new Error('artifact root could not be resolved canonically')

    let target = artifactRoot
    for (const component of splitPath(relative)) {
      pathParts.push(component)
      target = await this.fs.resolve(join(this.workspace, ...pathParts), resolveOptions(signal))
      if (!this.fs.contains(workspace, target)) throw new Error('artifact path escapes the session workspace')
      if (!this.fs.contains(artifactRoot, target)) throw new Error('artifact path escapes the configured artifact root')
    }
    return target
  }

  private async publish(target: FsTarget, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const destination = this.fs.processPath(target)
    const directory = dirname(destination)
    await mkdir(directory, { recursive: true })
    signal?.throwIfAborted()

    const temp = join(directory, `.${basename(destination)}.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temp, 'wx', 0o600)
      await handle.writeFile(bytes, signal === undefined ? undefined : { signal })
      await handle.sync()
      await handle.close()
      handle = undefined
      signal?.throwIfAborted()
      await (this.internals.rename ?? rename)(temp, destination)
    } catch (error) {
      let failure: unknown = error
      if (handle !== undefined) failure = await closeAfterFailure(handle, failure)
      try {
        await cleanupTemporaryFile(temp)
      } catch (cleanupError) {
        failure = new AggregateError([failure, cleanupError], 'artifact write and temporary cleanup both failed')
      }
      throw failure
    }
  }
}

/**
 * Validate a portable artifact-relative path without touching the filesystem.
 * @param relative - Candidate relative path.
 */
export function validateArtifactRelativePath(relative: string): void {
  if (relative.length === 0) throw new TypeError('artifact path must not be empty')
  if (relative.includes('\0')) throw new TypeError('artifact path must not contain NUL')
  if (isAbsolute(relative) || /^[A-Za-z]:[\\/]/u.test(relative)) throw new TypeError('artifact path must be relative')
  const components = splitPath(relative)
  if (components.some(component => component.length === 0)) throw new TypeError('artifact path must not contain empty components')
  for (const component of components) {
    if (component === '.' || component === '..') throw new TypeError('artifact path must not contain parent or dot segments')
    if (windowsDeviceName.test(component)) throw new TypeError('artifact path contains a Windows device name')
  }
}

/**
 * Validate an opaque identifier that becomes one artifact path component.
 * @param id - Candidate identifier.
 */
export function validateArtifactId(id: string): void {
  if (id.length === 0) throw new TypeError('artifact ID must not be empty')
  if (id.includes('/') || id.includes('\\')) throw new TypeError('artifact ID must not contain a path separator')
  validateArtifactRelativePath(id)
}

function splitPath(value: string): string[] {
  return value.split(/[\\/]/u)
}

function resolveOptions(signal: AbortSignal | undefined): { signal: AbortSignal } | undefined {
  return signal === undefined ? undefined : { signal }
}

function assertDifferentTargets(source: FsTarget, destination: FsTarget): void {
  if (source.targetKey === destination.targetKey) throw new Error('copy source and destination resolve to the same file')
}

async function closeAfterFailure(handle: Awaited<ReturnType<typeof open>>, primary: unknown): Promise<unknown> {
  try {
    await handle.close()
    return primary
  } catch (closeError) {
    return new AggregateError([primary, closeError], 'artifact write and temporary file close both failed')
  }
}

async function cleanupTemporaryFile(path: string): Promise<void> {
  try {
    await rm(path)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
}
