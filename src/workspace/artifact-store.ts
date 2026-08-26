import { createHash, randomUUID } from 'node:crypto'
import { open, link, lstat, mkdir, rename, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const windowsDeviceName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu

/** Native publication hooks used only to inject storage-boundary failures in tests. */
export interface ArtifactStoreInternals {
  rename?: (source: string, destination: string) => Promise<void>
  link?: (source: string, destination: string) => Promise<void>
  beforeNativeStage?: (paths: { destinationPath: string; directoryPath: string }) => void | Promise<void>
  beforeNativeCommit?: (paths: { destinationPath: string; tempPath: string }) => void | Promise<void>
  afterExclusiveStage?: (paths: { destinationPath: string; tempPath: string; directoryPath: string }) => void | Promise<void>
  beforeExclusiveLink?: (paths: { destinationPath: string; tempPath: string }) => void | Promise<void>
}

/** Private external-process output with explicit publication and cleanup. */
export interface ArtifactOutputStage {
  /** Canonically contained process path reserved for external CLI output. */
  readonly processPath: string
  /** Revalidate the private output reservation immediately before external spawn. */
  readonly beforeSpawn: (signal: AbortSignal) => Promise<void>
  /** Read and bind one complete non-empty regular staged output within a caller-supplied size limit. */
  read(maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>
  /**
   * Validate the staged output and atomically publish it to its final artifact path.
   * @param signal - Optional cancellation signal.
   * @param ownership - Per-attempt flag set only when this commit first creates the immutable destination.
   * @returns Completion after destination publication and private staging cleanup.
   */
  commit(signal?: AbortSignal, ownership?: ArtifactPublicationOwnership): Promise<void>
  /** Remove uncommitted staged output without touching a changed or escaping path. */
  cleanup(signal?: AbortSignal): Promise<void>
}

/** Mutable proof that one immutable artifact path was first created by the current attempt. */
export interface ArtifactPublicationOwnership {
  created: boolean
}

/** Immutable read authorization passed directly to a managed CLI spawn. */
export interface ArtifactReadAuthorization {
  /** Canonical path in the filesystem provider's process world. */
  readonly processPath: string
  /** Revalidate target identity, version, regular-file type, and content hash immediately before spawn. */
  readonly beforeSpawn: (signal: AbortSignal) => Promise<void>
}

/** Approval-bound exact-byte export that revalidates source, destination, and parent identities at commit. */
export interface ArtifactCopyOutAuthorization {
  readonly sourceRelative: string
  readonly destinationAbsolute: string
  readonly expectedSha256: string
  commitVerified(bytes: Uint8Array, signal?: AbortSignal): Promise<void>
}

/** Publication policy for one private external-process output. */
export interface ArtifactOutputOptions {
  /** Refuse to replace different bytes at an existing destination. */
  readonly immutable?: boolean
}

interface PublicationBinding {
  target: FsTarget
  parent: FsTarget
  relative?: string
}

interface ExistingAncestorBinding {
  path: string
  native: NativeIdentity
  missingSegments: readonly string[]
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
   * Read one contained artifact without allowing the filesystem provider to return more than a caller-owned limit.
   * @param relative - Artifact-relative path.
   * @param maxBytes - Positive byte limit no larger than the artifact-store maximum.
   * @param signal - Optional cancellation signal.
   * @returns Complete artifact bytes within the requested limit.
   */
  async readBounded(relative: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ARTIFACT_BYTES) throw new TypeError('artifact read limit is invalid')
    const target = await this.resolveContained(relative, signal)
    const info = await this.fs.stat(target, signal)
    if (info?.size !== undefined && info.size > maxBytes) throw new Error('artifact exceeds the requested read limit')
    return this.fs.readBytes(target, signal, maxBytes)
  }

  /**
   * Authorize one existing contained regular artifact as read-only CLI input.
   * @param relative - Artifact-relative input path.
   * @param expectedSha256 - Authenticated content hash that must remain current through spawn.
   * @param signal - Optional cancellation signal.
   * @returns Process path plus an immediate pre-spawn revalidation callback.
   */
  async authorizeRead(
    relative: string,
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<ArtifactReadAuthorization> {
    if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new TypeError('expected artifact SHA-256 must be 64 lowercase hexadecimal characters')
    const target = await this.resolveContained(relative, signal)
    const info = await this.fs.stat(target, signal)
    if (info === undefined) throw new Error('artifact input does not exist')
    if (info.type !== 'file') throw new Error('artifact input must be a regular file')
    const bytes = await this.fs.readBytes(target, signal, MAX_ARTIFACT_BYTES)
    if (sha256(bytes) !== expectedSha256) throw new Error('artifact input content changed before authorization')
    const targetKey = target.targetKey
    const version = info.version
    return {
      processPath: this.fs.processPath(target),
      beforeSpawn: async (spawnSignal: AbortSignal): Promise<void> => {
        spawnSignal.throwIfAborted()
        const current = await this.resolveContained(relative, spawnSignal)
        if (current.targetKey !== targetKey) throw new Error('artifact input target changed before spawn')
        const currentInfo = await this.fs.stat(current, spawnSignal)
        if (currentInfo === undefined || currentInfo.type !== 'file') throw new Error('artifact input is no longer the same regular file before spawn')
        if (currentInfo.version !== version) throw new Error('artifact input version changed before spawn')
        const currentBytes = await this.fs.readBytes(current, spawnSignal, MAX_ARTIFACT_BYTES)
        if (sha256(currentBytes) !== expectedSha256) throw new Error('artifact input content changed before spawn')
        const finalTarget = await this.resolveContained(relative, spawnSignal)
        const finalInfo = await this.fs.stat(finalTarget, spawnSignal)
        if (finalTarget.targetKey !== targetKey || finalInfo?.type !== 'file' || finalInfo.version !== version) {
          throw new Error('artifact input changed during spawn authorization')
        }
      },
    }
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
   * Publish an immutable content-addressed artifact or accept identical existing bytes.
   * @param relative - Artifact-relative destination.
   * @param bytes - Complete expected bytes.
   * @param signal - Optional cancellation signal.
   * @param ownership - Per-attempt flag updated immediately after first publication, including before later verification failures.
   * @returns The supplied or newly created ownership flag.
   */
  async writeIdenticalOrNew(
    relative: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
    ownership: ArtifactPublicationOwnership = { created: false },
  ): Promise<ArtifactPublicationOwnership> {
    try {
      const existing = await this.read(relative, signal)
      if (sha256(existing) !== sha256(bytes)) throw new Error('existing immutable artifact contains different bytes')
      return ownership
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'FS_NOT_FOUND')) throw error
    }
    await this.writeAtomic(relative, bytes, signal)
    ownership.created = true
    const published = await this.read(relative, signal)
    if (sha256(published) !== sha256(bytes)) throw new Error('immutable artifact changed during publication')
    return ownership
  }

  /**
   * Create one contained artifact with native exclusive-create semantics.
   * @param relative - Artifact-relative destination that must not already exist.
   * @param bytes - Complete bytes owned by this attempt.
   * @param signal - Optional cancellation signal.
   * @param ownership - Flag set immediately after the exclusive file is created.
   * @returns The supplied ownership flag after identity and byte verification.
   */
  async createExclusive(
    relative: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
    ownership: ArtifactPublicationOwnership = { created: false },
  ): Promise<ArtifactPublicationOwnership> {
    signal?.throwIfAborted()
    const target = await this.resolveContained(relative, signal)
    const destination = this.fs.processPath(target)
    const tempDirectoryRelative = `.exclusive/${randomUUID()}`
    const tempRelative = `${tempDirectoryRelative}/payload`
    const tempTarget = await this.resolveContained(tempRelative, signal)
    const tempParent = await this.resolveContained(tempDirectoryRelative, signal)
    await mkdir(dirname(destination), { recursive: true })
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let primary: unknown
    try {
      await mkdir(this.fs.processPath(tempParent), { recursive: true, mode: 0o700 })
      await this.internals.afterExclusiveStage?.({ destinationPath: destination, tempPath: this.fs.processPath(tempTarget), directoryPath: this.fs.processPath(tempParent) })
      signal?.throwIfAborted()
      const binding = await this.bindPublication(target, relative, signal)
      const boundTempParent = await this.revalidateContained(tempDirectoryRelative, tempParent, signal, 'exclusive temporary directory changed before write')
      const boundTemp = await this.revalidateContained(tempRelative, tempTarget, signal, 'exclusive temporary file changed before write')
      handle = await open(this.fs.processPath(boundTemp), 'wx', 0o600)
      await handle.writeFile(bytes, signal === undefined ? undefined : { signal })
      await handle.sync()
      await handle.close()
      handle = undefined
      signal?.throwIfAborted()
      await this.internals.beforeExclusiveLink?.({ destinationPath: this.fs.processPath(binding.target), tempPath: this.fs.processPath(boundTemp) })
      const current = await this.revalidateBinding(binding, signal)
      const currentTemp = await this.revalidateTemp(this.fs.processPath(boundTemp), boundTemp, boundTempParent, tempRelative, signal)
      try {
        await (this.internals.link ?? link)(this.fs.processPath(currentTemp), this.fs.processPath(current.target))
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
          const exists = new Error('exclusive artifact already exists') as Error & { code: string }
          exists.code = 'ARTIFACT_EXISTS'
          throw exists
        }
        throw error
      }
      ownership.created = true
      const info = await this.fs.stat(current.target, signal)
      if (info?.type !== 'file') throw new Error('exclusive artifact is not a regular file after creation')
      const currentBytes = await this.fs.readBytes(current.target, signal, MAX_ARTIFACT_BYTES)
      if (sha256(currentBytes) !== sha256(bytes)) throw new Error('exclusive artifact changed during creation')
    } catch (error) {
      primary = handle === undefined ? error : await closeAfterFailure(handle, error)
    }
    try {
      await this.cleanupStage(tempRelative, tempTarget, tempDirectoryRelative, tempParent)
    } catch (cleanupError) {
      if (primary === undefined) primary = cleanupError
    }
    if (primary !== undefined) throw primary
    return ownership
  }

  /**
   * Remove a regular artifact only while its canonical identity and bytes still match.
   * @param relative - Artifact-relative candidate owned by an uncommitted transaction.
   * @param expectedSha256 - Exact lowercase SHA-256 of the owned bytes.
   * @param signal - Optional cancellation signal.
   */
  async removeIfMatching(relative: string, expectedSha256: string, signal?: AbortSignal): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new TypeError('expected artifact SHA-256 must be 64 lowercase hexadecimal characters')
    let target: FsTarget
    try {
      target = await this.resolveContained(relative, signal)
      const info = await this.fs.stat(target, signal)
      if (info === undefined) return
      if (info.type !== 'file') return
      const bytes = await this.fs.readBytes(target, signal, MAX_ARTIFACT_BYTES)
      if (sha256(bytes) !== expectedSha256) return
      const current = await this.resolveContained(relative, signal)
      const currentInfo = await this.fs.stat(current, signal)
      if (current.targetKey !== target.targetKey || currentInfo?.type !== 'file') return
      const currentBytes = await this.fs.readBytes(current, signal, MAX_ARTIFACT_BYTES)
      if (sha256(currentBytes) !== expectedSha256) return
      await rm(this.fs.processPath(current))
    } catch (error) {
      if (error instanceof Error && (('code' in error && (error.code === 'FS_NOT_FOUND' || error.code === 'ENOENT')))) return
      throw error
    }
  }

  /**
   * Require one canonical contained artifact to remain beneath another.
   * @param parentRelative - Artifact-relative parent directory.
   * @param childRelative - Artifact-relative child artifact.
   * @param signal - Optional cancellation signal.
   */
  async assertContainedWithin(parentRelative: string, childRelative: string, signal?: AbortSignal): Promise<void> {
    const parent = await this.resolveContained(parentRelative, signal)
    const child = await this.resolveContained(childRelative, signal)
    if (!this.fs.contains(parent, child)) throw new Error('artifact must stay inside its immutable revision directory')
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
   * Bind one signed source and explicit destination across a later approval wait.
   * @param sourceRelative - Artifact-relative signed source.
   * @param expectedSha256 - Signed source/content digest.
   * @param destinationAbsolute - Explicit absolute external destination.
   * @param signal - Optional cancellation signal.
   * @returns Commit handle that writes only caller-supplied verified bytes.
   */
  async authorizeCopyOut(
    sourceRelative: string,
    expectedSha256: string,
    destinationAbsolute: string,
    signal?: AbortSignal,
  ): Promise<ArtifactCopyOutAuthorization> {
    if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new TypeError('expected export SHA-256 must be 64 lowercase hexadecimal characters')
    if (!isAbsolute(destinationAbsolute)) throw new TypeError('copyOut destination must be an absolute path')
    const source = await this.resolveContained(sourceRelative, signal)
    const sourceInfo = await this.fs.stat(source, signal)
    if (sourceInfo?.type !== 'file') throw new Error('export source must be a regular file')
    const sourceBytes = await this.fs.readBytes(source, signal, MAX_ARTIFACT_BYTES)
    if (sha256(sourceBytes) !== expectedSha256) throw new Error('export source does not match its signed digest')
    const sourceNative = await requireNativeFileIdentity(this.fs.processPath(source), 'export source')
    const destination = await this.fs.resolve(destinationAbsolute, resolveOptions(signal))
    assertDifferentTargets(source, destination)
    const destinationNative = await optionalNativeIdentity(this.fs.processPath(destination), 'export destination')
    if (destinationNative?.kind === 'directory') throw new Error('export destination must not be a directory')
    if (sameNativeIdentity(sourceNative, destinationNative)) throw new Error('copy source and destination are hard-link aliases')
    const parent = await this.fs.resolve(dirname(this.fs.processPath(destination)), resolveOptions(signal))
    const parentNative = await optionalNativeIdentity(this.fs.processPath(parent), 'export destination parent')
    if (parentNative !== undefined && parentNative.kind !== 'directory') throw new Error('export destination parent must be a directory')
    const ancestorBinding = await bindExistingAncestor(this.fs.processPath(parent), 'export destination parent')
    const sourceBinding = { targetKey: source.targetKey, version: sourceInfo.version, native: sourceNative }
    const destinationBinding = { targetKey: destination.targetKey, native: destinationNative }
    const parentBinding = { targetKey: parent.targetKey, native: parentNative }
    return {
      sourceRelative,
      destinationAbsolute,
      expectedSha256,
      commitVerified: async (bytes, commitSignal) => {
        if (sha256(bytes) !== expectedSha256) throw new Error('verified export bytes do not match the signed digest')
        await this.revalidateCopySource(sourceRelative, sourceBinding, expectedSha256, commitSignal)
        let currentDestination = await this.fs.resolve(destinationAbsolute, resolveOptions(commitSignal))
        let currentParent = await this.fs.resolve(dirname(this.fs.processPath(currentDestination)), resolveOptions(commitSignal))
        if (currentDestination.targetKey !== destinationBinding.targetKey || currentParent.targetKey !== parentBinding.targetKey) throw new Error('export destination or parent changed after approval')
        await requireSameNativeState(this.fs.processPath(currentDestination), destinationBinding.native, 'export destination')
        await requireSameNativeState(this.fs.processPath(currentParent), parentBinding.native, 'export destination parent')
        await requireMissingAncestry(ancestorBinding, 'export destination parent')
        const currentNative = await optionalNativeIdentity(this.fs.processPath(currentDestination), 'export destination')
        if (sameNativeIdentity(sourceBinding.native, currentNative)) throw new Error('copy source and destination are hard-link aliases')
        await mkdir(dirname(this.fs.processPath(currentDestination)), { recursive: true })
        currentDestination = await this.fs.resolve(destinationAbsolute, resolveOptions(commitSignal))
        currentParent = await this.fs.resolve(dirname(this.fs.processPath(currentDestination)), resolveOptions(commitSignal))
        if (currentDestination.targetKey !== destinationBinding.targetKey || currentParent.targetKey !== parentBinding.targetKey) throw new Error('export destination or parent changed during commit')
        await requireSameNativeState(ancestorBinding.path, ancestorBinding.native, 'export destination ancestor')
        const commitParentNative = await optionalNativeIdentity(this.fs.processPath(currentParent), 'export destination parent')
        if (commitParentNative?.kind !== 'directory') throw new Error('export destination parent must be a directory')
        await this.publishAuthorized({ target: currentDestination, parent: currentParent }, bytes, commitSignal, destinationBinding.native, commitParentNative, async () => {
          await this.revalidateCopySource(sourceRelative, sourceBinding, expectedSha256, commitSignal)
        })
        const published = await this.fs.resolve(destinationAbsolute, resolveOptions(commitSignal))
        if (published.targetKey !== destinationBinding.targetKey) throw new Error('export destination changed after commit')
        const publishedBytes = await this.fs.readBytes(published, commitSignal, MAX_ARTIFACT_BYTES)
        if (sha256(publishedBytes) !== expectedSha256) throw new Error('export destination bytes changed during commit')
      },
    }
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
  async stageOutput(
    destinationRelative: string,
    signal?: AbortSignal,
    options: ArtifactOutputOptions = {},
  ): Promise<ArtifactOutputStage> {
    this.resolve(destinationRelative)
    const stageDirectoryRelative = `.staging/${randomUUID()}`
    const stageRelative = `${stageDirectoryRelative}/output`
    const reservedTarget = await this.resolveContained(stageRelative, signal)
    const reservedParent = await this.resolveContained(stageDirectoryRelative, signal)
    await mkdir(this.fs.processPath(reservedParent), { recursive: true, mode: 0o700 })
    const parent = await this.revalidateContained(stageDirectoryRelative, reservedParent, signal, 'staging directory changed during reservation')
    const target = await this.revalidateContained(stageRelative, reservedTarget, signal, 'staging output changed during reservation')
    let state: 'open' | 'committed' | 'cleaned' = 'open'
    let validated: { sha256: string; version: string; maxBytes: number } | undefined

    const cleanup = async (cleanupSignal?: AbortSignal): Promise<void> => {
      if (state === 'cleaned') return
      await this.cleanupStage(stageRelative, target, stageDirectoryRelative, parent, cleanupSignal)
      state = 'cleaned'
    }

    return {
      processPath: this.fs.processPath(target),
      beforeSpawn: async (spawnSignal: AbortSignal): Promise<void> => {
        spawnSignal.throwIfAborted()
        const currentParent = await this.revalidateContained(
          stageDirectoryRelative,
          parent,
          spawnSignal,
          'staging directory changed before spawn',
        )
        const current = await this.revalidateContained(stageRelative, target, spawnSignal, 'staging output changed before spawn')
        if (this.fs.processPath(currentParent) !== dirname(this.fs.processPath(current))) {
          throw new Error('staging output left its reserved directory before spawn')
        }
        if (await this.fs.stat(current, spawnSignal) !== undefined) throw new Error('staging output already exists before spawn')
      },
      read: async (maxBytes: number, readSignal?: AbortSignal): Promise<Uint8Array> => {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ARTIFACT_BYTES) {
          throw new TypeError('staging output size limit must be a positive safe integer within the artifact limit')
        }
        if (state !== 'open') throw new Error('staging output is no longer open')
        const current = await this.revalidateContained(stageRelative, target, readSignal, 'staging output changed before validation')
        await this.revalidateContained(stageDirectoryRelative, parent, readSignal, 'staging directory changed before validation')
        const info = await this.fs.stat(current, readSignal)
        if (info === undefined || info.type !== 'file') throw new Error('staged output must be a regular file')
        if (info.size !== undefined && (info.size < 1 || info.size > maxBytes)) throw new Error('staged output size is outside the allowed range')
        const bytes = await this.fs.readBytes(current, readSignal, maxBytes)
        if (bytes.byteLength === 0) throw new Error('staged output must not be empty')
        const final = await this.revalidateContained(stageRelative, target, readSignal, 'staging output changed during validation')
        const finalInfo = await this.fs.stat(final, readSignal)
        if (finalInfo?.type !== 'file' || finalInfo.version !== info.version) throw new Error('staged output changed during validation')
        validated = { sha256: sha256(bytes), version: String(info.version), maxBytes }
        return bytes
      },
      commit: async (commitSignal?: AbortSignal, ownership: ArtifactPublicationOwnership = { created: false }): Promise<void> => {
        if (state !== 'open') throw new Error('staging output is no longer open')
        let current: FsTarget
        try {
          current = await this.revalidateContained(stageRelative, target, commitSignal, 'staging output changed before commit')
          await this.revalidateContained(stageDirectoryRelative, parent, commitSignal, 'staging directory changed before commit')
        } catch (error) {
          throw new Error('staging output changed or escaped before commit', { cause: error })
        }
        const binding = validated
        const info = await this.fs.stat(current, commitSignal)
        if (info === undefined || info.type !== 'file') throw new Error('staged output must be a regular file before commit')
        const bytes = await this.fs.readBytes(current, commitSignal, binding?.maxBytes ?? MAX_ARTIFACT_BYTES)
        if (binding !== undefined && (String(info.version) !== binding.version || sha256(bytes) !== binding.sha256)) {
          throw new Error('staged output changed after validation')
        }
        if (options.immutable === true) await this.writeIdenticalOrNew(destinationRelative, bytes, commitSignal, ownership)
        else await this.writeAtomic(destinationRelative, bytes, commitSignal)
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

  private async publishAuthorized(
    binding: PublicationBinding,
    bytes: Uint8Array,
    signal: AbortSignal | undefined,
    destinationNative: NativeIdentity | undefined,
    parentNative: NativeIdentity,
    prepareCommit: () => void | Promise<void>,
  ): Promise<void> {
    signal?.throwIfAborted()
    const destination = this.fs.processPath(binding.target)
    const directory = this.fs.processPath(binding.parent)
    await this.internals.beforeNativeStage?.({ destinationPath: destination, directoryPath: directory })
    const temp = join(directory, `.${basename(destination)}.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let tempTarget: FsTarget | undefined
    try {
      handle = await open(temp, 'wx', 0o600)
      tempTarget = await this.fs.resolve(temp, resolveOptions(signal))
      await this.revalidateTemp(temp, tempTarget, binding.parent, undefined, signal)
      await handle.writeFile(bytes, signal === undefined ? undefined : { signal })
      await handle.sync()
      await handle.close()
      handle = undefined
      signal?.throwIfAborted()
      await this.internals.beforeNativeCommit?.({ destinationPath: destination, tempPath: temp })
      await prepareCommit()
      const current = await this.revalidateBinding(binding, signal)
      const currentTemp = await this.revalidateTemp(temp, tempTarget, binding.parent, undefined, signal)
      await requireSameNativeState(this.fs.processPath(current.parent), parentNative, 'export destination parent')
      await requireSameNativeState(this.fs.processPath(current.target), destinationNative, 'export destination')
      await (this.internals.rename ?? rename)(this.fs.processPath(currentTemp), this.fs.processPath(current.target))
    } catch (error) {
      let failure: unknown = error
      if (handle !== undefined) failure = await closeAfterFailure(handle, failure)
      try { if (tempTarget !== undefined) await this.cleanupBoundTemp(temp, tempTarget, binding.parent) } catch (cleanupError) { failure = new AggregateError([failure, cleanupError], 'artifact export and temporary cleanup both failed') }
      throw failure
    }
  }

  private async revalidateCopySource(
    sourceRelative: string,
    binding: { targetKey: string; version: unknown; native: NativeIdentity },
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const source = await this.resolveContained(sourceRelative, signal)
    const info = await this.fs.stat(source, signal)
    if (source.targetKey !== binding.targetKey || info?.type !== 'file' || info.version !== binding.version) throw new Error('export source identity changed after approval')
    const native = await requireNativeFileIdentity(this.fs.processPath(source), 'export source')
    if (!sameNativeIdentity(native, binding.native)) throw new Error('export source identity changed after approval')
    const bytes = await this.fs.readBytes(source, signal, MAX_ARTIFACT_BYTES)
    if (sha256(bytes) !== expectedSha256) throw new Error('export source bytes changed after approval')
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

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface NativeIdentity { dev: number; ino: number; kind: 'file' | 'directory' }

async function bindExistingAncestor(path: string, field: string): Promise<ExistingAncestorBinding> {
  let current = path
  const missingSegments: string[] = []
  while (true) {
    const native = await optionalNativeIdentity(current, field)
    if (native !== undefined) {
      if (native.kind !== 'directory') throw new Error(`${field} ancestor must be a directory`)
      return { path: current, native, missingSegments: missingSegments.reverse() }
    }
    const parent = dirname(current)
    if (parent === current) throw new Error(`${field} has no existing directory ancestor`)
    missingSegments.push(basename(current))
    current = parent
  }
}

async function requireMissingAncestry(binding: ExistingAncestorBinding, field: string): Promise<void> {
  await requireSameNativeState(binding.path, binding.native, `${field} ancestor`)
  let current = binding.path
  for (const segment of binding.missingSegments) {
    current = join(current, segment)
    if (await optionalNativeIdentity(current, field) !== undefined) throw new Error(`${field} missing path changed after approval`)
  }
}

async function optionalNativeIdentity(path: string, field: string): Promise<NativeIdentity | undefined> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error(`${field} must not be a symlink or reparse alias`)
    if (!info.isFile() && !info.isDirectory()) throw new Error(`${field} must be a regular file or directory`)
    return { dev: info.dev, ino: info.ino, kind: info.isFile() ? 'file' : 'directory' }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function requireNativeFileIdentity(path: string, field: string): Promise<NativeIdentity> {
  const identity = await optionalNativeIdentity(path, field)
  if (identity?.kind !== 'file') throw new Error(`${field} must be a regular file`)
  return identity
}

async function requireSameNativeState(path: string, expected: NativeIdentity | undefined, field: string): Promise<void> {
  const current = await optionalNativeIdentity(path, field)
  if (expected === undefined ? current !== undefined : !sameNativeIdentity(expected, current) || current?.kind !== expected.kind) throw new Error(`${field} identity changed after approval`)
}

function sameNativeIdentity(left: NativeIdentity, right: NativeIdentity | undefined): boolean {
  return right !== undefined && left.dev === right.dev && left.ino === right.ino
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
