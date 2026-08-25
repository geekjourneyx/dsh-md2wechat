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
        text: `Prepared ${value.items.length} side-effect-free image plan items at ${value.planPath}.`,
      }],
    },
    async execute(args, exec) {
      assertKnownArguments(args, ['manifestPath', 'images'])
      const current = await loadCurrentArticleRevision(store, args.manifestPath, exec.signal)
      const normalized = normalizeImages(args.images, current.revision.id)
      const items: JsonValue[] = []
      for (const item of normalized) {
        const response = await gateway.run(imageArgv(item, current.articleProcessPath), { signal: exec.signal })
        const cliPlan = validateCliPlan(response.data, response.success, response.status)
        items.push({ original: item.original, targetArtifactPath: item.targetArtifactPath, cliPlan })
      }
      const verified = await loadCurrentArticleRevision(store, args.manifestPath, exec.signal)
      if (verified.revision.articleSha256 !== current.revision.articleSha256) {
        throw new Error('stale revision: article changed while preparing the image plan')
      }
      const planId = sha256(canonicalJson({ revisionId: current.revision.id, items }))
      const planPath = `revisions/${current.revision.id}/plans/${planId}.json`
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
  const targets = new Set<string>()
  return images.map(image => {
    validateArtifactId(image.id)
    if (ids.has(image.id)) throw new Error(`duplicate image ID ${image.id}`)
    ids.add(image.id)
    if (image.prompt.trim().length === 0) throw new Error('image prompt must not be empty')
    if (image.preset !== undefined && image.preset.trim().length === 0) throw new Error('image preset must not be empty')
    if (image.aspect !== undefined && image.aspect.trim().length === 0) throw new Error('image aspect must not be empty')
    validateArtifactRelativePath(image.targetPath)
    const targetArtifactPath = `revisions/${revisionId}/${image.targetPath}`
    validateArtifactRelativePath(targetArtifactPath)
    if (targets.has(targetArtifactPath)) throw new Error(`duplicate image target ${image.targetPath}`)
    targets.add(targetArtifactPath)
    return { original: { ...image }, targetArtifactPath }
  })
}

function imageArgv(item: NormalizedImage, article: string): readonly string[] {
  const { original } = item
  if (original.kind === 'image' && original.preset === undefined) {
    return ['generate_image', original.prompt, '--plan', '--json']
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

function validateCliPlan(data: Readonly<Record<string, unknown>> | undefined, success: boolean, status: string): JsonValue {
  if (!success || status === 'failed' || data === undefined) throw new Error('md2wechat image planning did not return a successful plan')
  if (data.mode !== 'plan' || data.side_effects !== false || data.requires_provider !== false) {
    throw new Error('md2wechat image planning response is not side-effect-free')
  }
  return data as JsonValue
}

async function writeStablePlan(
  store: ArtifactStore,
  path: string,
  value: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<void> {
  const bytes = new TextEncoder().encode(`${canonicalJson(value)}\n`)
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
}

function parsePersistedPlan(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw new Error('existing image plan must contain valid UTF-8 JSON', { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('existing image plan must contain a JSON object')
  }
  return value as Record<string, unknown>
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
    ...images.map(image => `revisions/${revisionId}/${image.targetPath}`),
  ]
}
