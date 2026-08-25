import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { CliGateway } from '../cli/gateway.ts'
import { validateArtifactId, validateArtifactRelativePath } from '../workspace/artifact-store.ts'
import type { ArtifactStore } from '../workspace/artifact-store.ts'
import { domainResult, genericCall, genericResult } from './shared.ts'
import { loadCurrentArticleRevision } from './improve-article.ts'

interface PlanImagesToolDependencies {
  gateway: CliGateway
  store: ArtifactStore
  now?: () => Date
}

const MAX_PLAN_OUTPUT_BYTES = 1024 * 1024
const planWriteQueues = new Map<string, Promise<void>>()

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

/**
 * Create the side-effect-free image planning tool.
 * @param dependencies - CLI gateway, artifact store, and plan clock.
 * @returns Registry-ready typed DSH tool.
 */
export function createPlanImagesTool({
  gateway,
  store,
  now = () => new Date(),
}: PlanImagesToolDependencies) {
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
          pluginVersion: { type: 'string', const: '1.0.0', required: true },
          cliVersion: { type: 'string', const: '3.3.0', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderPlanItems(value.planPath, value.items),
      }],
    },
    async execute(args, exec) {
      assertKnownArguments(args, ['manifestPath', 'images'])
      const current = await loadCurrentArticleRevision(store, args.manifestPath, exec.signal)
      const normalized = normalizeImages(args.images, current.revision.id)
      const items: JsonValue[] = []
      for (const item of normalized) {
        const argv = imageArgv(item, current.articleAuthorization.processPath)
        const response = await gateway.run(argv, {
          signal: exec.signal,
          beforeSpawn: current.articleAuthorization.beforeSpawn,
        })
        const cliPlan = validateCliPlan(response, item.original, current)
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
        createdAt: now().toISOString(),
        items,
      }
      await writeStablePlan(store, planPath, persisted, exec.signal)
      return domainResult({
        revisionId: current.revision.id,
        manifestPath: current.manifestPath,
        planId,
        planPath,
        items,
        locations: [current.articlePath, current.manifestPath, planPath, ...normalized.map(item => item.targetArtifactPath)],
      })
    },
    presentCall: args => genericCall('Plan article images', 'edit', args.images, planLocations(args.manifestPath, args.images)),
    presentResult: () => genericResult('Image plan ready'),
  })
}

type ImageInput = {
  id: string
  kind: 'image' | 'cover' | 'infographic'
  prompt: string
  targetPath: string
  preset?: string
  aspect?: string
}

interface NormalizedImage {
  original: ImageInput
  targetArtifactPath: string
}

function normalizeImages(images: readonly ImageInput[], revisionId: string): NormalizedImage[] {
  if (images.length === 0) throw new Error('image plan must contain at least one item')
  const ids = new Set<string>()
  const targets: string[] = []
  return images.map(image => {
    const id = image.id.normalize('NFC')
    validateArtifactId(id)
    if (/[<>"|?*]/u.test(id)) throw new Error('image ID contains a non-portable Windows character')
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
    if (/[<>"|?*]/u.test(component) || [...component].some(character => {
      const codePoint = character.codePointAt(0)!
      return codePoint <= 0x1f || codePoint === 0x7f
    })) {
      throw new Error('image target contains a non-portable Windows or control character')
    }
  }
  return normalized
}

function imageArgv(item: NormalizedImage, article: string): readonly string[] {
  const { original } = item
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

function validateCliPlan(
  response: Awaited<ReturnType<CliGateway['run']>>,
  image: ImageInput,
  current: Awaited<ReturnType<typeof loadCurrentArticleRevision>>,
): JsonValue {
  if (!response.success || response.code !== 'IMAGE_PLAN_READY' || response.status !== 'action_required') {
    throw new Error('md2wechat image planning did not return IMAGE_PLAN_READY/action_required')
  }
  const data = requiredRecord(response.data, 'image plan data')
  const expectedCommand = image.kind === 'image' ? 'generate_image' : image.kind === 'cover' ? 'generate_cover' : 'generate_infographic'
  requireLiteral(data.mode, 'plan', 'image plan mode')
  requireLiteral(data.command, expectedCommand, 'image plan command')
  requireLiteral(data.execution_owner, 'host_agent', 'image plan execution_owner')
  requireLiteral(data.side_effects, false, 'image plan side_effects')
  requireLiteral(data.requires_provider, false, 'image plan requires_provider')
  requireLiteral(data.requires_image_api_key, false, 'image plan requires_image_api_key')
  requiredNonEmptyString(data.prompt, 'image plan prompt')
  for (const field of [
    'raw_prompt', 'preset', 'archetype', 'primary_use_case', 'default_aspect_ratio', 'article',
    'title', 'summary', 'keywords', 'style', 'aspect', 'size', 'model_hint', 'suggested_filename', 'alt_text',
  ] as const) requiredString(data[field], `image plan ${field}`)
  requiredStringArray(data.compatible_use_cases, 'image plan compatible_use_cases')
  requiredStringArray(data.recommended_aspect_ratios, 'image plan recommended_aspect_ratios')
  const article = data.article as string
  const expectsArticle = image.kind !== 'image' || image.preset !== undefined
  if ((expectsArticle && article !== current.articleAuthorization.processPath)
    || (!expectsArticle && article !== '')) {
    throw new Error('image plan article does not match the authorized article input')
  }
  return { ...data, article: current.articlePath }
}

async function writeStablePlan(
  store: ArtifactStore,
  path: string,
  value: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<void> {
  const bytes = new TextEncoder().encode(`${canonicalJson(value)}\n`)
  const identity = await store.canonicalIdentity(path, signal)
  await enqueuePlanWrite(identity, async () => {
    try {
      const existing = await store.read(path, signal)
      const existingValue = parsePersistedPlan(existing)
      const { createdAt: _existingCreatedAt, ...existingStable } = existingValue
      const { createdAt: _candidateCreatedAt, ...candidateStable } = value
      if (canonicalJson(existingStable) !== canonicalJson(candidateStable)) {
        throw new Error('existing immutable image plan conflicts with the computed plan')
      }
      return
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'FS_NOT_FOUND')) throw error
    }
    await store.writeAtomic(path, bytes, signal)
  })
}

async function enqueuePlanWrite(identity: string, write: () => Promise<void>): Promise<void> {
  const prior = planWriteQueues.get(identity) ?? Promise.resolve()
  const current = prior.catch(() => undefined).then(write)
  planWriteQueues.set(identity, current)
  try {
    await current
  } finally {
    if (planWriteQueues.get(identity) === current) planWriteQueues.delete(identity)
  }
}

function parsePersistedPlan(bytes: Uint8Array): Readonly<Record<string, JsonValue>> {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw new Error('existing image plan must contain valid UTF-8 JSON', { cause: error })
  }
  return requiredRecord(value, 'existing image plan')
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

function planLocations(manifestPath: string, images: readonly ImageInput[]): readonly string[] {
  const revisionId = /^revisions\/([a-f0-9]{64})\/manifest\.json$/u.exec(manifestPath)?.[1]
  if (revisionId === undefined) return [manifestPath]
  return [
    manifestPath,
    `revisions/${revisionId}/article.md`,
    ...images.map(image => `revisions/${revisionId}/${image.targetPath.replaceAll('\\', '/').normalize('NFC')}`),
  ]
}
