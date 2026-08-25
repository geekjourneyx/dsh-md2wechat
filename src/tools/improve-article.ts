import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { CliGateway } from '../cli/gateway.ts'
import type { CliEnvelope } from '../cli/protocol.ts'
import { domainResult, genericCall, genericResult } from './shared.ts'
import type { ArtifactReadAuthorization, ArtifactStore } from '../workspace/artifact-store.ts'
import {
  appendOperation,
  computeArticleRevision,
  validateRevisionManifest,
} from '../workspace/revision.ts'
import type { ArticleManifest, ArticleRevision } from '../workspace/revision.ts'

const manifestPattern = /^revisions\/([a-f0-9]{64})\/manifest\.json$/u

interface ImproveArticleToolDependencies {
  gateway: CliGateway
  store: ArtifactStore
  now?: () => Date
}

/** Loaded immutable revision with canonical artifact and process paths. */
export interface CurrentArticleRevision {
  revision: ArticleRevision
  manifest: ArticleManifest
  manifestPath: string
  articlePath: string
  articleAuthorization: ArtifactReadAuthorization
  articleBytes: Uint8Array
}

/**
 * Load and authenticate an exact immutable revision manifest before CLI use.
 * @param store - Contained artifact store.
 * @param manifestPath - Full artifact-relative revision manifest path.
 * @param signal - Optional cancellation signal.
 * @returns Current manifest, article bytes, revision, and authorized CLI input path.
 */
export async function loadCurrentArticleRevision(
  store: ArtifactStore,
  manifestPath: string,
  signal?: AbortSignal,
): Promise<CurrentArticleRevision> {
  const match = manifestPattern.exec(manifestPath)
  if (match === null) throw new Error('manifestPath must match revisions/<revision-id>/manifest.json')
  const directoryId = match[1]!
  const manifest = parseManifest(await store.read(manifestPath, signal))
  if (manifest.articlePath !== 'article.md' || manifest.manifestPath !== 'manifest.json') {
    throw new Error('revision manifest must use revision-local article.md and manifest.json paths')
  }
  const articlePath = `revisions/${directoryId}/article.md`
  const articleBytes = await store.read(articlePath, signal)
  const revision = computeArticleRevision(articleBytes, manifest)
  if (revision.id !== directoryId) throw new Error('stale revision: manifest, article, or directory identity does not match')
  const articleAuthorization = await store.authorizeRead(articlePath, revision.articleSha256, signal)
  return { revision, manifest, manifestPath, articlePath, articleAuthorization, articleBytes }
}

/**
 * Create the side-effect-free article improvement request tool.
 * @param dependencies - CLI gateway, artifact store, and operation clock.
 * @returns Registry-ready typed DSH tool.
 */
export function createImproveArticleTool({
  gateway,
  store,
  now = () => new Date(),
}: ImproveArticleToolDependencies) {
  return defineTool({
    name: 'md2wechat_improve_article',
    description: 'Prepare advice or an AI rewrite request for the current immutable article; never changes article bytes.',
    parameters: {
      manifestPath: { type: 'string', required: true, description: 'Manifest path returned by md2wechat_start_article.' },
      operation: {
        type: 'string', required: true, enum: ['advise', 'title', 'humanize', 'writer_style'],
        description: 'Improvement request to prepare for the current DSH Agent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          revisionId: { type: 'string', required: true },
          manifestPath: { type: 'string', required: true },
          articlePath: { type: 'string', required: true },
          operation: { type: 'string', required: true, enum: ['advise', 'title', 'humanize', 'writer_style'] },
          cliCode: { type: 'string', required: true },
          preparedRequest: { type: 'json', required: true },
          recordPath: { type: 'string', required: true },
          locations: { type: 'array', required: true, items: { type: 'string' } },
          pluginVersion: { type: 'string', const: '1.0.0', required: true },
          cliVersion: { type: 'string', const: '3.3.0', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Prepared ${value.operation} request for the current DSH Agent:\n${JSON.stringify(value.preparedRequest)}`,
      }],
    },
    async execute(args, exec) {
      assertKnownArguments(args, ['manifestPath', 'operation'])
      const current = await loadCurrentArticleRevision(store, args.manifestPath, exec.signal)
      const argv = improvementArgv(args.operation, current.articleAuthorization.processPath)
      const response = await gateway.run(argv, {
        signal: exec.signal,
        beforeSpawn: current.articleAuthorization.beforeSpawn,
      })
      const preparedRequest = projectImprovementResponse(args.operation, response, current)
      const verified = await loadCurrentArticleRevision(store, args.manifestPath, exec.signal)
      if (verified.revision.articleSha256 !== current.revision.articleSha256) {
        throw new Error('stale revision: article changed while preparing the request')
      }
      const recordPath = `revisions/${current.revision.id}/operations.jsonl`
      await appendOperation(store, current.revision, {
        operation: args.operation,
        createdAt: now().toISOString(),
        details: { cliCode: response.code, preparedRequest },
      }, [])
      return domainResult({
        revisionId: current.revision.id,
        manifestPath: current.manifestPath,
        articlePath: current.articlePath,
        operation: args.operation,
        cliCode: response.code,
        preparedRequest,
        recordPath,
        locations: [current.articlePath, current.manifestPath, recordPath],
      })
    },
    presentCall: args => genericCall('Prepare article improvement', 'read', args.operation, revisionLocations(args.manifestPath)),
    presentResult: () => genericResult('Article improvement prepared'),
  })
}

function projectImprovementResponse(
  operation: 'advise' | 'title' | 'humanize' | 'writer_style',
  response: CliEnvelope,
  current: CurrentArticleRevision,
): JsonValue {
  switch (operation) {
    case 'advise':
      assertEnvelope(response, 'ADVISE_COMPLETED', 'completed')
      return projectAdvise(response.data, current)
    case 'title':
      assertEnvelope(response, 'TITLE_SUGGEST_REQUEST_READY', 'action_required')
      return projectTitle(response.data, current)
    case 'humanize':
      assertEnvelope(response, 'HUMANIZE_REQUEST_READY', 'action_required')
      return projectHumanize(response.data, current)
    case 'writer_style':
      assertEnvelope(response, 'WRITE_AI_REQUEST_READY', 'action_required')
      return projectWriterStyle(response.data, current)
    default:
      return assertNever(operation)
  }
}

function projectAdvise(data: Readonly<Record<string, unknown>> | undefined, current: CurrentArticleRevision): JsonValue {
  const value = requiredRecord(data, 'advise data')
  requireLiteral(value.schema_version, 'v1', 'advise schema_version')
  requireLiteral(value.command, 'advise', 'advise command')
  requireLiteral(value.source, current.articleAuthorization.processPath, 'advise source')
  requiredNonEmptyString(value.decision, 'advise decision')
  requiredRecord(value.article, 'advise article')
  requiredArray(value.actions, 'advise actions')
  requiredRecord(value.layout, 'advise layout')
  requiredArray(value.micro_edits, 'advise micro_edits')
  requiredArray(value.do_not_do, 'advise do_not_do')
  return replaceMachinePath(value, current.articleAuthorization.processPath, current.articlePath)
}

function projectTitle(data: Readonly<Record<string, unknown>> | undefined, current: CurrentArticleRevision): JsonValue {
  const value = requiredRecord(data, 'title data')
  requireLiteral(value.action, 'ai_title_suggestion_request', 'title action')
  requireLiteral(value.execution_owner, 'host_agent', 'title execution_owner')
  requireLiteral(value.prompt_kind, 'title', 'title prompt_kind')
  requiredNonEmptyString(value.prompt_name, 'title prompt_name')
  requiredNonEmptyString(value.prompt, 'title prompt')
  requireLiteral(value.article_path, current.articleAuthorization.processPath, 'title article_path')
  requiredInteger(value.article_chars, 'title article_chars')
  requiredNonEmptyString(value.target_reader, 'title target_reader')
  requiredInteger(value.title_count, 'title title_count')
  requiredInteger(value.max_title_chars, 'title max_title_chars')
  requiredInteger(value.hook_level, 'title hook_level')
  requiredNonEmptyString(value.hook_level_label, 'title hook_level_label')
  requireLiteral(value.side_effects, false, 'title side_effects')
  requireLiteral(value.requires_external_model, true, 'title requires_external_model')
  requireLiteral(value.recommendation_only, true, 'title recommendation_only')
  return replaceMachinePath(value, current.articleAuthorization.processPath, current.articlePath)
}

function projectHumanize(data: Readonly<Record<string, unknown>> | undefined, current: CurrentArticleRevision): JsonValue {
  const value = requiredRecord(data, 'humanize data')
  requireLiteral(value.action, 'humanize_request', 'humanize action')
  const request = requiredRecord(value.request, 'humanize request')
  requiredNonEmptyString(request.prompt, 'humanize prompt')
  requiredNonEmptyString(request.content, 'humanize content')
  requiredNonEmptyString(request.intensity, 'humanize intensity')
  return replaceMachinePath(value, current.articleAuthorization.processPath, current.articlePath)
}

function projectWriterStyle(data: Readonly<Record<string, unknown>> | undefined, current: CurrentArticleRevision): JsonValue {
  const value = requiredRecord(data, 'writer-style data')
  requireLiteral(value.mode, 'ai', 'writer-style mode')
  requireLiteral(value.action, 'ai_write_request', 'writer-style action')
  requiredNonEmptyString(value.style, 'writer-style style')
  requiredNonEmptyString(value.prompt, 'writer-style prompt')
  return replaceMachinePath(value, current.articleAuthorization.processPath, current.articlePath)
}

function assertEnvelope(response: CliEnvelope, code: string, status: CliEnvelope['status']): void {
  if (!response.success || response.code !== code || response.status !== status) {
    throw new Error(`unexpected md2wechat response; expected ${code}/${status}`)
  }
}

function requiredRecord(value: unknown, field: string): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${field} must be an object`)
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, requiredJsonValue(item, field)]))
}

function requiredArray(value: unknown, field: string): readonly JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return value.map(item => requiredJsonValue(item, field))
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

function requiredNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`)
  return value
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`)
  return value
}

function requireLiteral<T extends string | boolean>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw new Error(`${field} must be ${String(expected)}`)
  return expected
}

function replaceMachinePath(value: JsonValue, machinePath: string, artifactPath: string): JsonValue {
  if (typeof value === 'string') return value.replaceAll(machinePath, artifactPath)
  if (Array.isArray(value)) return value.map(item => replaceMachinePath(item, machinePath, artifactPath))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceMachinePath(item, machinePath, artifactPath)]))
  }
  return value
}

function improvementArgv(
  operation: 'advise' | 'title' | 'humanize' | 'writer_style',
  article: string,
): readonly string[] {
  switch (operation) {
    case 'advise': return ['advise', article, '--json']
    case 'title': return ['title', 'suggest', article, '--json']
    case 'humanize': return ['humanize', article, '--json']
    case 'writer_style': return ['write', article, '--input-type', 'fragment', '--json']
    default: return assertNever(operation)
  }
}

function parseManifest(bytes: Uint8Array): ArticleManifest {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw new Error('revision manifest must contain valid UTF-8 JSON', { cause: error })
  }
  return validateRevisionManifest(value)
}

function assertNever(value: never): never {
  throw new Error(`unsupported improvement operation ${String(value)}`)
}

function assertKnownArguments(args: object, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`unknown improve-article argument ${key}`)
  }
}

function revisionLocations(manifestPath: string): readonly string[] {
  const revisionId = manifestPattern.exec(manifestPath)?.[1]
  if (revisionId === undefined) return [manifestPath]
  return [
    manifestPath,
    `revisions/${revisionId}/article.md`,
    `revisions/${revisionId}/operations.jsonl`,
  ]
}
