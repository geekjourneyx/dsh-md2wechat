import { PLUGIN_VERSION } from '../version.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { probeCliVersion } from '../cli/gateway.ts'
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

export interface ImproveArticleToolDependencies {
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
export function createImproveArticleOperation({
  gateway,
  store,
  now = () => new Date(),
}: ImproveArticleToolDependencies) {
  return async (args: { manifestPath: string; operation: 'advise' | 'title' | 'humanize' | 'writer_style' }, exec: Pick<ToolRunContext, 'signal'>) => {
      assertKnownArguments(args, ['manifestPath', 'operation'])
      const cliVersion = await probeCliVersion(gateway, exec.signal)
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
      }, cliVersion)
    }
}

export function createImproveArticleTool(dependencies: ImproveArticleToolDependencies) {
  const operation = createImproveArticleOperation(dependencies)
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
          pluginVersion: { type: 'string', const: PLUGIN_VERSION, required: true },
          cliVersion: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Prepared ${value.operation} request for the current DSH Agent:\n${JSON.stringify(value.preparedRequest)}`,
      }],
    },
    execute: operation,
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
  assertExactKeys(value, [
    'schema_version', 'command', 'source', 'decision', 'article', 'actions', 'layout', 'micro_edits', 'do_not_do',
  ], 'advise data')
  requireLiteral(value.source, current.articleAuthorization.processPath, 'advise source')
  return {
    schema_version: requireLiteral(value.schema_version, 'v1', 'advise schema_version'),
    command: requireLiteral(value.command, 'advise', 'advise command'),
    source: current.articlePath,
    decision: projectedNonEmptyString(value.decision, 'advise decision', current),
    article: projectAdviseArticle(value.article, current),
    actions: requiredArray(value.actions, 'advise actions').map((item, index) => projectAdviseAction(item, index, current)),
    layout: projectAdviseLayout(value.layout, current),
    micro_edits: requiredArray(value.micro_edits, 'advise micro_edits')
      .map((item, index) => projectAdviseMicroEdit(item, index, current)),
    do_not_do: projectedStringArray(value.do_not_do, 'advise do_not_do', current),
  }
}

function projectTitle(data: Readonly<Record<string, unknown>> | undefined, current: CurrentArticleRevision): JsonValue {
  const value = requiredRecord(data, 'title data')
  assertExactKeys(value, [
    'action', 'execution_owner', 'prompt_kind', 'prompt_name', 'prompt', 'article_title', 'article_chars',
    'target_reader', 'title_count', 'max_title_chars', 'hook_level', 'hook_level_label', 'side_effects',
    'requires_external_model', 'recommendation_only', 'article_path',
  ], 'title data')
  requireLiteral(value.article_path, current.articleAuthorization.processPath, 'title article_path')
  const articleTitle = hasOwn(value, 'article_title')
    ? projectedString(value.article_title, 'title article_title', current)
    : undefined
  return {
    action: requireLiteral(value.action, 'ai_title_suggestion_request', 'title action'),
    execution_owner: requireLiteral(value.execution_owner, 'host_agent', 'title execution_owner'),
    prompt_kind: requireLiteral(value.prompt_kind, 'title', 'title prompt_kind'),
    prompt_name: projectedNonEmptyString(value.prompt_name, 'title prompt_name', current),
    prompt: projectedNonEmptyString(value.prompt, 'title prompt', current),
    ...(articleTitle === undefined ? {} : { article_title: articleTitle }),
    article_chars: requiredInteger(value.article_chars, 'title article_chars'),
    target_reader: projectedNonEmptyString(value.target_reader, 'title target_reader', current),
    title_count: requiredInteger(value.title_count, 'title title_count'),
    max_title_chars: requiredInteger(value.max_title_chars, 'title max_title_chars'),
    hook_level: requiredInteger(value.hook_level, 'title hook_level'),
    hook_level_label: projectedNonEmptyString(value.hook_level_label, 'title hook_level_label', current),
    side_effects: requireLiteral(value.side_effects, false, 'title side_effects'),
    requires_external_model: requireLiteral(value.requires_external_model, true, 'title requires_external_model'),
    recommendation_only: requireLiteral(value.recommendation_only, true, 'title recommendation_only'),
    article_path: current.articlePath,
  }
}

function projectHumanize(data: Readonly<Record<string, unknown>> | undefined, current: CurrentArticleRevision): JsonValue {
  const value = requiredRecord(data, 'humanize data')
  assertExactKeys(value, ['action', 'request'], 'humanize data')
  const request = requiredRecord(value.request, 'humanize request')
  assertExactKeys(request, ['content', 'intensity', 'prompt'], 'humanize request')
  return {
    action: requireLiteral(value.action, 'humanize_request', 'humanize action'),
    request: {
      content: projectedNonEmptyString(request.content, 'humanize content', current),
      intensity: projectedNonEmptyString(request.intensity, 'humanize intensity', current),
      prompt: projectedNonEmptyString(request.prompt, 'humanize prompt', current),
    },
  }
}

function projectWriterStyle(data: Readonly<Record<string, unknown>> | undefined, current: CurrentArticleRevision): JsonValue {
  const value = requiredRecord(data, 'writer-style data')
  assertExactKeys(value, ['mode', 'action', 'style', 'prompt'], 'writer-style data')
  return {
    mode: requireLiteral(value.mode, 'ai', 'writer-style mode'),
    action: requireLiteral(value.action, 'ai_write_request', 'writer-style action'),
    style: projectedNonEmptyString(value.style, 'writer-style style', current),
    prompt: projectedNonEmptyString(value.prompt, 'writer-style prompt', current),
  }
}

function projectAdviseArticle(value: unknown, current: CurrentArticleRevision): JsonValue {
  const article = requiredRecord(value, 'advise article')
  assertExactKeys(article, ['type', 'confidence', 'stats', 'signals', 'uncertainties'], 'advise article')
  const stats = requiredRecord(article.stats, 'advise article stats')
  assertExactKeys(stats, [
    'word_count', 'h1_count', 'h2_count', 'paragraph_count', 'image_count', 'blockquote_count', 'ordered_list_count',
  ], 'advise article stats')
  return {
    type: projectedNonEmptyString(article.type, 'advise article type', current),
    confidence: projectedNonEmptyString(article.confidence, 'advise article confidence', current),
    stats: {
      word_count: requiredInteger(stats.word_count, 'advise word_count'),
      h1_count: requiredInteger(stats.h1_count, 'advise h1_count'),
      h2_count: requiredInteger(stats.h2_count, 'advise h2_count'),
      paragraph_count: requiredInteger(stats.paragraph_count, 'advise paragraph_count'),
      image_count: requiredInteger(stats.image_count, 'advise image_count'),
      blockquote_count: requiredInteger(stats.blockquote_count, 'advise blockquote_count'),
      ordered_list_count: requiredInteger(stats.ordered_list_count, 'advise ordered_list_count'),
    },
    signals: projectedStringArray(article.signals, 'advise article signals', current),
    uncertainties: projectedStringArray(article.uncertainties, 'advise article uncertainties', current),
  }
}

function projectAdviseAction(value: JsonValue, index: number, current: CurrentArticleRevision): JsonValue {
  const field = `advise action ${index}`
  const action = requiredRecord(value, field)
  assertExactKeys(action, [
    'tool', 'state', 'reason', 'evidence', 'command_hint', 'command_args', 'requires_confirmation',
  ], field)
  const commandHint = hasOwn(action, 'command_hint')
    ? projectedString(action.command_hint, `${field} command_hint`, current)
    : undefined
  const commandArgs = hasOwn(action, 'command_args')
    ? projectedStringArray(action.command_args, `${field} command_args`, current)
    : undefined
  return {
    tool: projectedNonEmptyString(action.tool, `${field} tool`, current),
    state: projectedNonEmptyString(action.state, `${field} state`, current),
    reason: projectedNonEmptyString(action.reason, `${field} reason`, current),
    evidence: requiredArray(action.evidence, `${field} evidence`)
      .map((item, evidenceIndex) => projectAdviseEvidence(item, `${field} evidence ${evidenceIndex}`, current)),
    ...(commandHint === undefined ? {} : { command_hint: commandHint }),
    ...(commandArgs === undefined ? {} : { command_args: commandArgs }),
    requires_confirmation: requiredBoolean(action.requires_confirmation, `${field} requires_confirmation`),
  }
}

function projectAdviseEvidence(value: JsonValue, field: string, current: CurrentArticleRevision): JsonValue {
  const evidence = requiredRecord(value, field)
  assertExactKeys(evidence, ['code', 'message', 'location'], field)
  const location = hasOwn(evidence, 'location')
    ? projectAdviseLocation(evidence.location, `${field} location`, current)
    : undefined
  return {
    code: projectedNonEmptyString(evidence.code, `${field} code`, current),
    message: projectedNonEmptyString(evidence.message, `${field} message`, current),
    ...(location === undefined ? {} : { location }),
  }
}

function projectAdviseLocation(value: unknown, field: string, current: CurrentArticleRevision): JsonValue {
  const location = requiredRecord(value, field)
  assertExactKeys(location, ['line', 'section'], field)
  const line = hasOwn(location, 'line') ? requiredInteger(location.line, `${field} line`) : undefined
  const section = hasOwn(location, 'section')
    ? projectedString(location.section, `${field} section`, current)
    : undefined
  return {
    ...(line === undefined ? {} : { line }),
    ...(section === undefined ? {} : { section }),
  }
}

function projectAdviseLayout(value: unknown, current: CurrentArticleRevision): JsonValue {
  const layout = requiredRecord(value, 'advise layout')
  assertExactKeys(layout, ['max_modules', 'recommended', 'rejected'], 'advise layout')
  return {
    max_modules: requiredInteger(layout.max_modules, 'advise layout max_modules'),
    recommended: requiredArray(layout.recommended, 'advise recommended modules')
      .map((item, index) => projectAdviseModule(item, `advise recommended module ${index}`, current)),
    rejected: requiredArray(layout.rejected, 'advise rejected modules')
      .map((item, index) => projectAdviseModule(item, `advise rejected module ${index}`, current)),
  }
}

function projectAdviseModule(value: JsonValue, field: string, current: CurrentArticleRevision): JsonValue {
  const module = requiredRecord(value, field)
  assertExactKeys(module, ['name', 'state', 'reason', 'evidence'], field)
  return {
    name: projectedNonEmptyString(module.name, `${field} name`, current),
    state: projectedNonEmptyString(module.state, `${field} state`, current),
    reason: projectedNonEmptyString(module.reason, `${field} reason`, current),
    evidence: requiredArray(module.evidence, `${field} evidence`)
      .map((item, index) => projectAdviseEvidence(item, `${field} evidence ${index}`, current)),
  }
}

function projectAdviseMicroEdit(value: JsonValue, index: number, current: CurrentArticleRevision): JsonValue {
  const field = `advise micro edit ${index}`
  const edit = requiredRecord(value, field)
  assertExactKeys(edit, ['kind', 'reason', 'evidence', 'requires_confirmation'], field)
  return {
    kind: projectedNonEmptyString(edit.kind, `${field} kind`, current),
    reason: projectedNonEmptyString(edit.reason, `${field} reason`, current),
    evidence: requiredArray(edit.evidence, `${field} evidence`)
      .map((item, evidenceIndex) => projectAdviseEvidence(item, `${field} evidence ${evidenceIndex}`, current)),
    requires_confirmation: requiredBoolean(edit.requires_confirmation, `${field} requires_confirmation`),
  }
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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  return value
}

function requiredStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`${field} must contain only strings`)
  }
  return value
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`)
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

function assertExactKeys(value: Readonly<Record<string, JsonValue>>, allowed: readonly string[], field: string): void {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`${field} contains unknown field ${key}`)
  }
}

function hasOwn(value: Readonly<Record<string, JsonValue>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function projectedString(value: unknown, field: string, current: CurrentArticleRevision): string {
  return requiredString(value, field)
    .replaceAll(current.articleAuthorization.processPath, current.articlePath)
}

function projectedNonEmptyString(value: unknown, field: string, current: CurrentArticleRevision): string {
  return requiredNonEmptyString(value, field)
    .replaceAll(current.articleAuthorization.processPath, current.articlePath)
}

function projectedStringArray(value: unknown, field: string, current: CurrentArticleRevision): string[] {
  return requiredStringArray(value, field)
    .map(item => item.replaceAll(current.articleAuthorization.processPath, current.articlePath))
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
