import { randomUUID } from 'node:crypto'
import { open, mkdir, rename, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const windowsDeviceName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu

/** Native publication hooks used only to inject storage-boundary failures in tests. */
export interface ArtifactStoreInternals {
  rename?: (source: string, destination: string) => Promise<void>
  beforeNativeStage?: (paths: { destinationPath: string; directoryPath: string }) => void | Promise<void>
  beforeNativeCommit?: (paths: { destinationPath: string; tempPath: string }) => void | Promise<void>
}

/** Private external-process output with explicit publication and cleanup. */
export interface ArtifactOutputStage {
  /** Canonically contained process path reserved for external CLI output. */
  readonly processPath: string
  /** Validate the staged output and atomically publish it to its final artifact path. */
  commit(signal?: AbortSignal): Promise<void>
  /** Remove uncommitted staged output without touching a changed or escaping path. */
  cleanup(signal?: AbortSignal): Promise<void>
}

interface PublicationBinding {
  target: FsTarget
  parent: FsTarget
  relative?: string
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
    await this.publish(target, bytes, signal, relative)
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
    await this.publish(destination, bytes, signal, destinationRelative)
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

  /**
   * Reserve a unique private output path for an external CLI process.
   *
   * Callers must pass only `processPath` to the CLI, then call `commit()` after
   * successful process completion. `commit()` revalidates and reads the staged
   * file before atomically publishing it. `cleanup()` abandons uncommitted
   * output. The lexical `resolve()` result is never a CLI output authorization.
   *
   * @param destinationRelative - Final artifact-relative publication path.
   * @param signal - Optional cancellation signal for reservation.
   * @returns Explicit staged-output lifecycle.
   */
  async stageOutput(destinationRelative: string, signal?: AbortSignal): Promise<ArtifactOutputStage> {
    this.resolve(destinationRelative)
    const stageDirectoryRelative = `.staging/${randomUUID()}`
    const stageRelative = `${stageDirectoryRelative}/output`
    const reservedTarget = await this.resolveContained(stageRelative, signal)
    const reservedParent = await this.resolveContained(stageDirectoryRelative, signal)
    await mkdir(this.fs.processPath(reservedParent), { recursive: true, mode: 0o700 })
    const parent = await this.revalidateContained(stageDirectoryRelative, reservedParent, signal, 'staging directory changed during reservation')
    const target = await this.revalidateContained(stageRelative, reservedTarget, signal, 'staging output changed during reservation')
    let state: 'open' | 'committed' | 'cleaned' = 'open'

    const cleanup = async (cleanupSignal?: AbortSignal): Promise<void> => {
      if (state === 'cleaned') return
      await this.cleanupStage(stageRelative, target, stageDirectoryRelative, parent, cleanupSignal)
      state = 'cleaned'
    }

    return {
      processPath: this.fs.processPath(target),
      commit: async (commitSignal?: AbortSignal): Promise<void> => {
        if (state !== 'open') throw new Error('staging output is no longer open')
        let current: FsTarget
        try {
          current = await this.revalidateContained(stageRelative, target, commitSignal, 'staging output changed before commit')
          await this.revalidateContained(stageDirectoryRelative, parent, commitSignal, 'staging directory changed before commit')
        } catch (error) {
          throw new Error('staging output changed or escaped before commit', { cause: error })
        }
        const bytes = await this.fs.readBytes(current, commitSignal, MAX_ARTIFACT_BYTES)
        await this.writeAtomic(destinationRelative, bytes, commitSignal)
        state = 'committed'
        await cleanup(commitSignal)
      },
      cleanup,
    }
  }

  /**
   * Return the opaque canonical identity used to serialize one artifact.
   * @param relative - Artifact-relative path.
   * @param signal - Optional cancellation signal.
   * @returns Backend-owned target identity; callers must compare only for equality.
   */
  async canonicalIdentity(relative: string, signal?: AbortSignal): Promise<string> {
    return this.resolveContained(relative, signal).then(target => target.targetKey)
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

  private async publish(
    target: FsTarget,
    bytes: Uint8Array,
    signal?: AbortSignal,
    relative?: string,
  ): Promise<void> {
    signal?.throwIfAborted()
    const initialDestination = this.fs.processPath(target)
    const initialDirectory = dirname(initialDestination)
    await mkdir(initialDirectory, { recursive: true })
    signal?.throwIfAborted()
    await this.internals.beforeNativeStage?.({ destinationPath: initialDestination, directoryPath: initialDirectory })

    const binding = await this.bindPublication(target, relative, signal)
    const destination = this.fs.processPath(binding.target)
    const directory = this.fs.processPath(binding.parent)

    const temp = join(directory, `.${basename(destination)}.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let tempTarget: FsTarget | undefined
    try {
      handle = await open(temp, 'wx', 0o600)
      tempTarget = await this.fs.resolve(temp, resolveOptions(signal))
      await this.revalidateTemp(temp, tempTarget, binding.parent, relative, signal)
      await handle.writeFile(bytes, signal === undefined ? undefined : { signal })
      await handle.sync()
      await handle.close()
      handle = undefined
      signal?.throwIfAborted()
      await this.internals.beforeNativeCommit?.({ destinationPath: destination, tempPath: temp })
      const current = await this.revalidateBinding(binding, signal)
      const currentTemp = await this.revalidateTemp(temp, tempTarget, binding.parent, relative, signal)
      await (this.internals.rename ?? rename)(
        this.fs.processPath(currentTemp),
        this.fs.processPath(current.target),
      )
    } catch (error) {
      let failure: unknown = error
      if (handle !== undefined) failure = await closeAfterFailure(handle, failure)
      try {
        if (tempTarget !== undefined) await this.cleanupBoundTemp(temp, tempTarget, binding.parent)
      } catch (cleanupError) {
        failure = new AggregateError([failure, cleanupError], 'artifact write and temporary cleanup both failed')
      }
      throw failure
    }
  }

  private async bindPublication(target: FsTarget, relative: string | undefined, signal?: AbortSignal): Promise<PublicationBinding> {
    let current: FsTarget
    try {
      current = relative === undefined
        ? await this.fs.resolve(this.fs.processPath(target), resolveOptions(signal))
        : await this.resolveContained(relative, signal)
    } catch (error) {
      throw new Error('artifact publication target changed after validation', { cause: error })
    }
    if (current.targetKey !== target.targetKey) throw new Error('artifact publication target changed after validation')
    const parent = await this.fs.resolve(dirname(this.fs.processPath(current)), resolveOptions(signal))
    if (relative !== undefined) await this.assertContainedTarget(parent, signal)
    return { target: current, parent, ...(relative === undefined ? {} : { relative }) }
  }

  private async revalidateBinding(binding: PublicationBinding, signal?: AbortSignal): Promise<PublicationBinding> {
    let current: FsTarget
    try {
      current = binding.relative === undefined
        ? await this.fs.resolve(this.fs.processPath(binding.target), resolveOptions(signal))
        : await this.resolveContained(binding.relative, signal)
    } catch (error) {
      throw new Error('artifact publication target changed before commit', { cause: error })
    }
    if (current.targetKey !== binding.target.targetKey) throw new Error('artifact publication target changed before commit')
    const parent = await this.fs.resolve(dirname(this.fs.processPath(current)), resolveOptions(signal))
    if (parent.targetKey !== binding.parent.targetKey) throw new Error('artifact publication directory changed before commit')
    if (binding.relative !== undefined) await this.assertContainedTarget(parent, signal)
    return { target: current, parent, ...(binding.relative === undefined ? {} : { relative: binding.relative }) }
  }

  private async revalidateTemp(
    path: string,
    expected: FsTarget,
    expectedParent: FsTarget,
    relative: string | undefined,
    signal?: AbortSignal,
  ): Promise<FsTarget> {
    const parent = await this.fs.resolve(dirname(path), resolveOptions(signal))
    if (parent.targetKey !== expectedParent.targetKey) throw new Error('artifact temporary directory changed before commit')
    const current = await this.fs.resolve(path, resolveOptions(signal))
    if (current.targetKey !== expected.targetKey) throw new Error('artifact temporary file changed before commit')
    if (relative !== undefined) await this.assertContainedTarget(current, signal)
    return current
  }

  private async cleanupBoundTemp(
    path: string,
    expected: FsTarget,
    expectedParent: FsTarget,
    signal?: AbortSignal,
  ): Promise<void> {
    const parent = await this.fs.resolve(dirname(path), resolveOptions(signal))
    if (parent.targetKey !== expectedParent.targetKey) return
    const current = await this.fs.resolve(path, resolveOptions(signal))
    if (current.targetKey !== expected.targetKey) return
    await cleanupTemporaryFile(this.fs.processPath(current))
  }

  private async cleanupStage(
    stageRelative: string,
    expectedTarget: FsTarget,
    directoryRelative: string,
    expectedDirectory: FsTarget,
    signal?: AbortSignal,
  ): Promise<void> {
    const currentDirectory = await this.revalidateContained(
      directoryRelative,
      expectedDirectory,
      signal,
      'staging directory changed before cleanup',
    )
    const currentTarget = await this.revalidateContained(
      stageRelative,
      expectedTarget,
      signal,
      'staging output changed before cleanup',
    )
    await cleanupTemporaryFile(this.fs.processPath(currentTarget))
    const checkedDirectory = await this.revalidateContained(
      directoryRelative,
      currentDirectory,
      signal,
      'staging directory changed during cleanup',
    )
    try {
      await rmdir(this.fs.processPath(checkedDirectory))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }

  private async revalidateContained(
    relative: string,
    expected: FsTarget,
    signal: AbortSignal | undefined,
    message: string,
  ): Promise<FsTarget> {
    const current = await this.resolveContained(relative, signal)
    if (current.targetKey !== expected.targetKey) throw new Error(message)
    return current
  }

  private async resolveStoreRoot(signal?: AbortSignal): Promise<FsTarget> {
    return this.fs.resolve(join(this.workspace, ...splitPath(this.rootRelative)), resolveOptions(signal))
  }

  private async assertContainedTarget(target: FsTarget, signal?: AbortSignal): Promise<void> {
    const workspace = await this.fs.resolve(this.workspace, resolveOptions(signal))
    const root = await this.resolveStoreRoot(signal)
    if (!this.fs.contains(workspace, target)) throw new Error('artifact path escapes the session workspace')
    if (!this.fs.contains(root, target)) throw new Error('artifact path escapes the configured artifact root')
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
    if (component.includes(':')) throw new TypeError('artifact path must not contain colon or alternate data streams')
    if (/[ .]$/u.test(component)) throw new TypeError('artifact path components must not end in a space or dot')
    const normalizedDeviceBase = component.split('.', 1)[0]!.replace(/[ .]+$/u, '')
    if (windowsDeviceName.test(normalizedDeviceBase)) throw new TypeError('artifact path contains a Windows device name')
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
