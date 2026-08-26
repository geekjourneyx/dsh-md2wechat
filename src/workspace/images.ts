import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { PLUGIN_VERSION, SUPPORTED_CLI_VERSION } from '../version.ts'
import { validateArtifactId, validateArtifactRelativePath } from './artifact-store.ts'
import type { ArtifactPublicationOwnership, ArtifactStore } from './artifact-store.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const planPathPattern = /^revisions\/([a-f0-9]{64})\/plans\/([a-f0-9]{64})\.json$/u
const HASH_PATTERN = /^[a-f0-9]{64}$/u
const MAX_PLAN_BYTES = 1024 * 1024
const MAX_PLAN_ITEMS = 128
const MAX_PLAN_ARRAY_ITEMS = 128
const MAX_PLAN_STRING_BYTES = 16 * 1024
const BUNDLED_PRESET_DEFAULT_ASPECT = new Map<string, string>([
  ['cover-claude-warm', '21:9'], ['cover-data-visual', '16:9'], ['cover-default', '16:9'],
  ['cover-editorial', '16:9'], ['cover-editorial-collage', '21:9'], ['cover-hero', '16:9'],
  ['cover-illustrated', '16:9'], ['cover-metaphor', '16:9'], ['cover-minimal', '16:9'],
  ['cover-semantic-concept', '21:9'], ['cover-suspense-black-gold', '2.35:1'],
  ['infographic-apple-keynote-premium', '3:4'], ['infographic-bento', '3:4'],
  ['infographic-claude-warm', '21:9'], ['infographic-comparison', '3:4'],
  ['infographic-dark-ticket-cn', '21:9'], ['infographic-dashboard', '3:4'],
  ['infographic-default', '3:4'], ['infographic-flat-vector-panorama', '21:9'],
  ['infographic-handdrawn-sketchnote', '3:4'], ['infographic-hierarchy', '3:4'],
  ['infographic-process', '3:4'], ['infographic-ticket-process', '21:9'],
  ['infographic-timeline', '3:4'], ['infographic-victorian-engraving-banner', '21:9'],
])

/** One image operation authenticated by an immutable plan file. */
export interface ImagePlanItem {
  id: string
  kind: 'image' | 'cover' | 'infographic'
  prompt: string
  targetPath: string
  preset?: string
  aspect?: string
}

/** Public persisted image-result fields consumed by later workflow steps. */
export interface ImageResult {
  planId: string
  targetPath: string
  sha256: string
  provider?: string
  remoteUrl?: string
}

/** Strictly loaded plan item retaining the authoritative CLI projection. */
export interface LoadedImagePlanItem extends ImagePlanItem {
  readonly source: ImagePlanItem
  readonly cliPlan: Readonly<Record<string, JsonValue>>
}

/** Strict immutable image plan loaded from artifact storage. */
export interface LoadedImagePlan {
  readonly schemaVersion: 1
  readonly planId: string
  readonly revisionId: string
  readonly createdAt: string
  readonly path: string
  readonly contentSha256: string
  readonly items: readonly LoadedImagePlanItem[]
  readonly canonicalItems: readonly JsonValue[]
}

/** Immutable completed-image record, including item identity and safe WeChat metadata. */
export interface PersistedImageResult extends ImageResult {
  readonly schemaVersion: 1
  readonly itemId: string
  readonly revisionId: string
  readonly mediaId: string
  readonly wechatUrl: string
  readonly contentType: SupportedImageMime
  readonly byteSize: number
  readonly pluginVersion: typeof PLUGIN_VERSION
  readonly cliVersion: typeof SUPPORTED_CLI_VERSION
  readonly createdAt: string
}

/** Durable exclusive ownership marker for one running item. */
export interface ImageClaim {
  readonly schemaVersion: 1
  readonly planId: string
  readonly itemId: string
  readonly targetPath: string
  readonly jobId: string
  readonly sessionId: string
  readonly createdAt: string
  readonly nonce: string
}

/** Claim handle whose release is content- and nonce-matched. */
export interface ImageClaimOwnership {
  readonly path: string
  readonly claim: ImageClaim
  readonly sha256: string
}

/** Raster MIME types accepted for artifact publication. */
export type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/** Validated remote raster bytes and canonical content metadata. */
export interface AcquiredRemoteImage {
  readonly bytes: Uint8Array
  readonly mimeType: SupportedImageMime
  readonly extension: '.png' | '.jpg' | '.gif' | '.webp'
  readonly finalUrl: string
}

/** One pinned HTTPS request after URL and DNS validation. */
export interface PinnedHttpsRequest {
  readonly url: string
  readonly hostname: string
  readonly port: number
  readonly path: string
  readonly address: string
  readonly servername: string
  readonly signal: AbortSignal
  readonly maxBytes: number
  readonly ca?: string | Buffer
}

/** Minimal response returned by an injectable pinned HTTPS transport. */
export interface PinnedHttpsResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
  readonly body: Uint8Array
}

/** Dependencies and tunables for safe remote image acquisition. */
export interface RemoteImageAcquisitionOptions {
  readonly maxBytes: number
  readonly maxRedirects: number
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  readonly resolve?: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>
  readonly request?: (request: PinnedHttpsRequest) => Promise<PinnedHttpsResponse>
}

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** Recompute the same content-addressed identifier emitted by the planning tool. */
export function canonicalImagePlanId(revisionId: string, items: unknown): string {
  if (!HASH_PATTERN.test(revisionId)) throw new TypeError('image plan revision ID is invalid')
  return sha256(encoder.encode(canonicalJson({ revisionId, items })))
}

/** Load and authenticate one immutable Task 5 image plan. */
export async function loadImagePlan(
  store: ArtifactStore,
  planPath: string,
  expectedRevisionId: string,
  expectedArticlePath: string,
  signal?: AbortSignal,
): Promise<LoadedImagePlan> {
  const match = planPathPattern.exec(planPath)
  if (match === null || match[1] !== expectedRevisionId) throw new Error('image plan path is not bound to the current revision')
  let parsed: unknown
  let planBytes: Uint8Array
  try {
    planBytes = await store.readBounded(planPath, MAX_PLAN_BYTES, signal)
    if (planBytes.byteLength > MAX_PLAN_BYTES) throw new Error('image plan exceeds the one-megabyte input limit')
    parsed = JSON.parse(decoder.decode(planBytes))
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new Error('image plan is not valid UTF-8 JSON')
    throw new Error('image plan exceeds the one-megabyte input limit or cannot be read safely')
  }
  if (sha256(planBytes) !== sha256(encodeCanonical(parsed))) throw new Error('image plan must use canonical JSON encoding')
  const root = record(parsed, 'image plan')
  exactKeys(root, ['schemaVersion', 'planId', 'revisionId', 'createdAt', 'items'], 'image plan')
  literal(root.schemaVersion, 1, 'image plan schemaVersion')
  const planId = hash(root.planId, 'image plan planId')
  if (match[2] !== planId) throw new Error('image plan path does not match its plan ID')
  const revisionId = hash(root.revisionId, 'image plan revisionId')
  if (revisionId !== expectedRevisionId) throw new Error('image plan revision does not match the current revision')
  const createdAt = canonicalTimestamp(root.createdAt, 'image plan createdAt')
  const rawItems = array(root.items, 'image plan items')
  if (rawItems.length === 0) throw new Error('image plan must contain at least one item')
  if (rawItems.length > MAX_PLAN_ITEMS) throw new Error('image plan contains too many items')
  const ids = new Set<string>()
  const targets = new Set<string>()
  const canonicalItems: JsonValue[] = []
  const items = rawItems.map((raw, index) => {
    const item = record(raw, `image plan item ${index}`)
    exactKeys(item, ['original', 'targetArtifactPath', 'cliPlan'], `image plan item ${index}`)
    const original = record(item.original, `image plan item ${index} original`)
    exactOptionalKeys(original, ['id', 'kind', 'prompt', 'targetPath'], ['preset', 'aspect'], `image plan item ${index} original`)
    const id = boundedText(original.id, `image plan item ${index} id`, 128)
    validateArtifactId(id)
    if (id.normalize('NFC') !== id || /[<>"|?*]/u.test(id) || containsControl(id)) throw new Error('image plan item ID is not portable')
    const portableId = id.normalize('NFC').toLowerCase()
    if (ids.has(portableId)) throw new Error('image plan contains duplicate item IDs')
    ids.add(portableId)
    const kind = enumValue(original.kind, ['image', 'cover', 'infographic'] as const, `image plan item ${index} kind`)
    const originalPrompt = boundedText(original.prompt, `image plan item ${index} prompt`, 16_384)
    const localTarget = boundedText(original.targetPath, `image plan item ${index} targetPath`, 1024)
    if (!localTarget.startsWith('images/') || localTarget.includes('\\') || localTarget.includes('..') || localTarget.startsWith('/')) {
      throw new Error('image plan target must stay beneath revision-local images')
    }
    validateArtifactRelativePath(localTarget)
    const targetPath = boundedText(item.targetArtifactPath, `image plan item ${index} targetArtifactPath`, 1200)
    if (targetPath !== `revisions/${revisionId}/${localTarget}`) throw new Error('image plan target path does not match its revision-local target')
    validatePlannedImageTarget(targetPath)
    const targetAlias = targetPath.normalize('NFC').toLowerCase()
    if ([...targets].some(existing => targetAlias === existing || targetAlias.startsWith(`${existing}/`) || existing.startsWith(`${targetAlias}/`))) throw new Error('image plan contains colliding target aliases')
    targets.add(targetAlias)
    const preset = optionalBoundedText(original.preset, `image plan item ${index} preset`, 256)
    const aspect = optionalBoundedText(original.aspect, `image plan item ${index} aspect`, 64)
    const cliPlan = validateCliPlan(item.cliPlan, {
      kind, prompt: originalPrompt, expectedArticlePath,
      ...(preset === undefined ? {} : { preset }),
      ...(aspect === undefined ? {} : { aspect }),
    }, index)
    validateProviderVisibleValue(cliPlan, `image plan item ${index} cliPlan`)
    const canonicalOriginal: Record<string, JsonValue> = { id, kind, prompt: originalPrompt, targetPath: localTarget }
    if (preset !== undefined) canonicalOriginal.preset = preset
    if (aspect !== undefined) canonicalOriginal.aspect = aspect
    canonicalItems.push({ original: canonicalOriginal, targetArtifactPath: targetPath, cliPlan })
    const resolvedPreset = boundedPlanString(cliPlan.preset, 'image plan CLI preset')
    const resolvedAspect = boundedPlanString(cliPlan.aspect, 'image plan CLI aspect')
    const source: ImagePlanItem = { id, kind, prompt: originalPrompt, targetPath: localTarget,
      ...(preset === undefined ? {} : { preset }), ...(aspect === undefined ? {} : { aspect }) }
    return { id, kind, prompt: boundedPlanString(cliPlan.prompt, 'image plan CLI prompt', false), targetPath, source,
      ...(resolvedPreset === '' ? {} : { preset: resolvedPreset }), ...(resolvedAspect === '' ? {} : { aspect: resolvedAspect }), cliPlan }
  })
  if (canonicalImagePlanId(revisionId, canonicalItems) !== planId) throw new Error('image plan ID does not match its canonical payload')
  return { schemaVersion: 1, planId, revisionId, createdAt, path: planPath, contentSha256: sha256(planBytes), items, canonicalItems }
}

/** Parse and verify one completed image result against current artifact bytes. */
export async function loadVerifiedImageResult(
  store: ArtifactStore,
  plan: LoadedImagePlan,
  item: LoadedImagePlanItem,
  signal?: AbortSignal,
): Promise<PersistedImageResult | undefined> {
  const path = imageResultPath(plan, item)
  let bytes: Uint8Array
  try {
    bytes = await store.read(path, signal)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw new Error('image result could not be read safely')
  }
  let value: unknown
  try { value = JSON.parse(decoder.decode(bytes)) } catch { throw new Error('image result is corrupt') }
  const result = validatePersistedImageResult(value, plan, item)
  validatePlannedImageTarget(item.targetPath, result.contentType)
  let target: Uint8Array
  try { target = await store.read(item.targetPath, signal) } catch { throw new Error('completed image bytes are missing') }
  if (target.byteLength !== result.byteSize || sha256(target) !== result.sha256) throw new Error('completed image bytes do not match the immutable result')
  validateImageBytes(result.contentType, target)
  return result
}

/** Artifact-relative immutable result path for one plan item. */
export function imageResultPath(plan: Pick<LoadedImagePlan, 'revisionId' | 'planId'>, item: Pick<ImagePlanItem, 'id'>): string {
  return `revisions/${plan.revisionId}/image-results/${plan.planId}/${item.id}.json`
}

/** Artifact-relative exclusive claim path for one plan item. */
export function imageClaimPath(revisionId: string, targetIdentityHash: string): string {
  if (!HASH_PATTERN.test(revisionId) || !HASH_PATTERN.test(targetIdentityHash)) throw new TypeError('image claim identity is invalid')
  return `revisions/${revisionId}/image-claims/targets/${targetIdentityHash}.json`
}

/** Atomically claim one image item, optionally reaping an exactly revalidated stale owner. */
export async function acquireImageClaim(
  store: ArtifactStore,
  plan: LoadedImagePlan,
  item: LoadedImagePlanItem,
  input: { jobId: JobId | string; sessionId: string; now: Date; staleAfterMs: number; ownerIsLive: (claim: ImageClaim) => boolean | Promise<boolean>; nonce?: string },
  signal?: AbortSignal,
): Promise<ImageClaimOwnership> {
  if (!Number.isSafeInteger(input.staleAfterMs) || input.staleAfterMs < 1) throw new TypeError('claim stale timeout must be a positive safe integer')
  const targetIdentity = await store.canonicalIdentity(item.targetPath, signal)
  const path = imageClaimPath(plan.revisionId, sha256(encoder.encode(targetIdentity)))
  const claim: ImageClaim = {
    schemaVersion: 1, planId: plan.planId, itemId: item.id, targetPath: item.targetPath,
    jobId: boundedText(String(input.jobId), 'claim job ID', 128),
    sessionId: boundedText(input.sessionId, 'claim session ID', 256),
    createdAt: validDate(input.now, 'claim clock').toISOString(),
    nonce: boundedText(input.nonce ?? randomUUID(), 'claim nonce', 128),
  }
  const bytes = encodeCanonical(claim)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ownership: ArtifactPublicationOwnership = { created: false }
    try {
      await store.createExclusive(path, bytes, signal, ownership)
      return { path, claim, sha256: sha256(bytes) }
    } catch (error) {
      if (ownership.created && !isExists(error)) {
        await store.removeIfMatching(path, sha256(bytes)).catch(() => undefined)
        throw error
      }
      if (!isExists(error)) throw error
      const existingBytes = await store.read(path, signal)
      let existing: ImageClaim
      try { existing = validateClaim(JSON.parse(decoder.decode(existingBytes))) } catch {
        await store.removeIfMatching(path, sha256(existingBytes), signal)
        continue
      }
      let existingIdentity: string
      try { existingIdentity = await store.canonicalIdentity(existing.targetPath, signal) } catch {
        await store.removeIfMatching(path, sha256(existingBytes), signal)
        continue
      }
      if (existingIdentity !== targetIdentity) {
        await store.removeIfMatching(path, sha256(existingBytes), signal)
        continue
      }
      if (await input.ownerIsLive(existing)) throw new Error('image item is already claimed by a live job')
      await store.removeIfMatching(path, sha256(existingBytes), signal)
    }
  }
  throw new Error('image item claim changed during stale-owner recovery')
}

/** Release only the exact claim bytes created by this owner. */
export async function releaseImageClaim(store: ArtifactStore, ownership: ImageClaimOwnership, signal?: AbortSignal): Promise<void> {
  await store.removeIfMatching(ownership.path, ownership.sha256, signal)
}

/** Validate and canonicalize one provider URL before any network work. */
export function validateRemoteImageUrl(input: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 4096) throw new Error('image URL is invalid')
  let url: URL
  try { url = new URL(input) } catch { throw new Error('image URL is invalid') }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') throw new Error('image URL must be credential-free fragment-free HTTPS')
  if (url.hostname.length < 1 || url.hostname.length > 253 || url.pathname.length + url.search.length > 3072) throw new Error('image URL is outside safe bounds')
  if (url.href !== input) throw new Error('image URL must use canonical HTTPS syntax')
  return url.href
}

/** Return whether an IP address is eligible for a pinned public HTTPS connection. */
export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPublicIpv4(address)
  if (family !== 6) return false
  const bytes = parseIpv6(address)
  if (bytes === undefined) return false
  if (bytes.slice(0, 10).every(value => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return false
  }
  if (bytes.every(value => value === 0) || bytes.slice(0, 15).every(value => value === 0) && bytes[15] === 1) return false
  if ((bytes[0]! & 0xfe) === 0xfc || bytes[0] === 0xff || bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return false
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return false
  if (bytes[0] === 0x01 && bytes.slice(1, 8).every(value => value === 0)) return false
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && (bytes[2]! & 0xfe) === 0) return false
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false
  if (bytes[0] === 0x26 && bytes[1] === 0x20 && bytes[2] === 0x00 && bytes[3] === 0x4f && bytes[4] === 0x80 && bytes[5] === 0x00) return false
  if (bytes[0] === 0x3f && (bytes[1]! & 0xf0) === 0xf0) return false
  if (bytes[0] === 0x5f) return false
  return (bytes[0]! & 0xe0) === 0x20
}

/** Acquire image bytes through validated redirects and DNS-pinned HTTPS. */
export async function acquireRemoteImage(input: string, options: RemoteImageAcquisitionOptions): Promise<AcquiredRemoteImage> {
  validateAcquisitionOptions(options)
  using deadline = createDeadline(options.signal, options.timeoutMs)
  const resolve = options.resolve ?? resolveAddresses
  const transport = options.request ?? nodePinnedHttpsRequest
  let current = validateRemoteImageUrl(input)
  const seen = new Set<string>()
  for (let redirects = 0; ; redirects += 1) {
    deadline.signal.throwIfAborted()
    if (seen.has(current)) throw new Error('image redirect loop is not allowed')
    seen.add(current)
    const url = new URL(current)
    const addresses = await awaitWithAbort(() => resolve(url.hostname, deadline.signal), deadline.signal)
    if (addresses.length === 0 || addresses.some(address => !isPublicNetworkAddress(address))) throw new Error('image host must resolve only to public network addresses')
    const address = addresses[0]!
    const response = await awaitWithAbort(() => transport({
      url: current, hostname: url.hostname, port: url.port === '' ? 443 : Number(url.port),
      path: `${url.pathname}${url.search}`, address, servername: url.hostname,
      signal: deadline.signal, maxBytes: options.maxBytes,
    }), deadline.signal)
    if (response.body.byteLength > options.maxBytes) throw new Error('image response exceeds the configured byte limit')
    if (response.status >= 300 && response.status < 400) {
      if (redirects >= options.maxRedirects) throw new Error('image redirect limit exceeded')
      const location = singleHeader(response.headers, 'location')
      if (location === undefined) throw new Error('image redirect location is missing')
      current = validateRemoteImageUrl(new URL(location, current).href)
      continue
    }
    if (response.status < 200 || response.status >= 300) throw new Error('image server returned a non-success status')
    rejectContentEncoding(response.headers)
    const contentType = parseContentType(singleRequiredHeader(response.headers, 'content-type'))
    const contentLength = positiveContentLength(singleRequiredHeader(response.headers, 'content-length'), options.maxBytes)
    if (response.body.byteLength !== contentLength || response.body.byteLength > options.maxBytes || response.body.byteLength === 0) throw new Error('image body size does not match the safe content length')
    validateImageBytes(contentType, response.body)
    return { bytes: new Uint8Array(response.body), mimeType: contentType, extension: extensionForMime(contentType), finalUrl: current }
  }
}

/** Build a strict immutable result record after bytes and response fields are validated. */
export function createPersistedImageResult(input: {
  plan: LoadedImagePlan; item: LoadedImagePlanItem; bytes: Uint8Array; mimeType: SupportedImageMime;
  remoteUrl: string; mediaId: string; wechatUrl: string; createdAt: Date
}): PersistedImageResult {
  validateImageBytes(input.mimeType, input.bytes)
  return {
    schemaVersion: 1, planId: input.plan.planId, itemId: input.item.id, revisionId: input.plan.revisionId,
    targetPath: input.item.targetPath, sha256: sha256(input.bytes), remoteUrl: validateRemoteImageUrl(input.remoteUrl),
    mediaId: safeOpaque(input.mediaId, 'image media ID'), wechatUrl: validateRemoteImageUrl(input.wechatUrl),
    contentType: input.mimeType, byteSize: input.bytes.byteLength,
    pluginVersion: PLUGIN_VERSION, cliVersion: SUPPORTED_CLI_VERSION,
    createdAt: validDate(input.createdAt, 'image result clock').toISOString(),
  }
}

/** Validate a planned target's canonical raster extension, optionally against a MIME type. */
export function validatePlannedImageTarget(path: string, mimeType?: SupportedImageMime): void {
  const extension = path.slice(path.lastIndexOf('.'))
  if (!['.png', '.jpg', '.gif', '.webp'].includes(extension)) throw new Error('planned image target must use .png, .jpg, .gif, or .webp')
  if (mimeType !== undefined && extension !== extensionForMime(mimeType)) throw new Error('planned image target extension does not match its content type')
}

/** Encode JSON in the repository's canonical key order with one trailing newline. */
export function encodeCanonical(value: unknown): Uint8Array {
  return encoder.encode(`${canonicalJson(value)}\n`)
}

function validateCliPlan(value: unknown, expected: { kind: ImagePlanItem['kind']; prompt: string; preset?: string; aspect?: string; expectedArticlePath: string }, index: number): Readonly<Record<string, JsonValue>> {
  const cli = record(value, `image plan item ${index} cliPlan`)
  exactKeys(cli, ['mode', 'command', 'execution_owner', 'side_effects', 'requires_provider', 'requires_image_api_key', 'prompt', 'raw_prompt', 'preset', 'archetype', 'primary_use_case', 'compatible_use_cases', 'recommended_aspect_ratios', 'default_aspect_ratio', 'article', 'title', 'summary', 'keywords', 'style', 'aspect', 'size', 'model_hint', 'suggested_filename', 'alt_text'], `image plan item ${index} cliPlan`)
  const command = expected.kind === 'image' ? 'generate_image' : expected.kind === 'cover' ? 'generate_cover' : 'generate_infographic'
  literal(cli.mode, 'plan', 'image CLI plan mode')
  literal(cli.command, command, 'image CLI plan command')
  literal(cli.execution_owner, 'host_agent', 'image CLI plan execution owner')
  literal(cli.side_effects, false, 'image CLI plan side effects')
  literal(cli.requires_provider, false, 'image CLI plan provider requirement')
  literal(cli.requires_image_api_key, false, 'image CLI plan key requirement')
  const prompt = boundedPlanString(cli.prompt, 'image CLI plan prompt', false)
  const rawPrompt = boundedPlanString(cli.raw_prompt, 'image CLI plan raw_prompt')
  const article = boundedPlanString(cli.article, 'image CLI plan article')
  const expectsArticle = expected.kind !== 'image' || expected.preset !== undefined
  if (article !== (expectsArticle ? expected.expectedArticlePath : '')) throw new Error('image CLI plan article binding is invalid')
  const resolvedPreset = boundedPlanString(cli.preset, 'image CLI plan preset')
  const resolvedAspect = boundedPlanString(cli.aspect, 'image CLI plan aspect')
  const defaultAspect = boundedPlanString(cli.default_aspect_ratio, 'image CLI plan default_aspect_ratio')
  const archetype = boundedPlanString(cli.archetype, 'image CLI plan archetype')
  const primaryUseCase = boundedPlanString(cli.primary_use_case, 'image CLI plan primary_use_case')
  const compatibleUseCases = stringArray(cli.compatible_use_cases, 'image CLI plan compatible_use_cases')
  const recommendedAspects = stringArray(cli.recommended_aspect_ratios, 'image CLI plan recommended_aspect_ratios')
  if (expected.kind === 'image' && expected.preset === undefined) {
    if (prompt !== expected.prompt || rawPrompt !== expected.prompt.trim()) throw new Error('raw image CLI plan prompt does not match the approved prompt')
    if (resolvedPreset !== '' || resolvedAspect !== '' || defaultAspect !== '') throw new Error('raw image CLI plan must not resolve preset metadata')
  } else {
    if (rawPrompt !== '') throw new Error('preset image CLI plan raw prompt must be empty')
    const approvedPreset = (expected.preset ?? (expected.kind === 'cover' ? 'cover-default' : 'infographic-default')).trim().toLowerCase()
    if (resolvedPreset.toLowerCase() !== approvedPreset) throw new Error('image CLI plan preset does not match the approved preset')
    const bundledDefault = BUNDLED_PRESET_DEFAULT_ASPECT.get(approvedPreset)
    if (bundledDefault === undefined) throw new Error('image CLI plan preset is not bundled with md2wechat 3.3.0')
    const approvedAspect = expected.aspect?.trim() ?? bundledDefault
    if (resolvedAspect !== approvedAspect) throw new Error('image CLI plan aspect does not match the approved or bundled default aspect')
    if (defaultAspect !== bundledDefault) throw new Error('image CLI plan preset default aspect does not match md2wechat 3.3.0')
    if (defaultAspect === '' || !recommendedAspects.includes(defaultAspect)) throw new Error('image CLI plan default aspect is not recommended by its preset')
  }
  if (expected.kind !== 'image' && ![archetype, primaryUseCase, ...compatibleUseCases].some(value => value.toLowerCase() === expected.kind)) {
    throw new Error(`${expected.kind} CLI plan must resolve a compatible preset`)
  }
  for (const key of ['title', 'summary', 'keywords', 'style', 'size', 'model_hint', 'suggested_filename', 'alt_text']) boundedPlanString(cli[key], `image CLI plan ${key}`)
  return { ...cli, prompt }
}

function validatePersistedImageResult(value: unknown, plan: LoadedImagePlan, item: LoadedImagePlanItem): PersistedImageResult {
  const result = record(value, 'image result')
  exactOptionalKeys(result, ['schemaVersion', 'planId', 'itemId', 'revisionId', 'targetPath', 'sha256', 'mediaId', 'wechatUrl', 'contentType', 'byteSize', 'pluginVersion', 'cliVersion', 'createdAt'], ['remoteUrl'], 'image result')
  literal(result.schemaVersion, 1, 'image result schemaVersion')
  literal(result.planId, plan.planId, 'image result planId')
  literal(result.itemId, item.id, 'image result itemId')
  literal(result.revisionId, plan.revisionId, 'image result revisionId')
  literal(result.targetPath, item.targetPath, 'image result targetPath')
  const contentType = enumValue(result.contentType, ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const, 'image result contentType')
  const byteSize = safeInteger(result.byteSize, 'image result byteSize', 1)
  const remoteUrl = optionalUrl(result.remoteUrl, 'image result remoteUrl')
  return {
    schemaVersion: 1, planId: plan.planId, itemId: item.id, revisionId: plan.revisionId, targetPath: item.targetPath,
    sha256: hash(result.sha256, 'image result sha256'), mediaId: safeOpaque(result.mediaId, 'image result media ID'),
    wechatUrl: validateRemoteImageUrl(stringValue(result.wechatUrl, 'image result WeChat URL')),
    contentType, byteSize, pluginVersion: literal(result.pluginVersion, PLUGIN_VERSION, 'image result pluginVersion'),
    cliVersion: literal(result.cliVersion, SUPPORTED_CLI_VERSION, 'image result cliVersion'),
    createdAt: canonicalTimestamp(result.createdAt, 'image result createdAt'),
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
  }
}

function validateClaim(value: unknown): ImageClaim {
  const claim = record(value, 'image claim')
  exactKeys(claim, ['schemaVersion', 'planId', 'itemId', 'targetPath', 'jobId', 'sessionId', 'createdAt', 'nonce'], 'image claim')
  const itemId = boundedText(claim.itemId, 'image claim itemId', 128)
  validateArtifactId(itemId)
  const targetPath = boundedText(claim.targetPath, 'image claim targetPath', 1200)
  validateArtifactRelativePath(targetPath)
  return {
    schemaVersion: literal(claim.schemaVersion, 1, 'image claim schemaVersion'),
    planId: hash(claim.planId, 'image claim planId'), itemId, targetPath,
    jobId: boundedText(claim.jobId, 'image claim jobId', 128), sessionId: boundedText(claim.sessionId, 'image claim sessionId', 256),
    createdAt: canonicalTimestamp(claim.createdAt, 'image claim createdAt'), nonce: boundedText(claim.nonce, 'image claim nonce', 128),
  }
}

function validateAcquisitionOptions(options: RemoteImageAcquisitionOptions): void {
  safeInteger(options.maxBytes, 'maximum image bytes', 1)
  safeInteger(options.maxRedirects, 'maximum image redirects', 0)
  safeInteger(options.timeoutMs, 'image acquisition timeout', 1)
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const value = ((parts[0]! * 0x1000000) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0
  return ![
    [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
    [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24], [0xc01fc400, 24], [0xc034c100, 24],
    [0xc0586300, 24], [0xc0a80000, 16], [0xc0af3000, 24], [0xc6120000, 15],
    [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
  ].some(([network, prefix]) => inIpv4Range(value, network!, prefix!))
}

function inIpv4Range(value: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (value & mask) >>> 0 === (network & mask) >>> 0
}

function parseIpv6(address: string): Uint8Array | undefined {
  let source = address.toLowerCase()
  let tail: number[] = []
  if (source.includes('.')) {
    const boundary = source.lastIndexOf(':')
    const ipv4 = source.slice(boundary + 1).split('.').map(Number)
    if (ipv4.length !== 4 || ipv4.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return undefined
    tail = [(ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!]
    source = `${source.slice(0, boundary)}:${tail.map(value => value.toString(16)).join(':')}`
  }
  const halves = source.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] === '' ? [] : halves[0]!.split(':')
  const right = halves.length === 1 || halves[1] === '' ? [] : halves[1]!.split(':')
  const missing = 8 - left.length - right.length
  if (missing < (halves.length === 2 ? 1 : 0)) return undefined
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right].map(word => Number.parseInt(word, 16))
  if (words.length !== 8 || words.some(word => !Number.isInteger(word) || word < 0 || word > 0xffff)) return undefined
  return Uint8Array.from(words.flatMap(word => [word >> 8, word & 0xff]))
}

async function resolveAddresses(hostname: string, signal: AbortSignal): Promise<readonly string[]> {
  const { lookup } = await import('node:dns/promises')
  signal.throwIfAborted()
  const answers = await lookup(hostname, { all: true, verbatim: true })
  signal.throwIfAborted()
  return answers.map(answer => answer.address)
}

export async function nodePinnedHttpsRequest(options: PinnedHttpsRequest): Promise<PinnedHttpsResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: 'https:', hostname: options.hostname, port: options.port, path: options.path,
      method: 'GET', servername: options.servername, headers: { host: new URL(options.url).host, 'accept-encoding': 'identity' },
      lookup: (_hostname, lookupOptions, callback) => {
        const family = isIP(options.address) as 4 | 6
        const requestedFamily = typeof lookupOptions === 'object' ? lookupOptions.family : lookupOptions
        if ((requestedFamily === 4 || requestedFamily === 6) && requestedFamily !== family) {
          const mismatch = new Error('pinned address does not match the requested address family') as NodeJS.ErrnoException
          mismatch.code = 'EAI_ADDRFAMILY'
          callback(mismatch, options.address, family)
          return
        }
        if (typeof lookupOptions === 'object' && lookupOptions.all === true) {
          ;(callback as (error: null, addresses: readonly { address: string; family: 4 | 6 }[]) => void)(null, [{ address: options.address, family }])
        } else {
          ;(callback as (error: null, address: string, family: 4 | 6) => void)(null, options.address, family)
        }
      },
      ...(options.ca === undefined ? {} : { ca: options.ca }),
      signal: options.signal,
    }, response => {
      const chunks: Uint8Array[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > options.maxBytes) response.destroy(new Error('image body exceeds the configured byte limit'))
        else chunks.push(new Uint8Array(chunk))
      })
      response.once('error', reject)
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers as Readonly<Record<string, string | readonly string[] | undefined>>,
        body: Uint8Array.from(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))),
      }))
    })
    request.once('error', reject)
    request.end()
  })
}

function createDeadline(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; [Symbol.dispose](): void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('image acquisition timed out')), timeoutMs)
  timer.unref()
  const abort = (): void => controller.abort(parent?.reason)
  if (parent?.aborted) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  return { signal: controller.signal, [Symbol.dispose]() { clearTimeout(timer); parent?.removeEventListener('abort', abort) } }
}

function awaitWithAbort<T>(operation: () => T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const settle = (complete: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      complete()
    }
    const abort = (): void => settle(() => reject(signal.reason ?? new Error('image acquisition cancelled')))
    signal.addEventListener('abort', abort, { once: true })
    try {
      Promise.resolve(operation()).then(
        value => settle(() => resolve(value)),
        error => settle(() => reject(error)),
      )
    } catch (error) {
      settle(() => reject(error))
    }
    if (signal.aborted) abort()
  })
}

function parseContentType(value: string): SupportedImageMime {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'image/png' || normalized === 'image/jpeg' || normalized === 'image/gif' || normalized === 'image/webp') return normalized
  throw new Error('image content type is not a supported raster format')
}

function extensionForMime(value: SupportedImageMime): AcquiredRemoteImage['extension'] {
  switch (value) { case 'image/png': return '.png'; case 'image/jpeg': return '.jpg'; case 'image/gif': return '.gif'; case 'image/webp': return '.webp' }
}

function validateImageBytes(type: SupportedImageMime, bytes: Uint8Array): void {
  const matches = type === 'image/png' ? starts(bytes, [137, 80, 78, 71, 13, 10, 26, 10])
    : type === 'image/jpeg' ? starts(bytes, [0xff, 0xd8, 0xff])
      : type === 'image/gif' ? starts(bytes, [71, 73, 70, 56, 55, 97]) || starts(bytes, [71, 73, 70, 56, 57, 97])
        : starts(bytes, [82, 73, 70, 70]) && bytes.length >= 12 && starts(bytes.slice(8), [87, 69, 66, 80])
  if (!matches) throw new Error('image bytes do not match the declared raster content type')
}

function starts(bytes: Uint8Array, prefix: readonly number[]): boolean { return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value) }
function positiveContentLength(value: string, maximum: number): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error('image content length is invalid or exceeds the configured limit'); return parsed }
function rejectContentEncoding(headers: PinnedHttpsResponse['headers']): void { const value = singleHeader(headers, 'content-encoding'); if (value !== undefined && value.toLowerCase() !== 'identity') throw new Error('encoded image bodies are not accepted') }
function singleRequiredHeader(headers: PinnedHttpsResponse['headers'], name: string): string { const value = singleHeader(headers, name); if (value === undefined) throw new Error(`image response ${name} is required`); return value }
function singleHeader(headers: PinnedHttpsResponse['headers'], name: string): string | undefined { const value = headers[name] ?? headers[name.toLowerCase()]; if (Array.isArray(value)) { if (value.length !== 1) throw new Error(`image response ${name} must be single-valued`); return value[0] } return value as string | undefined }
function optionalUrl(value: unknown, field: string): string | undefined { if (value === undefined) return undefined; try { return validateRemoteImageUrl(stringValue(value, field)) } catch { throw new Error(`${field} is invalid`) } }
function safeOpaque(value: unknown, field: string): string { const text = stringValue(value, field); if (text.length > 512 || containsControl(text) || text.trim().length === 0) throw new Error(`${field} is invalid`); return text }
function canonicalTimestamp(value: unknown, field: string): string { const text = stringValue(value, field); const date = new Date(text); if (Number.isNaN(date.getTime()) || date.toISOString() !== text) throw new Error(`${field} must be a canonical timestamp`); return text }
function validDate(value: Date, field: string): Date { if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${field} is invalid`); return value }
function record(value: unknown, field: string): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${field} must be an object`); return value as Record<string, unknown> }
function array(value: unknown, field: string): readonly unknown[] { if (!Array.isArray(value)) throw new Error(`${field} must be an array`); return value }
function stringArray(value: unknown, field: string): readonly string[] { if (!Array.isArray(value) || value.length > MAX_PLAN_ARRAY_ITEMS || !value.every(item => typeof item === 'string')) throw new Error(`${field} must contain a bounded string array`); return value.map((item, index) => boundedPlanString(item, `${field} item ${index}`)) }
function stringValue(value: unknown, field: string): string { if (typeof value !== 'string') throw new Error(`${field} must be a string`); return value }
function boundedText(value: unknown, field: string, limit: number): string { const text = stringValue(value, field); if (text.trim().length === 0 || encoder.encode(text).byteLength > limit || containsControl(text)) throw new Error(`${field} is invalid`); return text }
function optionalBoundedText(value: unknown, field: string, limit: number): string | undefined { return value === undefined ? undefined : boundedText(value, field, limit) }
function safeInteger(value: unknown, field: string, minimum: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${field} must be a safe integer of at least ${minimum}`); return value }
function hash(value: unknown, field: string): string { const text = stringValue(value, field); if (!HASH_PATTERN.test(text)) throw new Error(`${field} is invalid`); return text }
function enumValue<const T extends string>(value: unknown, values: readonly T[], field: string): T { if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${field} is invalid`); return value as T }
function literal<const T extends string | number | boolean>(value: unknown, expected: T, field: string): T { if (value !== expected) throw new Error(`${field} must be ${String(expected)}`); return expected }
function exactKeys(value: Record<string, unknown>, required: readonly string[], field: string): void { exactOptionalKeys(value, required, [], field) }
function exactOptionalKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], field: string): void { const allowed = new Set([...required, ...optional]); for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${field} contains unknown field ${key}`); for (const key of required) if (!(key in value)) throw new Error(`${field} is missing field ${key}`) }
function canonicalJson(value: unknown): string { return JSON.stringify(sortJson(value)) }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sortJson(item)])); return value }
function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && (error.code === 'FS_NOT_FOUND' || error.code === 'ENOENT') }
function isExists(error: unknown): boolean { return error instanceof Error && 'code' in error && (error.code === 'ARTIFACT_EXISTS' || error.code === 'EEXIST') }
function containsControl(value: string): boolean { return [...value].some(character => { const code = character.codePointAt(0)!; return code <= 0x1f || code === 0x7f }) }
function boundedPlanString(value: unknown, field: string, allowEmpty = true): string { const text = stringValue(value, field); if ((!allowEmpty && text.trim().length === 0) || encoder.encode(text).byteLength > MAX_PLAN_STRING_BYTES || containsUnsafePlanControl(text)) throw new Error(`${field} exceeds its safe string limit`); return text }
function validateProviderVisibleValue(value: JsonValue, field: string): void {
  if (typeof value === 'string') { if (containsProcessPath(value)) throw new Error(`${field} contains an absolute or process path`); return }
  if (Array.isArray(value)) { if (value.length > MAX_PLAN_ARRAY_ITEMS) throw new Error(`${field} contains too many array values`); value.forEach((item, index) => validateProviderVisibleValue(item, `${field}[${index}]`)); return }
  if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) validateProviderVisibleValue(item, `${field}.${key}`)
}
function containsProcessPath(value: string): boolean {
  const withoutUrls = value.replace(/https:\/\/[^\s"'<>]+/giu, '')
  return /(?:^|[\s("'`=,:;[\]{}<>])\/(?!\/)[^\s]+/u.test(withoutUrls)
    || /(?:^|[\s("'`=,:;[\]{}<>])[A-Za-z]:[\\/][^\s]+/u.test(withoutUrls)
    || /(?:^|[\s("'`=,:;[\]{}<>])(?:\\\\|\/\/)[^\s\\/]+[\\/][^\s]+/u.test(withoutUrls)
    || /(?:^|[\s("'`=,:;[\]{}<>])~[\\/][^\s]+/u.test(withoutUrls)
    || /file:\/\//iu.test(withoutUrls)
}
function containsUnsafePlanControl(value: string): boolean { return [...value].some(character => { const code = character.codePointAt(0)!; return code <= 0x08 || code === 0x0b || code === 0x0c || code >= 0x0e && code <= 0x1f || code === 0x7f }) }
