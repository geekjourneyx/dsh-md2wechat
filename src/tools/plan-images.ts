import { PLUGIN_VERSION } from '../version.ts'
import { createHash } from 'node:crypto'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { probeCliVersion } from '../cli/gateway.ts'
import type { CliGateway } from '../cli/gateway.ts'
import { validateArtifactId, validateArtifactRelativePath } from '../workspace/artifact-store.ts'
import type { ArtifactStore } from '../workspace/artifact-store.ts'
import type { ImagePlanStateStore } from '../workspace/image-plan-state.ts'
import { encodeCanonical } from '../workspace/images.ts'
import { domainResult, genericCall, genericResult } from './shared.ts'
import { loadCurrentArticleRevision } from './improve-article.ts'

export interface PlanImagesToolDependencies {
  gateway: CliGateway
  store: ArtifactStore
  state: ImagePlanStateStore
  now?: () => Date
}

const MAX_PLAN_OUTPUT_BYTES = 1024 * 1024

const imageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true, enum: ['image', 'cover', 'infographic'] },
    prompt: { type: 'string', required: true },
    targetPath: { type: 'string', required: true },
    preset: { type: 'string' },
    aspect: { type: 'string' },
  },
} as const

/** Run image planning against the caller-supplied artifact and authority stores. */
export function createPlanImagesOperation(dependencies: PlanImagesToolDependencies) {
  const { gateway, store, state } = dependencies
  return async (
    args: { manifestPath: string; images: readonly ImagePlanSource[] },
    exec: Pick<ToolRunContext, 'signal'>,
  ) => {
  assertKnownArguments(args, ['manifestPath', 'images'])
  await state.initialize(store, true, exec.signal)
  const cliVersion = await probeCliVersion(gateway, exec.signal)
  const current = await loadCurrentArticleRevision(store, args.manifestPath, exec.signal)
  const normalized = normalizeImages(args.images, current.revision.id)
  const items: JsonValue[] = []
  for (const item of normalized) {
    const argv = imagePlanningArgv(item.original, current.articleAuthorization.processPath)
    const response = await gateway.run(argv, {
      signal: exec.signal,
      beforeSpawn: current.articleAuthorization.beforeSpawn,
    })
    const cliPlan = projectImagePlanResponse(response, item.original, current)
    items.push({ original: item.original, targetArtifactPath: item.targetArtifactPath, cliPlan })
  }
  const verified = await loadCurrentArticleRevision(store, args.manifestPath, exec.signal)
  if (verified.revision.articleSha256 !== current.revision.articleSha256) {
    throw new Error('stale revision: article changed while preparing the image plan')
  }
  if (new TextEncoder().encode(canonicalJson(items)).byteLength > MAX_PLAN_OUTPUT_BYTES) {
    throw new Error('combined image plan exceeds the one-megabyte output limit')
  }
  const planId = sha256(canonicalJson({ revisionId: current.revision.id, items }))
  const planPath = `revisions/${current.revision.id}/plans/${planId}.json`
  if (new TextEncoder().encode(renderPlanItems(planPath, items)).byteLength > MAX_PLAN_OUTPUT_BYTES) {
    throw new Error('rendered image plan exceeds the one-megabyte output limit')
  }
  const persisted = {
    schemaVersion: 1,
    planId,
    revisionId: current.revision.id,
    createdAt: current.revision.createdAt,
    items,
  }
  const planBytes = encodeCanonical(persisted)
  await state.publish(store, { planPath, planId, revisionId: current.revision.id, items, planBytes }, exec.signal)
  await publishStablePlan(store, planPath, planBytes, exec.signal)
  return domainResult({
    revisionId: current.revision.id,
    manifestPath: current.manifestPath,
    planId,
    planPath,
    items,
    locations: [current.articlePath, current.manifestPath, planPath, ...normalized.map(item => item.targetArtifactPath)],
  }, cliVersion)
  }
}

/**
 * Create the side-effect-free image planning tool.
 * @param dependencies - CLI gateway, artifact store, and external plan authority.
 * @returns Registry-ready typed DSH tool.
 */
export function createPlanImagesTool(dependencies: PlanImagesToolDependencies) {
  const operation = createPlanImagesOperation(dependencies)
  return defineTool({
    name: 'md2wechat_plan_images',
    description: 'Prepare replayable image plans for the current article without generating images or using credentials.',
    parameters: {
      manifestPath: { type: 'string', required: true, description: 'Manifest path returned by md2wechat_start_article.' },
      images: { type: 'array', required: true, items: imageSchema, description: 'Unique image requests and revision-relative targets.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          revisionId: { type: 'string', required: true },
          manifestPath: { type: 'string', required: true },
          planId: { type: 'string', required: true },
          planPath: { type: 'string', required: true },
          items: { type: 'array', required: true, items: { type: 'json' } },
          locations: { type: 'array', required: true, items: { type: 'string' } },
          pluginVersion: { type: 'string', const: PLUGIN_VERSION, required: true },
          cliVersion: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderPlanItems(value.planPath, value.items),
      }],
    },
    execute: operation,
    presentCall: args => genericCall('Plan article images', 'edit', args.images, planLocations(args.manifestPath, args.images)),
    presentResult: () => genericResult('Image plan ready'),
  })
}

/** Approved image fields used to derive one md2wechat planning invocation. */
export type ImagePlanSource = {
  id: string
  kind: 'image' | 'cover' | 'infographic'
  prompt: string
  targetPath: string
  preset?: string
  aspect?: string
}

interface NormalizedImage {
  original: ImagePlanSource
  targetArtifactPath: string
}

function normalizeImages(images: readonly ImagePlanSource[], revisionId: string): NormalizedImage[] {
  if (images.length === 0) throw new Error('image plan must contain at least one item')
  const ids = new Set<string>()
  const targets: string[] = []
  return images.map(image => {
    const id = image.id.normalize('NFC')
    validateArtifactId(id)
    if (/[<>"|?*]/u.test(id) || containsPortableControl(id)) {
      throw new Error('image ID contains a non-portable Windows or control character')
    }
    const portableId = id.toLowerCase()
    if (ids.has(portableId)) throw new Error(`duplicate portable image ID ${id}`)
    ids.add(portableId)
    if (image.prompt.trim().length === 0) throw new Error('image prompt must not be empty')
    if (image.preset !== undefined && image.preset.trim().length === 0) throw new Error('image preset must not be empty')
    if (image.aspect !== undefined && image.aspect.trim().length === 0) throw new Error('image aspect must not be empty')
    const targetPath = normalizeTargetPath(image.targetPath)
    const portableTarget = targetPath.toLowerCase()
    for (const existing of targets) {
      if (portableTarget === existing
        || portableTarget.startsWith(`${existing}/`)
        || existing.startsWith(`${portableTarget}/`)) {
        throw new Error(`image target collides with another image target: ${targetPath}`)
      }
    }
    targets.push(portableTarget)
    const targetArtifactPath = `revisions/${revisionId}/${targetPath}`
    validateArtifactRelativePath(targetArtifactPath)
    return { original: { ...image, id, targetPath }, targetArtifactPath }
  })
}

function normalizeTargetPath(input: string): string {
  const normalized = input.replaceAll('\\', '/').normalize('NFC')
  validateArtifactRelativePath(normalized)
  if (!normalized.startsWith('images/') || normalized === 'images/') {
    throw new Error('image target must stay beneath the revision-local images/ directory')
  }
  for (const component of normalized.split('/')) {
    if (/[<>"|?*]/u.test(component) || containsPortableControl(component)) {
      throw new Error('image target contains a non-portable Windows or control character')
    }
  }
  return normalized
}

/**
 * Derive side-effect-free md2wechat planning arguments from approved fields.
 * @param original - Approved image request before CLI defaults or prompt rendering.
 * @param article - Authorized process path for the immutable article revision.
 * @returns Exact arguments for the validated CLI planning contract.
 */
export function imagePlanningArgv(original: ImagePlanSource, article: string): readonly string[] {
  if (original.kind === 'image' && original.preset === undefined) {
    return [
      'generate_image',
      original.prompt,
      ...(original.aspect === undefined ? [] : ['--aspect', original.aspect]),
      '--plan',
      '--json',
    ]
  }
  const argv = [
    original.kind === 'image' ? 'generate_image' : original.kind === 'cover' ? 'generate_cover' : 'generate_infographic',
  ]
  if (original.kind === 'image' && original.preset !== undefined) argv.push('--preset', original.preset)
  argv.push('--article', article)
  if (original.kind !== 'image' && original.preset !== undefined) argv.push('--preset', original.preset)
  if (original.aspect !== undefined) argv.push('--aspect', original.aspect)
  argv.push('--plan', '--json')
  return argv
}

/**
 * Validate and persist-normalize one supported CLI planning response.
 * @param response - Response returned by the configured CLI gateway.
 * @param image - Approved source fields used for the planning invocation.
 * @param current - Current immutable article revision and authorized process path.
 * @returns Strict CLI plan data with the process article path replaced by its artifact path.
 */
export function projectImagePlanResponse(
  response: Awaited<ReturnType<CliGateway['run']>>,
  image: ImagePlanSource,
  current: Awaited<ReturnType<typeof loadCurrentArticleRevision>>,
): JsonValue {
  if (!response.success || response.code !== 'IMAGE_PLAN_READY' || response.status !== 'action_required') {
    throw new Error('md2wechat image planning did not return IMAGE_PLAN_READY/action_required')
  }
  const data = requiredRecord(response.data, 'image plan data')
  assertExactKeys(data, [
    'mode', 'command', 'execution_owner', 'side_effects', 'requires_provider', 'requires_image_api_key',
    'prompt', 'raw_prompt', 'preset', 'archetype', 'primary_use_case', 'compatible_use_cases',
    'recommended_aspect_ratios', 'default_aspect_ratio', 'article', 'title', 'summary', 'keywords',
    'style', 'aspect', 'size', 'model_hint', 'suggested_filename', 'alt_text',
  ], 'image plan data')
  const expectedCommand = image.kind === 'image' ? 'generate_image' : image.kind === 'cover' ? 'generate_cover' : 'generate_infographic'
  const article = requiredString(data.article, 'image plan article')
  const expectsArticle = image.kind !== 'image' || image.preset !== undefined
  if ((expectsArticle && article !== current.articleAuthorization.processPath)
    || (!expectsArticle && article !== '')) {
    throw new Error('image plan article does not match the authorized article input')
  }
  return {
    mode: requireLiteral(data.mode, 'plan', 'image plan mode'),
    command: requireLiteral(data.command, expectedCommand, 'image plan command'),
    execution_owner: requireLiteral(data.execution_owner, 'host_agent', 'image plan execution_owner'),
    side_effects: requireLiteral(data.side_effects, false, 'image plan side_effects'),
    requires_provider: requireLiteral(data.requires_provider, false, 'image plan requires_provider'),
    requires_image_api_key: requireLiteral(data.requires_image_api_key, false, 'image plan requires_image_api_key'),
    prompt: projectedNonEmptyString(data.prompt, 'image plan prompt', current),
    raw_prompt: projectedString(data.raw_prompt, 'image plan raw_prompt', current),
    preset: projectedString(data.preset, 'image plan preset', current),
    archetype: projectedString(data.archetype, 'image plan archetype', current),
    primary_use_case: projectedString(data.primary_use_case, 'image plan primary_use_case', current),
    compatible_use_cases: projectedStringArray(data.compatible_use_cases, 'image plan compatible_use_cases', current),
    recommended_aspect_ratios: projectedStringArray(
      data.recommended_aspect_ratios, 'image plan recommended_aspect_ratios', current,
    ),
    default_aspect_ratio: projectedString(data.default_aspect_ratio, 'image plan default_aspect_ratio', current),
    article: expectsArticle ? current.articlePath : '',
    title: projectedString(data.title, 'image plan title', current),
    summary: projectedString(data.summary, 'image plan summary', current),
    keywords: projectedString(data.keywords, 'image plan keywords', current),
    style: projectedString(data.style, 'image plan style', current),
    aspect: projectedString(data.aspect, 'image plan aspect', current),
    size: projectedString(data.size, 'image plan size', current),
    model_hint: projectedString(data.model_hint, 'image plan model_hint', current),
    suggested_filename: projectedString(data.suggested_filename, 'image plan suggested_filename', current),
    alt_text: projectedString(data.alt_text, 'image plan alt_text', current),
  }
}

async function publishStablePlan(
  store: ArtifactStore,
  path: string,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  try {
    await store.createExclusive(path, bytes, signal)
    return
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ARTIFACT_EXISTS')) throw error
  }
  const existing = await store.readBounded(path, MAX_PLAN_OUTPUT_BYTES, signal)
  if (!Buffer.from(existing).equals(Buffer.from(bytes))) throw new Error('existing immutable image plan conflicts with the computed plan')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, sortJson(item)]))
  }
  return value
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function requiredRecord(value: unknown, field: string): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${field} must be an object`)
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, requiredJsonValue(item, field)]))
}

function requiredJsonValue(value: unknown, field: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    throw new Error(`${field} must contain finite JSON numbers`)
  }
  if (Array.isArray(value)) return value.map(item => requiredJsonValue(item, field))
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, requiredJsonValue(item, field)]))
  }
  throw new Error(`${field} must contain only JSON values`)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  return value
}

function requiredNonEmptyString(value: unknown, field: string): string {
  const text = requiredString(value, field)
  if (text.trim().length === 0) throw new Error(`${field} must be non-empty`)
  return text
}

function requiredStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error(`${field} must contain only strings`)
  return value
}

function requireLiteral<T extends string | boolean>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw new Error(`${field} must be ${String(expected)}`)
  return expected
}

function assertExactKeys(value: Readonly<Record<string, JsonValue>>, allowed: readonly string[], field: string): void {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`${field} contains unknown field ${key}`)
  }
}

function containsPortableControl(value: string): boolean {
  return [...value].some(character => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

function projectedString(
  value: unknown,
  field: string,
  current: Awaited<ReturnType<typeof loadCurrentArticleRevision>>,
): string {
  return requiredString(value, field)
    .replaceAll(current.articleAuthorization.processPath, current.articlePath)
}

function projectedNonEmptyString(
  value: unknown,
  field: string,
  current: Awaited<ReturnType<typeof loadCurrentArticleRevision>>,
): string {
  return requiredNonEmptyString(value, field)
    .replaceAll(current.articleAuthorization.processPath, current.articlePath)
}

function projectedStringArray(
  value: unknown,
  field: string,
  current: Awaited<ReturnType<typeof loadCurrentArticleRevision>>,
): string[] {
  return requiredStringArray(value, field)
    .map(item => item.replaceAll(current.articleAuthorization.processPath, current.articlePath))
}

function renderPlanItems(planPath: string, items: readonly JsonValue[]): string {
  const lines = [`Prepared ${items.length} side-effect-free image plan items at ${planPath}.`]
  for (const item of items) {
    const record = requiredRecord(item, 'rendered image plan item')
    const original = requiredRecord(record.original, 'rendered original image item')
    const cliPlan = requiredRecord(record.cliPlan, 'rendered CLI image plan')
    lines.push(`[${requiredNonEmptyString(original.id, 'rendered image ID')}] ${requiredNonEmptyString(record.targetArtifactPath, 'rendered image target')}`)
    lines.push(requiredNonEmptyString(cliPlan.prompt, 'rendered image prompt'))
  }
  return lines.join('\n')
}

function assertKnownArguments(args: object, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`unknown plan-images argument ${key}`)
  }
}

function planLocations(manifestPath: string, images: readonly ImagePlanSource[]): readonly string[] {
  const revisionId = /^revisions\/([a-f0-9]{64})\/manifest\.json$/u.exec(manifestPath)?.[1]
  if (revisionId === undefined) return [manifestPath]
  return [
    manifestPath,
    `revisions/${revisionId}/article.md`,
    ...images.map(image => `revisions/${revisionId}/${image.targetPath.replaceAll('\\', '/').normalize('NFC')}`),
  ]
}
