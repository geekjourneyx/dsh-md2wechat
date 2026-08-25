import { createHash } from 'node:crypto'
import { dirname, posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { CredentialEnvironmentName } from '../config.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CliGateway } from '../cli/gateway.ts'
import type { CliEnvelope } from '../cli/protocol.ts'
import { resolveOperationEnv } from '../security/credentials.ts'
import type { OperationCredentialServices } from '../security/credentials.ts'
import { sanitizeError } from '../security/redaction.ts'
import { PLUGIN_VERSION, SUPPORTED_CLI_VERSION } from '../version.ts'
import type { ArtifactReadAuthorization, ArtifactStore } from '../workspace/artifact-store.ts'
import { appendOperation } from '../workspace/revision.ts'
import {
  cleanupPreviewSnapshot,
  createPreviewReceipt,
  createPreviewSnapshot,
  PREVIEW_HTML_LIMIT_BYTES,
  publishPreviewSnapshot,
} from '../workspace/preview.ts'
import type { PreviewSnapshotInput, PreviewTransaction } from '../workspace/preview.ts'
import { domainResult, genericCall, genericResult } from './shared.ts'
import { loadCurrentArticleRevision } from './improve-article.ts'
import type { CurrentArticleRevision } from './improve-article.ts'

const TOOL_NAME = 'md2wechat_preview'
const PREVIEW_MODE = 'api'
const PREVIEW_OUTPUT = 'standalone-html'
const DEFAULT_PREVIEW_TTL_MS = 10 * 60 * 1000
const previewQueues = new Map<string, Promise<unknown>>()

interface PreviewToolDependencies {
  gateway: CliGateway
  store: ArtifactStore
  layoutBaseUrl: string
  credentialRefs: OperationCredentialServices['credentialRefs']
  credentials: OperationCredentialServices['credentials']
  approval: Pick<Context['approval'], 'request'>
  now?: () => Date
  previewTtlMs?: number
}

interface LocalPreviewImage {
  path: string
  bytes: Uint8Array
  authorization: ArtifactReadAuthorization
}

interface PreparedPreviewInputs {
  current: CurrentArticleRevision
  localImages: readonly LocalPreviewImage[]
  contentId: string
}

/**
 * Create the approved provider-backed article preview tool.
 * @param dependencies - Gateway, storage, rendering config, credentials, approval service, clock, and TTL.
 * @returns Registry-ready typed DSH tool.
 */
export function createPreviewTool({
  gateway,
  store,
  layoutBaseUrl,
  credentialRefs,
  credentials,
  approval,
  now = () => new Date(),
  previewTtlMs = DEFAULT_PREVIEW_TTL_MS,
}: PreviewToolDependencies) {
  if (!Number.isSafeInteger(previewTtlMs) || previewTtlMs < 1) throw new TypeError('preview TTL must be a positive safe integer')
  requiredSafeString(layoutBaseUrl, 'preview layout base URL')
  return defineTool({
    name: TOOL_NAME,
    description: 'Generate an expiring, signed HTML preview for one immutable md2wechat article revision after one-time approval.',
    parameters: {
      manifestPath: { type: 'string', required: true, description: 'Manifest path returned by md2wechat_start_article.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          manifestPath: { type: 'string', required: true },
          previewHtmlPath: { type: 'string', required: true },
          revisionId: { type: 'string', required: true },
          previewReceiptId: { type: 'string', required: true },
          previewUrl: { type: 'string' },
          pluginVersion: { type: 'string', const: '1.0.0', required: true },
          cliVersion: { type: 'string', const: '3.3.0', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Article preview is ready at ${value.previewHtmlPath}.`,
      }],
    },
    async execute(args, exec) {
      assertKnownArguments(args, ['manifestPath'])
      exec.signal.throwIfAborted()
      const preparedBeforeApproval = await prepareInputs(store, args.manifestPath, exec.signal)
      if (exec.agent === undefined) throw new Error('article preview requires an active agent')
      const outcome = await approval.request({
        agent: exec.agent,
        toolName: TOOL_NAME,
        callId: exec.callId,
        reason: 'Generate an article preview using the configured md2wechat provider.',
        signal: exec.signal,
      })
      assertApproved(outcome)
      exec.signal.throwIfAborted()

      const credentialReference = credentialRefs.MD2WECHAT_API_KEY
      if (credentialReference === undefined) throw new Error('MD2WECHAT_API_KEY is not configured for article preview')
      const resolved = await resolveOperationEnv(['MD2WECHAT_API_KEY'] satisfies readonly CredentialEnvironmentName[], {
        credentialRefs,
        credentials,
      })
      const credentialValue = resolved.env.MD2WECHAT_API_KEY
      if (credentialValue === undefined) throw new Error('MD2WECHAT_API_KEY is not configured for article preview')
      exec.signal.throwIfAborted()

      const queueIdentity = await store.canonicalIdentity(
        `revisions/${preparedBeforeApproval.current.revision.id}/previews/current.json`,
        exec.signal,
      )
      return enqueuePreview(queueIdentity, async () => {
        exec.signal.throwIfAborted()
        const prepared = await prepareInputs(store, args.manifestPath, exec.signal)
        if (prepared.contentId !== preparedBeforeApproval.contentId) {
          throw new Error('preview inputs changed after approval')
        }
        const snapshotInput = snapshotInputFor(
          prepared,
          layoutBaseUrl,
          credentialReference,
          credentialValue,
        )
        const snapshot = createPreviewSnapshot(snapshotInput)
        let transaction: PreviewTransaction = { state: 'prepared', snapshot }
        const previewHtmlPath = `revisions/${snapshot.revisionId}/previews/html/${snapshot.id}.html`
        const stage = await store.stageOutput(previewHtmlPath, exec.signal, { immutable: true })
        try {
          const argv = [
            'preview', prepared.current.articleAuthorization.processPath,
            '--mode', PREVIEW_MODE,
            '--output', stage.processPath,
            '--json',
          ] as const
          const response = await gateway.run(argv, {
            env: { MD2WECHAT_API_KEY: credentialValue },
            secrets: resolved.secrets,
            signal: exec.signal,
            beforeSpawn: async (spawnSignal) => {
              await prepared.current.articleAuthorization.beforeSpawn(spawnSignal)
              for (const image of prepared.localImages) await image.authorization.beforeSpawn(spawnSignal)
              await stage.beforeSpawn(spawnSignal)
              const current = await prepareInputs(store, args.manifestPath, spawnSignal)
              const currentSnapshot = createPreviewSnapshot(snapshotInputFor(
                current,
                layoutBaseUrl,
                credentialReference,
                credentialValue,
              ))
              if (currentSnapshot.id !== snapshot.id) throw new Error('preview inputs changed before spawn')
            },
          })
          exec.signal.throwIfAborted()
          validatePreviewResponse(response, stage.processPath, prepared)
          const html = await stage.read(PREVIEW_HTML_LIMIT_BYTES, exec.signal)
          const issued = now()
          if (Number.isNaN(issued.getTime())) throw new Error('preview clock returned an invalid time')
          const expires = new Date(issued.getTime() + previewTtlMs)
          const receipt = createPreviewReceipt({
            snapshot,
            previewHtmlPath,
            previewHtmlBytes: html,
            credentialValue,
            issuedAt: issued.toISOString(),
            expiresAt: expires.toISOString(),
          })
          transaction = { state: 'published', snapshot, receipt }
          await stage.commit(exec.signal)
          transaction = await publishPreviewSnapshot(store, transaction, exec.signal)
          await appendOperation(store, prepared.current.revision, {
            operation: 'preview',
            createdAt: issued.toISOString(),
            details: {
              previewReceiptId: receipt.id,
              previewSnapshotId: snapshot.id,
              previewHtmlPath,
              expiresAt: receipt.expiresAt,
            },
          }, resolved.secrets)
          return domainResult({
            manifestPath: prepared.current.manifestPath,
            previewHtmlPath,
            revisionId: prepared.current.revision.id,
            previewReceiptId: receipt.id,
          })
        } catch (error) {
          let failure: unknown = error
          try {
            await stage.cleanup()
          } catch (cleanupError) {
            failure = new AggregateError([failure, cleanupError], 'preview failed and staged output cleanup also failed')
          }
          try {
            await cleanupPreviewSnapshot(store, transaction)
          } catch (cleanupError) {
            failure = new AggregateError([failure, cleanupError], 'preview failed and transaction cleanup also failed')
          }
          throw sanitizeError(failure, [
            ...resolved.secrets,
            credentialReference,
            store.workspace,
            stage.processPath,
            prepared.current.articleAuthorization.processPath,
            ...prepared.localImages.map(image => image.authorization.processPath),
          ])
        }
      })
    },
    presentCall: args => genericCall('Preview md2wechat article', 'edit', args.manifestPath, previewCallLocations(args.manifestPath)),
    presentResult: () => genericResult('Article preview ready'),
  })
}

function snapshotInputFor(
  prepared: PreparedPreviewInputs,
  layoutBaseUrl: string,
  credentialReference: string,
  credentialValue: string,
): PreviewSnapshotInput {
  return {
    revisionId: prepared.current.revision.id,
    articlePath: prepared.current.articlePath,
    articleBytes: prepared.current.articleBytes,
    localImages: prepared.localImages.map(image => ({ path: image.path, bytes: image.bytes })),
    layoutBaseUrl,
    previewSettings: { mode: PREVIEW_MODE, output: PREVIEW_OUTPUT },
    credentialReference,
    credentialValue,
    pluginVersion: PLUGIN_VERSION,
    cliVersion: SUPPORTED_CLI_VERSION,
  }
}

async function prepareInputs(
  store: ArtifactStore,
  manifestPath: string,
  signal: AbortSignal,
): Promise<PreparedPreviewInputs> {
  const current = await loadCurrentArticleRevision(store, manifestPath, signal)
  const destinations = discoverMarkdownImageDestinations(current.articleBytes)
  const revisionRoot = `revisions/${current.revision.id}`
  const portablePaths = new Set<string>()
  const localImages: LocalPreviewImage[] = []
  for (const destination of destinations) {
    if (isNonLocalImage(destination)) continue
    const path = resolveLocalImagePath(revisionRoot, destination)
    const portable = path.normalize('NFC').toLowerCase()
    if (portablePaths.has(portable)) throw new Error('preview local images contain duplicate aliases')
    portablePaths.add(portable)
    await store.assertContainedWithin(revisionRoot, path, signal)
    const bytes = await store.read(path, signal)
    if (bytes.byteLength === 0) throw new Error('preview local image must not be empty')
    const authorization = await store.authorizeRead(path, sha256(bytes), signal)
    localImages.push({ path, bytes, authorization })
  }
  localImages.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  return {
    current,
    localImages,
    contentId: sha256Text(JSON.stringify({
      revisionId: current.revision.id,
      articleSha256: current.revision.articleSha256,
      localImages: localImages.map(image => ({ path: image.path, sha256: sha256(image.bytes) })),
    })),
  }
}

function discoverMarkdownImageDestinations(bytes: Uint8Array): readonly string[] {
  let markdown: string
  try {
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new TypeError('preview article must be valid UTF-8', { cause: error })
  }
  const destinations: string[] = []
  const image = /!\[[^\]]*\]\((__generate:[^)]+__|<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/uy
  let cursor = 0
  while (true) {
    const marker = markdown.indexOf('![', cursor)
    if (marker < 0) return destinations
    image.lastIndex = marker
    const match = image.exec(markdown)
    if (match === null) throw new Error('unsupported or malformed Markdown image syntax')
    const raw = match[1]!
    const destination = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1).trim() : raw.trim()
    if (destination.length === 0) throw new Error('Markdown image destination must not be empty')
    destinations.push(destination)
    cursor = image.lastIndex
  }
}

function isNonLocalImage(destination: string): boolean {
  return destination.startsWith('#')
    || destination.startsWith('//')
    || (destination.startsWith('__generate:') && destination.endsWith('__'))
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(destination)
}

function resolveLocalImagePath(revisionRoot: string, destination: string): string {
  if (containsControl(destination)) throw new Error('local Markdown image destination contains a control character')
  if (destination.includes('\\') || destination.includes('?') || destination.includes('#') || destination.includes('%')) {
    throw new Error('local Markdown image destination is ambiguous or non-portable')
  }
  if (destination.startsWith('/')) throw new Error('local Markdown image destination must be revision-relative')
  const normalized = posix.normalize(destination)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('local Markdown image destination must stay below its revision')
  }
  return posix.join(revisionRoot, normalized)
}

function validatePreviewResponse(
  response: CliEnvelope,
  expectedOutput: string,
  prepared: PreparedPreviewInputs,
): void {
  if (!response.success
    || response.code !== 'PREVIEW_READY'
    || response.message !== 'Preview ready'
    || response.status !== 'completed'
    || response.retryable
    || response.error !== undefined
    || response.error_details !== undefined
    || response.next_actions !== undefined) {
    throw new Error('md2wechat preview did not return the supported PREVIEW_READY response')
  }
  const data = requiredRecord(response.data, 'preview data')
  assertExactKeys(data, ['output_file', 'inspect', 'render'], 'preview data')
  if (data.output_file !== expectedOutput) throw new Error('preview output path does not match its private staging authorization')
  const render = requiredRecord(data.render, 'preview render')
  assertExactKeys(render, ['mode', 'theme', 'fidelity', 'exact_html'], 'preview render')
  if (render.mode !== 'api' || render.fidelity !== 'exact' || render.exact_html !== true) {
    throw new Error('preview render does not provide exact API HTML')
  }
  const theme = requiredSafeString(render.theme, 'preview render theme')
  validateInspect(data.inspect, prepared, theme)
}

function validateInspect(value: unknown, prepared: PreparedPreviewInputs, theme: string): void {
  const inspect = requiredRecord(value, 'preview inspect')
  assertAllowedKeys(inspect, ['source_file', 'source_dir', 'context', 'metadata', 'structure', 'assets', 'readiness', 'checks'], ['source_file', 'source_dir', 'context', 'metadata', 'structure', 'readiness'], 'preview inspect')
  if (inspect.source_file !== prepared.current.articleAuthorization.processPath
    || inspect.source_dir !== dirname(prepared.current.articleAuthorization.processPath)) {
    throw new Error('preview inspect source does not match the authorized article')
  }
  const context = requiredRecord(inspect.context, 'preview inspect context')
  assertExactKeys(context, ['mode', 'theme', 'font_size', 'background_type', 'custom_prompt', 'upload', 'draft'], 'preview inspect context')
  if (context.mode !== 'api' || context.theme !== theme || context.custom_prompt !== false || context.upload !== false || context.draft !== false) {
    throw new Error('preview inspect context does not match the requested operation')
  }
  requiredSafeString(context.font_size, 'preview inspect font size')
  requiredSafeString(context.background_type, 'preview inspect background type')
  const metadata = requiredRecord(inspect.metadata, 'preview inspect metadata')
  assertExactKeys(metadata, ['title', 'author', 'digest'], 'preview inspect metadata')
  for (const name of ['title', 'author', 'digest']) validateMetadataField(metadata[name], `preview inspect ${name}`)
  validateStructure(inspect.structure)
  validateAssets(inspect.assets, prepared)
  validateReadiness(inspect.readiness)
  validateChecks(inspect.checks)
}

function validateMetadataField(value: unknown, field: string): void {
  const metadata = requiredRecord(value, field)
  assertExactKeys(metadata, ['value', 'source', 'limit', 'length', 'valid'], field)
  if (typeof metadata.value !== 'string' || typeof metadata.source !== 'string' || typeof metadata.valid !== 'boolean') throw new TypeError(`${field} contains malformed values`)
  nonNegativeInteger(metadata.limit, `${field} limit`)
  nonNegativeInteger(metadata.length, `${field} length`)
}

function validateStructure(value: unknown): void {
  const structure = requiredRecord(value, 'preview inspect structure')
  assertAllowedKeys(structure, ['body_h1', 'duplicate_title_risk', 'headings', 'images'], ['body_h1', 'duplicate_title_risk', 'images'], 'preview inspect structure')
  const bodyH1 = requiredRecord(structure.body_h1, 'preview inspect body_h1')
  assertAllowedKeys(bodyH1, ['present', 'text'], ['present'], 'preview inspect body_h1')
  if (typeof bodyH1.present !== 'boolean' || (bodyH1.text !== undefined && typeof bodyH1.text !== 'string')) throw new TypeError('preview inspect body_h1 is malformed')
  if (typeof structure.duplicate_title_risk !== 'boolean') throw new TypeError('preview inspect duplicate-title risk must be a boolean')
  if (structure.headings !== undefined) {
    for (const entry of requiredArray(structure.headings, 'preview inspect headings')) {
      const heading = requiredRecord(entry, 'preview inspect heading')
      assertExactKeys(heading, ['level', 'text'], 'preview inspect heading')
      nonNegativeInteger(heading.level, 'preview inspect heading level')
      if (typeof heading.text !== 'string') throw new TypeError('preview inspect heading text must be a string')
    }
  }
  const images = requiredRecord(structure.images, 'preview inspect image counters')
  assertExactKeys(images, ['total', 'local', 'remote', 'ai'], 'preview inspect image counters')
  for (const key of ['total', 'local', 'remote', 'ai']) nonNegativeInteger(images[key], `preview inspect image ${key}`)
}

function validateAssets(value: unknown, prepared: PreparedPreviewInputs): void {
  const assets = value === undefined ? [] : requiredArray(value, 'preview inspect assets')
  const expected = new Map(prepared.localImages.map((image, index) => [image.authorization.processPath, index]))
  if (assets.length !== expected.size) throw new TypeError('preview inspect assets do not match local Markdown images')
  const seen = new Set<string>()
  for (const entry of assets) {
    const asset = requiredRecord(entry, 'preview inspect asset')
    assertAllowedKeys(asset, ['index', 'kind', 'source', 'resolved_source', 'exists'], ['index', 'kind', 'source', 'exists'], 'preview inspect asset')
    nonNegativeInteger(asset.index, 'preview inspect asset index')
    requiredSafeString(asset.kind, 'preview inspect asset kind')
    requiredSafeString(asset.source, 'preview inspect asset source')
    if (asset.exists !== true || typeof asset.resolved_source !== 'string' || !expected.has(asset.resolved_source) || seen.has(asset.resolved_source)) {
      throw new TypeError('preview inspect asset does not match an authorized local image')
    }
    seen.add(asset.resolved_source)
  }
}

function validateReadiness(value: unknown): void {
  const readiness = requiredRecord(value, 'preview inspect readiness')
  assertExactKeys(readiness, ['convert_ready', 'upload_ready', 'draft_ready', 'preview_fidelity', 'schema_version', 'targets', 'blockers'], 'preview inspect readiness')
  if (readiness.convert_ready !== true
    || typeof readiness.upload_ready !== 'boolean'
    || typeof readiness.draft_ready !== 'boolean'
    || readiness.preview_fidelity !== 'exact'
    || readiness.schema_version !== 'v1') throw new TypeError('preview inspect readiness is malformed')
  const targets = requiredRecord(readiness.targets, 'preview inspect targets')
  assertExactKeys(targets, ['preview', 'convert', 'upload', 'draft'], 'preview inspect targets')
  for (const key of ['preview', 'convert', 'upload', 'draft']) requiredSafeString(targets[key], `preview inspect target ${key}`)
  for (const entry of requiredArray(readiness.blockers, 'preview inspect blockers')) {
    validateDiagnostic(entry, 'preview inspect blocker', true)
  }
}

function validateChecks(value: unknown): void {
  if (value === undefined) return
  for (const entry of requiredArray(value, 'preview inspect checks')) validateDiagnostic(entry, 'preview inspect check', false)
}

function validateDiagnostic(value: unknown, field: string, blocker: boolean): void {
  const diagnostic = requiredRecord(value, field)
  const allowed = blocker
    ? ['code', 'field', 'level', 'message', 'blocks', 'suggested_fix']
    : ['level', 'code', 'message', 'field', 'suggested_fix']
  const required = blocker ? ['code', 'level', 'message', 'blocks'] : ['level', 'code', 'message']
  assertAllowedKeys(diagnostic, allowed, required, field)
  for (const key of ['level', 'code', 'message']) requiredSafeString(diagnostic[key], `${field} ${key}`)
  if (diagnostic.field !== undefined && typeof diagnostic.field !== 'string') throw new TypeError(`${field} field must be a string`)
  if (diagnostic.suggested_fix !== undefined && typeof diagnostic.suggested_fix !== 'string') throw new TypeError(`${field} suggested fix must be a string`)
  if (blocker) {
    for (const item of requiredArray(diagnostic.blocks, `${field} blocks`)) requiredSafeString(item, `${field} block`)
  }
}

function assertApproved(outcome: ApprovalOutcome): void {
  switch (outcome) {
    case 'allowed-once':
      return
    case 'rejected':
    case 'cancelled':
    case 'unavailable':
      throw new Error(`article preview approval ${outcome}`)
    default:
      return assertNever(outcome)
  }
}

function previewCallLocations(manifestPath: string): readonly string[] {
  const match = /^revisions\/([a-f0-9]{64})\/manifest\.json$/u.exec(manifestPath)
  return match === null ? [manifestPath] : [manifestPath, `revisions/${match[1]!}/article.md`]
}

function assertKnownArguments(args: object, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error(`unknown preview argument ${key}`)
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${field} must be an object`)
  return value as Record<string, unknown>
}

function requiredArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  return value
}

function requiredSafeString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || containsControl(value)) throw new TypeError(`${field} must be a non-empty safe string`)
  return value
}

function containsControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`)
  return value
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  assertAllowedKeys(value, keys, keys, field)
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], field: string): void {
  const allowedSet = new Set(allowed)
  if (Object.keys(value).some(key => !allowedSet.has(key)) || required.some(key => !(key in value))) {
    throw new TypeError(`${field} contains unsupported or missing fields`)
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function enqueuePreview<T>(identity: string, operation: () => Promise<T>): Promise<T> {
  const previous = previewQueues.get(identity) ?? Promise.resolve()
  const current = previous.then(operation, operation)
  const tail = current.then(() => undefined, () => undefined)
  previewQueues.set(identity, tail)
  try {
    return await current
  } finally {
    if (previewQueues.get(identity) === tail) previewQueues.delete(identity)
  }
}

function assertNever(value: never): never {
  throw new TypeError(`unsupported preview value ${String(value)}`)
}
