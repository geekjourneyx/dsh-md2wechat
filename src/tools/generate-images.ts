import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { CredentialEnvironmentName } from '../config.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CliEnvelope } from '../cli/protocol.ts'
import type { CliGateway } from '../cli/gateway.ts'
import { resolveOperationEnv } from '../security/credentials.ts'
import type { OperationCredentialServices } from '../security/credentials.ts'
import type { ArtifactPublicationOwnership, ArtifactStore } from '../workspace/artifact-store.ts'
import type { ImagePlanStateStore } from '../workspace/image-plan-state.ts'
import {
  acquireImageClaim,
  acquireRemoteImage,
  createPersistedImageResult,
  encodeCanonical,
  imageResultPath,
  loadImagePlan,
  loadVerifiedImageResult,
  releaseImageClaim,
  validatePlannedImageTarget,
  validateRemoteImageUrl,
} from '../workspace/images.ts'
import type {
  ImageClaim,
  LoadedImagePlan,
  LoadedImagePlanItem,
  RemoteImageAcquisitionOptions,
} from '../workspace/images.ts'
import { appendOperation } from '../workspace/revision.ts'
import { loadCurrentArticleRevision } from './improve-article.ts'
import type { CurrentArticleRevision } from './improve-article.ts'
import { imagePlanningArgv, projectImagePlanResponse } from './plan-images.ts'
import { domainResult, genericCall, genericResult } from './shared.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'md2wechat-image': 'md2wechat-image'
  }
}

const TOOL_NAME = 'md2wechat_generate_images'
const JOB_KIND = 'md2wechat-image'
const JOB_OUTPUT_LIMIT_BYTES = 16 * 1024
const MAX_PLAN_PATHS = 32
const MAX_BATCH_ITEMS = 128
const MAX_PLAN_INPUT_BYTES = 1024 * 1024
const REQUIRED_CREDENTIALS = ['IMAGE_API_KEY', 'WECHAT_APPID', 'WECHAT_SECRET'] as const satisfies readonly CredentialEnvironmentName[]

interface PreparedBatch {
  readonly current: CurrentArticleRevision
  readonly plans: readonly LoadedImagePlan[]
  readonly remaining: readonly { plan: LoadedImagePlan; item: LoadedImagePlanItem }[]
  readonly completedPaths: readonly string[]
}

/** Dependencies for approved fallback image generation. */
export interface GenerateImagesToolDependencies {
  gateway: CliGateway
  store: ArtifactStore
  state: ImagePlanStateStore
  credentialRefs: OperationCredentialServices['credentialRefs']
  credentials: OperationCredentialServices['credentials']
  approval: Pick<Context['approval'], 'request'>
  jobs: Pick<Context['jobs'], 'start' | 'get'>
  imageJobTimeoutMs: number
  imageMaxBytes: number
  imageMaxRedirects: number
  imageAcquisitionTimeoutMs: number
  acquire?: typeof acquireRemoteImage
  now?: () => Date
  claimNonce?: () => string
  claimOwnerIsLive?: (claim: ImageClaim) => boolean | Promise<boolean>
  reportAuditFailure: (message: string) => void
}

/** Create the one-approval background fallback image tool. */
export function createGenerateImagesTool({
  gateway,
  store,
  state,
  credentialRefs,
  credentials,
  approval,
  jobs,
  imageJobTimeoutMs,
  imageMaxBytes,
  imageMaxRedirects,
  imageAcquisitionTimeoutMs,
  acquire = acquireRemoteImage,
  now = () => new Date(),
  claimNonce,
  claimOwnerIsLive,
  reportAuditFailure,
}: GenerateImagesToolDependencies) {
  positiveInteger(imageJobTimeoutMs, 'image job timeout')
  positiveInteger(imageMaxBytes, 'maximum image bytes')
  nonNegativeInteger(imageMaxRedirects, 'maximum image redirects')
  positiveInteger(imageAcquisitionTimeoutMs, 'image acquisition timeout')
  if (typeof jobs.start !== 'function' || typeof jobs.get !== 'function') throw new TypeError('background job registry is required')
  if (typeof gateway.run !== 'function') throw new TypeError('CLI gateway is required')
  if (typeof store.read !== 'function' || typeof store.createExclusive !== 'function') throw new TypeError('artifact store is required')
  if (typeof state.initialize !== 'function' || typeof state.verify !== 'function') throw new TypeError('external image plan state store is required')
  if (typeof credentials.resolve !== 'function') throw new TypeError('credential resolver is required')
  if (typeof approval.request !== 'function') throw new TypeError('approval service is required')
  if (typeof reportAuditFailure !== 'function') throw new TypeError('image audit failure reporter is required')
  return defineTool({
    name: TOOL_NAME,
    description: 'Use the configured md2wechat image provider only when the DSH Agent has no image-generation capability; generation and WeChat material upload require one-time approval.',
    parameters: {
      manifestPath: { type: 'string', required: true, description: 'Current immutable article manifest path.' },
      planPaths: { type: 'array', required: true, items: { type: 'string' }, description: 'Immutable plan paths returned by md2wechat_plan_images.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['background', 'completed'] },
          jobId: { type: 'string' },
          planIds: { type: 'array', required: true, items: { type: 'string' } },
          resultPaths: { type: 'array', items: { type: 'string' } },
          pluginVersion: { type: 'string', const: '1.0.0', required: true },
          cliVersion: { type: 'string', const: '3.3.0', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `Fallback image job ${value.jobId ?? ''} started for ${value.planIds.length} approved plan(s).`
          : `All ${value.resultPaths?.length ?? 0} planned images are already complete.`,
      }],
    },
    async execute(args, exec) {
      try {
        assertKnownArguments(args, ['manifestPath', 'planPaths'])
        exec.signal.throwIfAborted()
        const planPaths = validatePlanPaths(args.planPaths)
        const prepared = await prepareBatch(gateway, store, state, args.manifestPath, planPaths, exec.signal)
        const planIds = prepared.plans.map(plan => plan.planId)
        if (prepared.remaining.length === 0) {
          return domainResult({ kind: 'completed' as const, planIds, resultPaths: [...prepared.completedPaths] })
        }
        if (exec.agent === undefined) throw new SafeGenerateImagesError('fallback image generation requires an active agent')
        assertConfiguredRefs(credentialRefs)
        const outcome = await approval.request({
          agent: exec.agent,
          toolName: TOOL_NAME,
          callId: exec.callId,
          signal: exec.signal,
          reason: 'The configured md2wechat image provider will generate the remaining images and upload each generated image to WeChat material storage.',
        })
        if (outcome !== 'allowed-once') throw new SafeGenerateImagesError(outcome === 'cancelled' ? 'fallback image generation was cancelled' : 'fallback image generation was not approved')
        exec.signal.throwIfAborted()
        let resolved: Awaited<ReturnType<typeof resolveOperationEnv>>
        try { resolved = await resolveOperationEnv(REQUIRED_CREDENTIALS, { credentialRefs, credentials }) }
        catch { throw new SafeGenerateImagesError('fallback image credentials could not be resolved') }
        for (const name of REQUIRED_CREDENTIALS) if (resolved.env[name] === undefined) throw new SafeGenerateImagesError('fallback image credentials are incomplete')
        exec.signal.throwIfAborted()

        const owner = exec.agent
        const registration = deferred<JobId | undefined>()
        const controller = new AbortController()
        let cancelRequested = false
        const worker = async (): Promise<JobOutcome> => {
          try {
            const jobId = await registration.promise
            if (jobId === undefined) return { status: 'failed', detail: 'registration failed', output: safeJobOutput('failed', prepared.remaining.length, 0, []) }
            return await runBatch({
              jobId, ownerSession: String(owner.id), prepared, gateway, store, env: resolved.env, secrets: resolved.secrets,
              signal: controller.signal, imageJobTimeoutMs, imageMaxBytes, imageMaxRedirects,
              imageAcquisitionTimeoutMs, acquire, now,
              ...(claimNonce === undefined ? {} : { claimNonce }),
              claimOwnerIsLive: claimOwnerIsLive ?? (claim => defaultClaimOwnerIsLive(jobs, claim, owner, imageJobTimeoutMs)),
              reportAuditFailure,
            })
          } catch {
            return controller.signal.aborted
              ? { status: 'killed', detail: 'cancelled', output: safeJobOutput('killed', prepared.remaining.length, 0, []) }
              : { status: 'failed', detail: 'image processing failed', output: safeJobOutput('failed', prepared.remaining.length, 0, []) }
          }
        }
        const done = Promise.resolve().then(worker).catch((): JobOutcome => ({ status: 'failed', detail: 'image processing failed' }))
        let jobId: JobId
        try {
          jobId = jobs.start({
            kind: JOB_KIND,
            label: `Generate ${prepared.remaining.length} approved WeChat image${prepared.remaining.length === 1 ? '' : 's'}`,
            outputLimitBytes: JOB_OUTPUT_LIMIT_BYTES,
            owner,
            run: () => ({
              cancel: () => { if (!cancelRequested) { cancelRequested = true; controller.abort(new Error('job cancelled')) } },
              done,
            }),
          })
        } catch {
          controller.abort(new Error('job registration failed'))
          registration.resolve(undefined)
          throw new SafeGenerateImagesError('fallback image background job could not be started')
        }
        setImmediate(() => registration.resolve(jobId))
        return domainResult({ kind: 'background' as const, jobId, planIds })
      } catch (error) {
        if (error instanceof SafeGenerateImagesError) throw error
        if (exec.signal.aborted) throw new SafeGenerateImagesError('fallback image generation was cancelled')
        throw new SafeGenerateImagesError('fallback image generation could not be prepared')
      }
    },
    presentCall: args => genericCall('Generate approved fallback images', 'edit', undefined, safePlanLocations(args.manifestPath, args.planPaths)),
    presentResult: () => genericResult('Fallback image generation submitted'),
  })
}

class SafeGenerateImagesError extends Error {}

interface RunBatchInput {
  jobId: JobId
  ownerSession: string
  prepared: PreparedBatch
  gateway: CliGateway
  store: ArtifactStore
  env: Readonly<Record<string, string>>
  secrets: readonly string[]
  signal: AbortSignal
  imageJobTimeoutMs: number
  imageMaxBytes: number
  imageMaxRedirects: number
  imageAcquisitionTimeoutMs: number
  acquire: typeof acquireRemoteImage
  now: () => Date
  claimNonce?: () => string
  claimOwnerIsLive: (claim: ImageClaim) => boolean | Promise<boolean>
  reportAuditFailure: (message: string) => void
}

async function runBatch(input: RunBatchInput): Promise<JobOutcome> {
  using lifetime = linkedDeadline(input.signal, input.imageJobTimeoutMs)
  const signal = lifetime.signal
  const resultPaths: string[] = []
  let failed = 0
  const snapshotPath = `revisions/${input.prepared.current.revision.id}/image-jobs/${input.jobId}-${randomUUID()}.json`
  const snapshot = encodeCanonical({
    schemaVersion: 1, jobId: input.jobId, sessionId: input.ownerSession,
    revisionId: input.prepared.current.revision.id, planIds: input.prepared.plans.map(plan => plan.planId),
    itemIds: input.prepared.remaining.map(entry => entry.item.id), createdAt: validNow(input.now).toISOString(),
  })
  const snapshotOwnership: ArtifactPublicationOwnership = { created: false }
  try {
    await input.store.createExclusive(snapshotPath, snapshot, signal, snapshotOwnership)
    for (const entry of input.prepared.remaining) {
      if (signal.aborted) break
      try {
        const resultPath = await processImageItem(input, entry.plan, entry.item, signal)
        resultPaths.push(resultPath)
      } catch {
        if (signal.aborted) break
        failed += 1
      }
    }
  } catch {
    if (!signal.aborted) failed = Math.max(failed, input.prepared.remaining.length - resultPaths.length)
  } finally {
    if (snapshotOwnership.created) await input.store.removeIfMatching(snapshotPath, sha256(snapshot)).catch(() => undefined)
  }
  if (signal.aborted) return { status: 'killed', detail: 'cancelled', output: safeJobOutput('killed', input.prepared.remaining.length, resultPaths.length, resultPaths) }
  if (failed > 0 || resultPaths.length !== input.prepared.remaining.length) return { status: 'failed', detail: 'partial failure', output: safeJobOutput('failed', input.prepared.remaining.length, resultPaths.length, resultPaths) }
  return { status: 'completed', detail: 'all images complete', output: safeJobOutput('completed', input.prepared.remaining.length, resultPaths.length, resultPaths) }
}

async function processImageItem(input: RunBatchInput, plan: LoadedImagePlan, item: LoadedImagePlanItem, signal: AbortSignal): Promise<string> {
  const ownership = await acquireImageClaim(input.store, plan, item, {
    jobId: input.jobId, sessionId: input.ownerSession, now: validNow(input.now), staleAfterMs: input.imageJobTimeoutMs,
    ownerIsLive: input.claimOwnerIsLive, ...(input.claimNonce === undefined ? {} : { nonce: input.claimNonce() }),
  }, signal)
  let targetOwnership: ArtifactPublicationOwnership = { created: false }
  try {
    const verifiedPlan = await loadImagePlan(input.store, plan.path, plan.revisionId, input.prepared.current.articlePath, signal)
    if (verifiedPlan.planId !== plan.planId) throw new Error('image plan changed before execution')
    const planAuthorization = await input.store.authorizeRead(plan.path, plan.contentSha256, signal)
    const current = await loadCurrentArticleRevision(input.store, input.prepared.current.manifestPath, signal)
    if (current.revision.id !== plan.revisionId) throw new Error('article revision changed before image execution')
    const argv = executionArgv(item, current.articleAuthorization.processPath)
    const response = await input.gateway.run(argv, {
      env: input.env, secrets: input.secrets, signal,
      beforeSpawn: async (spawnSignal) => {
        await planAuthorization.beforeSpawn(spawnSignal)
        if (expectsArticle(item)) await current.articleAuthorization.beforeSpawn(spawnSignal)
      },
    })
    const projected = projectImageResponse(response, item)
    const acquired = await input.acquire(projected.originalUrl, {
      maxBytes: input.imageMaxBytes, maxRedirects: input.imageMaxRedirects,
      timeoutMs: input.imageAcquisitionTimeoutMs, signal,
    } satisfies RemoteImageAcquisitionOptions)
    validatePlannedImageTarget(item.targetPath, acquired.mimeType)
    const result = createPersistedImageResult({
      plan, item, bytes: acquired.bytes, mimeType: acquired.mimeType,
      remoteUrl: projected.originalUrl, mediaId: projected.mediaId, wechatUrl: projected.wechatUrl,
      createdAt: validNow(input.now),
    })
    targetOwnership = await publishExclusiveOrIdentical(input.store, item.targetPath, acquired.bytes, signal, targetOwnership)
    const resultPath = imageResultPath(plan, item)
    try {
      await publishExclusiveOrIdentical(input.store, resultPath, encodeCanonical(result), signal)
    } catch (error) {
      if (targetOwnership.created) await input.store.removeIfMatching(item.targetPath, result.sha256).catch(() => undefined)
      throw error
    }
    try {
      await appendOperation(input.store, input.prepared.current.revision, {
        operation: item.kind === 'image' ? 'generate_image' : item.kind === 'cover' ? 'generate_cover' : 'generate_infographic', createdAt: result.createdAt,
        details: { planId: plan.planId, itemId: item.id, resultPath, targetPath: item.targetPath, sha256: result.sha256 },
      }, [])
    } catch {
      try { input.reportAuditFailure('md2wechat image audit record failed after committed result') } catch { /* reporter failures cannot undo committed image bytes */ }
    }
    return resultPath
  } finally {
    await releaseImageClaim(input.store, ownership).catch(() => undefined)
  }
}

async function prepareBatch(gateway: CliGateway, store: ArtifactStore, state: ImagePlanStateStore, manifestPath: string, planPaths: readonly string[], signal: AbortSignal): Promise<PreparedBatch> {
  await state.initialize(store, false, signal)
  const current = await loadCurrentArticleRevision(store, manifestPath, signal)
  const plans: LoadedImagePlan[] = []
  const remaining: Array<{ plan: LoadedImagePlan; item: LoadedImagePlanItem }> = []
  const completedPaths: string[] = []
  const planIds = new Set<string>()
  const itemIds = new Set<string>()
  const targets = new Set<string>()
  let itemCount = 0
  for (const path of planPaths) {
    const plan = await loadImagePlan(store, path, current.revision.id, current.articlePath, signal)
    const planBytes = await store.readBounded(path, MAX_PLAN_INPUT_BYTES, signal)
    if (createHash('sha256').update(planBytes).digest('hex') !== plan.contentSha256) throw new Error('image plan changed while it was being authenticated')
    await state.verify(store, {
      planPath: plan.path, planId: plan.planId, revisionId: plan.revisionId, items: plan.canonicalItems, planBytes,
    }, signal)
    if (planIds.has(plan.planId)) throw new Error('duplicate image plan IDs are not allowed')
    planIds.add(plan.planId)
    plans.push(plan)
    for (const item of plan.items) {
      const itemKey = item.id.normalize('NFC').toLowerCase()
      const targetKey = item.targetPath.normalize('NFC').toLowerCase()
      if (itemIds.has(itemKey) || [...targets].some(existing => targetKey === existing || targetKey.startsWith(`${existing}/`) || existing.startsWith(`${targetKey}/`))) throw new Error('duplicate image plan item or target alias')
      itemIds.add(itemKey); targets.add(targetKey)
      itemCount += 1
      if (itemCount > MAX_BATCH_ITEMS) throw new Error('image generation batch contains too many items')
    }
  }
  const authenticated = await loadCurrentArticleRevision(store, manifestPath, signal)
  if (authenticated.revision.id !== current.revision.id) throw new Error('article revision changed while authenticating image plans')
  for (const plan of plans) {
    for (const item of plan.items) {
      await verifyPresetProjection(gateway, current, item, signal)
      const result = await loadVerifiedImageResult(store, plan, item, signal)
      if (result === undefined) remaining.push({ plan, item })
      else completedPaths.push(imageResultPath(plan, item))
    }
  }
  const verified = await loadCurrentArticleRevision(store, manifestPath, signal)
  if (verified.revision.id !== current.revision.id) throw new Error('article revision changed while loading image plans')
  return { current, plans, remaining, completedPaths }
}

async function verifyPresetProjection(
  gateway: CliGateway,
  current: CurrentArticleRevision,
  item: LoadedImagePlanItem,
  signal: AbortSignal,
): Promise<void> {
  if (item.kind === 'image' && item.source.preset === undefined) return
  const response = await gateway.run(imagePlanningArgv(item.source, current.articleAuthorization.processPath), {
    signal,
    beforeSpawn: current.articleAuthorization.beforeSpawn,
  })
  const projected = projectImagePlanResponse(response, item.source, current)
  if (!Buffer.from(encodeCanonical(projected)).equals(Buffer.from(encodeCanonical(item.cliPlan)))) {
    throw new Error('image CLI plan does not match the md2wechat 3.3.0 projection')
  }
}

function executionArgv(item: LoadedImagePlanItem, article: string): readonly string[] {
  const command = item.kind === 'image' ? 'generate_image' : item.kind === 'cover' ? 'generate_cover' : 'generate_infographic'
  if (item.kind === 'image' && item.preset === undefined) return [command, item.prompt, ...(item.aspect === undefined ? [] : ['--aspect', item.aspect]), '--json']
  return [command, ...(item.kind === 'image' ? ['--preset', item.preset!] : []), '--article', article,
    ...(item.kind !== 'image' && item.preset !== undefined ? ['--preset', item.preset] : []),
    ...(item.aspect === undefined ? [] : ['--aspect', item.aspect]), '--json']
}

function expectsArticle(item: LoadedImagePlanItem): boolean { return item.kind !== 'image' || item.preset !== undefined }

function projectImageResponse(response: CliEnvelope, item: LoadedImagePlanItem): { originalUrl: string; mediaId: string; wechatUrl: string } {
  if (!response.success || response.code !== 'OK' || response.message !== 'Success' || response.schema_version !== 'v1' || response.status !== 'completed' || response.retryable !== false || response.error !== undefined || response.error_details !== undefined || response.next_actions !== undefined) throw new Error('md2wechat image generation did not complete successfully')
  const data = strictRecord(response.data, 'image response data')
  exactKeys(data, ['prompt', 'original_url', 'media_id', 'wechat_url', 'width', 'height'], 'image response data')
  if (data.prompt !== item.prompt) throw new Error('image response prompt does not match the immutable plan')
  safeInteger(data.width, 'image response width', 0)
  safeInteger(data.height, 'image response height', 0)
  return {
    originalUrl: validateRemoteImageUrl(requiredString(data.original_url, 'image original URL')),
    mediaId: safeOpaque(data.media_id, 'image media ID'),
    wechatUrl: validateRemoteImageUrl(requiredString(data.wechat_url, 'image WeChat URL')),
  }
}

async function publishExclusiveOrIdentical(
  store: ArtifactStore,
  path: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
  ownership: ArtifactPublicationOwnership = { created: false },
): Promise<ArtifactPublicationOwnership> {
  try {
    return await store.createExclusive(path, bytes, signal, ownership)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ARTIFACT_EXISTS')) throw error
    const existing = await store.read(path, signal)
    if (sha256(existing) !== sha256(bytes)) throw new Error('existing immutable image artifact contains different bytes')
    return ownership
  }
}

function safeJobOutput(status: 'completed' | 'failed' | 'killed', total: number, completed: number, resultPaths: readonly string[]): string {
  const complete = JSON.stringify({ status, total, completed, failed: total - completed, resultPaths })
  if (Buffer.byteLength(complete) <= JOB_OUTPUT_LIMIT_BYTES) return complete
  return JSON.stringify({ status, total, completed, failed: total - completed, resultPathsOmitted: true })
}

function defaultClaimOwnerIsLive(jobs: Pick<Context['jobs'], 'get'>, claim: ImageClaim, owner: NonNullable<Parameters<Context['jobs']['get']>[1]>, staleAfterMs: number): boolean {
  if (claim.sessionId !== String(owner.id)) return Date.now() - Date.parse(claim.createdAt) <= staleAfterMs
  try { const snapshot = jobs.get(claim.jobId as JobId, owner); return snapshot.status === 'running' || snapshot.status === 'stopping' } catch { return false }
}

function assertConfiguredRefs(refs: Readonly<Record<string, string>>): void { for (const name of REQUIRED_CREDENTIALS) if (typeof refs[name] !== 'string' || refs[name]!.length === 0) throw new SafeGenerateImagesError('fallback image credentials are not configured') }
function validatePlanPaths(value: readonly string[]): readonly string[] { if (!Array.isArray(value) || value.length === 0) throw new SafeGenerateImagesError('at least one image plan path is required'); if (value.length > MAX_PLAN_PATHS) throw new SafeGenerateImagesError('too many image plan paths'); if (!value.every(path => typeof path === 'string' && path.length > 0 && path.length <= 1200)) throw new SafeGenerateImagesError('image plan paths must be bounded non-empty strings'); if (new Set(value).size !== value.length) throw new SafeGenerateImagesError('duplicate image plan paths are not allowed'); return [...value] }
function safePlanLocations(manifestPath: string, planPaths: readonly string[]): readonly string[] { const safeManifest = /^revisions\/[a-f0-9]{64}\/manifest\.json$/u.test(manifestPath) ? [manifestPath] : []; const safePlans = Array.isArray(planPaths) ? planPaths.filter(path => typeof path === 'string' && /^revisions\/[a-f0-9]{64}\/plans\/[a-f0-9]{64}\.json$/u.test(path)) : []; return [...safeManifest, ...safePlans] }
function assertKnownArguments(value: object, allowed: readonly string[]): void { const keys = new Set(allowed); for (const key of Object.keys(value)) if (!keys.has(key)) throw new SafeGenerateImagesError(`unknown ${TOOL_NAME} argument`) }
function strictRecord(value: unknown, field: string): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${field} must be an object`); return value as Record<string, unknown> }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void { const expected = new Set(keys); if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !expected.has(key))) throw new Error(`${field} contains unknown or missing fields`) }
function requiredString(value: unknown, field: string): string { if (typeof value !== 'string') throw new Error(`${field} must be a string`); return value }
function safeOpaque(value: unknown, field: string): string { const text = requiredString(value, field); if (text.trim().length === 0 || new TextEncoder().encode(text).byteLength > 512 || containsControl(text)) throw new Error(`${field} is invalid`); return text }
function safeInteger(value: unknown, field: string, minimum: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${field} must be a safe integer`); return value }
function positiveInteger(value: number, field: string): void { safeInteger(value, field, 1) }
function nonNegativeInteger(value: number, field: string): void { safeInteger(value, field, 0) }
function validNow(now: () => Date): Date { const value = now(); if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('image job clock is invalid'); return value }
function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } { let resolve!: (value: T) => void; const promise = new Promise<T>(settle => { resolve = settle }); return { promise, resolve } }
function linkedDeadline(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; [Symbol.dispose](): void } { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error('image job timed out')), timeoutMs); timer.unref(); const abort = (): void => controller.abort(parent.reason); if (parent.aborted) abort(); else parent.addEventListener('abort', abort, { once: true }); return { signal: controller.signal, [Symbol.dispose]() { clearTimeout(timer); parent.removeEventListener('abort', abort) } } }
function containsControl(value: string): boolean { return [...value].some(character => { const code = character.codePointAt(0)!; return code <= 0x1f || code === 0x7f }) }
