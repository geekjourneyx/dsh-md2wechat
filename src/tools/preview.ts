import { creatorCliError, creatorRemoteError, knownCreatorFailure } from '../creator/errors.ts'
import { createHash } from 'node:crypto'
import { dirname, posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { CredentialEnvironmentName } from '../config.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { probeCliVersion } from '../cli/gateway.ts'
import type { CliGateway } from '../cli/gateway.ts'
import type { CliEnvelope } from '../cli/protocol.ts'
import { resolveOperationEnv } from '../security/credentials.ts'
import type { OperationCredentialServices } from '../security/credentials.ts'
import { PLUGIN_VERSION, UNKNOWN_CLI_VERSION } from '../version.ts'
import type { ArtifactReadAuthorization, ArtifactStore } from '../workspace/artifact-store.ts'
import { appendOperation } from '../workspace/revision.ts'
import {
  cleanupPreviewSnapshot,
  createPreviewPublicationOwnership,
  createPreviewReceipt,
  createPreviewSnapshot,
  PREVIEW_HTML_LIMIT_BYTES,
  publishPreviewSnapshot,
} from '../workspace/preview.ts'
import type { PreviewSnapshotInput, PreviewTransaction } from '../workspace/preview.ts'
import type { PreviewAsset, PreviewMetadata } from '../workspace/preview.ts'
import { domainResult, genericCall, genericResult } from './shared.ts'
import { loadCurrentArticleRevision } from './improve-article.ts'
import type { CurrentArticleRevision } from './improve-article.ts'

const TOOL_NAME = 'md2wechat_preview'
const PREVIEW_MODE = 'api'
const PREVIEW_OUTPUT = 'standalone-html'
const DEFAULT_PREVIEW_TTL_MS = 10 * 60 * 1000
const previewQueues = new Map<string, Promise<unknown>>()

class SafePreviewError extends Error {}
class PreviewCancelledError extends Error {}

type PreviewFontSize = 'small' | 'medium' | 'large'
type PreviewBackgroundType = 'default' | 'grid' | 'none'

export interface PreviewToolDependencies {
  gateway: CliGateway
  store: ArtifactStore
  layoutBaseUrl: string
  credentialRefs: OperationCredentialServices['credentialRefs']
  credentials: OperationCredentialServices['credentials']
  approval: Pick<Context['approval'], 'request'>
  previewTheme: string
  previewFontSize: PreviewFontSize
  previewBackgroundType: PreviewBackgroundType
  now?: () => Date
  previewTtlMs?: number
  reportAuditFailure: (message: string) => void
}

interface LocalPreviewImage {
  source: string
  path: string
  bytes: Uint8Array
  authorization: ArtifactReadAuthorization
}

type PreparedPreviewAsset =
  | { index: number; kind: 'local'; source: string; image: LocalPreviewImage }
  | { index: number; kind: 'online'; source: string }
  | { index: number; kind: 'ai'; source: string }

export interface PreparedPreviewInputs {
  current: CurrentArticleRevision
  localImages: readonly LocalPreviewImage[]
  assets: readonly PreparedPreviewAsset[]
  contentId: string
}

/**
 * Create the approved provider-backed article preview tool.
 * @param dependencies - Gateway, storage, rendering config, credentials, approval service, clock, and TTL.
 * @returns Registry-ready typed DSH tool.
 */
export function createPreviewOperation({
  gateway,
  store,
  layoutBaseUrl,
  credentialRefs,
  credentials,
  approval,
  previewTheme,
  previewFontSize,
  previewBackgroundType,
  now = () => new Date(),
  previewTtlMs = DEFAULT_PREVIEW_TTL_MS,
  reportAuditFailure,
}: PreviewToolDependencies, origin: 'tool' | 'user-interface' = 'tool') {
  if (!Number.isSafeInteger(previewTtlMs) || previewTtlMs < 1) throw new TypeError('preview TTL must be a positive safe integer')
  requiredSafeString(layoutBaseUrl, 'preview layout base URL')
  requiredSafeString(previewTheme, 'preview theme')
  oneOf(previewFontSize, ['small', 'medium', 'large'], 'preview font size')
  oneOf(previewBackgroundType, ['default', 'grid', 'none'], 'preview background type')
  if (typeof reportAuditFailure !== 'function') throw new TypeError('preview audit failure reporter is required')
  return async (args: { manifestPath: string }, exec: Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>) => {
      try {
        assertKnownArguments(args, ['manifestPath'])
        exec.signal.throwIfAborted()
        const preparedBeforeApproval = await preparePreviewInputs(store, args.manifestPath, exec.signal)
        if (exec.agent === undefined) throw new SafePreviewError('article preview requires an active agent')
        // A direct preview button is the user's request to use the configured renderer.
        // Agent-initiated tools retain their separate host approval.
        if (origin === 'tool') {
        const outcome = await approval.request({
          agent: exec.agent,
          toolName: TOOL_NAME,
          callId: exec.callId,
          reason: `Send this article to ${layoutBaseUrl} to generate its preview using the configured md2wechat credential.`,
          signal: exec.signal,
        })
        assertApproved(outcome)
        }
        exec.signal.throwIfAborted()

        const credentialReference = credentialRefs.MD2WECHAT_API_KEY
        if (credentialReference === undefined) throw new SafePreviewError('MD2WECHAT_API_KEY is not configured for article preview')
        const resolved = await resolveOperationEnv(['MD2WECHAT_API_KEY'] satisfies readonly CredentialEnvironmentName[], {
          credentialRefs,
          credentials,
        })
        const credentialValue = resolved.env.MD2WECHAT_API_KEY
        if (credentialValue === undefined) throw new SafePreviewError('MD2WECHAT_API_KEY is not configured for article preview')
        exec.signal.throwIfAborted()

        const queueIdentity = await store.canonicalIdentity(
          `revisions/${preparedBeforeApproval.current.revision.id}/previews/current.json`,
          exec.signal,
        )
        return await enqueuePreview(queueIdentity, async () => {
          exec.signal.throwIfAborted()
          const prepared = await preparePreviewInputs(store, args.manifestPath, exec.signal)
          if (prepared.contentId !== preparedBeforeApproval.contentId) {
            throw new SafePreviewError('preview inputs changed after approval')
          }
          const cliVersion = await probeCliVersion(gateway, exec.signal)
          const snapshotInput = previewSnapshotInputFor(
            prepared,
            layoutBaseUrl,
            credentialReference,
            credentialValue,
            previewTheme,
            previewFontSize,
            previewBackgroundType,
            cliVersion,
          )
          const snapshot = createPreviewSnapshot(snapshotInput)
          let transaction: PreviewTransaction = { state: 'prepared', snapshot }
          const previewHtmlPath = `revisions/${snapshot.revisionId}/previews/html/${snapshot.id}.html`
          const stage = await store.stageOutput(previewHtmlPath, exec.signal, { immutable: true })
          try {
            const argv = [
              'preview', prepared.current.articleAuthorization.processPath,
              '--mode', PREVIEW_MODE,
              '--theme', previewTheme,
              '--font-size', previewFontSize,
              '--background-type', previewBackgroundType,
              '--output', stage.processPath,
              '--json',
            ] as const
            const response = await gateway.run(argv, {
              env: { MD2WECHAT_API_KEY: credentialValue, MD2WECHAT_BASE_URL: layoutBaseUrl },
              secrets: resolved.secrets,
              signal: exec.signal,
              beforeSpawn: async (spawnSignal) => {
                await prepared.current.articleAuthorization.beforeSpawn(spawnSignal)
                for (const image of prepared.localImages) await image.authorization.beforeSpawn(spawnSignal)
                await stage.beforeSpawn(spawnSignal)
                const current = await preparePreviewInputs(store, args.manifestPath, spawnSignal)
                const currentSnapshot = createPreviewSnapshot(previewSnapshotInputFor(
                  current,
                  layoutBaseUrl,
                  credentialReference,
                  credentialValue,
                  previewTheme,
                  previewFontSize,
                  previewBackgroundType,
                  await probeCliVersion(gateway, spawnSignal),
                ))
                if (currentSnapshot.id !== snapshot.id) throw new SafePreviewError('preview inputs changed before spawn')
              },
            })
            exec.signal.throwIfAborted()
            const projection = validatePreviewResponse(response, stage.processPath, prepared, {
              theme: previewTheme,
              fontSize: previewFontSize,
              backgroundType: previewBackgroundType,
            })
            const html = await stage.read(PREVIEW_HTML_LIMIT_BYTES, exec.signal)
            const issued = now()
            if (Number.isNaN(issued.getTime())) throw new SafePreviewError('preview clock returned an invalid time')
            const expires = new Date(issued.getTime() + previewTtlMs)
            const receipt = createPreviewReceipt({
              snapshot,
              previewHtmlPath,
              previewHtmlBytes: html,
              credentialValue,
              issuedAt: issued.toISOString(),
              expiresAt: expires.toISOString(),
              metadata: projection.metadata,
              assets: projection.assets,
            })
            const ownership = createPreviewPublicationOwnership()
            transaction = { state: 'published', snapshot, receipt, ownership }
            await stage.commit(exec.signal, ownership.html)
            transaction = await publishPreviewSnapshot(store, transaction, exec.signal)
            try {
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
            } catch (operationHistoryError) {
              void operationHistoryError
              try {
                reportAuditFailure('article preview operation history could not be recorded')
              } catch (auditReporterError) {
                void auditReporterError
                // The advisory reporter cannot revoke a preview whose current pointer already committed.
              }
            }
            return domainResult({
              manifestPath: prepared.current.manifestPath,
              previewHtmlPath,
              revisionId: prepared.current.revision.id,
              previewReceiptId: receipt.id,
            }, cliVersion)
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
            throw failure
          }
        })
      } catch (error) {
        if (exec.signal.aborted || error instanceof PreviewCancelledError) throw new Error('article preview cancelled')
        if (error instanceof SafePreviewError) throw new Error(error.message)
        if (knownCreatorFailure(error)) throw creatorRemoteError(error)
        throw new Error('article preview failed')
      }
  }
}

export function createPreviewTool(dependencies: PreviewToolDependencies) {
  const operation = createPreviewOperation(dependencies)
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
          pluginVersion: { type: 'string', const: PLUGIN_VERSION, required: true },
          cliVersion: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Article preview is ready at ${value.previewHtmlPath}.`,
      }],
    },
    execute: operation,
    presentCall: args => genericCall('Preview md2wechat article', 'edit', args.manifestPath, previewCallLocations(args.manifestPath)),
    presentResult: () => genericResult('Article preview ready'),
  })
}

/**
 * Reconstruct the exact signed preview snapshot input from current bytes, config, and proof credential.
 * @param prepared - Current immutable article and image bytes.
 * @param layoutBaseUrl - Configured layout origin.
 * @param credentialReference - Stable proof credential reference.
 * @param credentialValue - Resolved proof credential value used only for one-way derivation.
 * @param previewTheme - Exact preview theme.
 * @param previewFontSize - Exact preview font size.
 * @param previewBackgroundType - Exact preview background.
 * @param cliVersion - Freshly observed CLI identity bound into the signed preview.
 * @returns Complete snapshot input without persisting credential material.
 */
export function previewSnapshotInputFor(
  prepared: PreparedPreviewInputs,
  layoutBaseUrl: string,
  credentialReference: string,
  credentialValue: string,
  previewTheme: string,
  previewFontSize: PreviewFontSize,
  previewBackgroundType: PreviewBackgroundType,
  cliVersion: string = UNKNOWN_CLI_VERSION,
): PreviewSnapshotInput {
  return {
    revisionId: prepared.current.revision.id,
    articlePath: prepared.current.articlePath,
    articleBytes: prepared.current.articleBytes,
    localImages: prepared.localImages.map(image => ({ path: image.path, bytes: image.bytes })),
    layoutBaseUrl,
    previewSettings: {
      mode: PREVIEW_MODE,
      theme: previewTheme,
      fontSize: previewFontSize,
      backgroundType: previewBackgroundType,
      output: PREVIEW_OUTPUT,
    },
    credentialReference,
    credentialValue,
    pluginVersion: PLUGIN_VERSION,
    cliVersion,
  }
}

/**
 * Load the current immutable revision and every exact Markdown image input used by preview validation.
 * @param store - Contained artifact store.
 * @param manifestPath - Current revision manifest artifact path.
 * @param signal - Cancellation signal.
 * @returns Current article, local bytes, ordered assets, and freshness identity.
 */
export async function preparePreviewInputs(
  store: ArtifactStore,
  manifestPath: string,
  signal: AbortSignal,
): Promise<PreparedPreviewInputs> {
  const current = await loadCurrentArticleRevision(store, manifestPath, signal)
  const destinations = discoverMarkdownImageDestinations(current.articleBytes)
  const revisionRoot = `revisions/${current.revision.id}`
  const portablePaths = new Set<string>()
  const localImages: LocalPreviewImage[] = []
  const assets: PreparedPreviewAsset[] = []
  for (const [index, destination] of destinations.entries()) {
    if (destination.startsWith('http://') || destination.startsWith('https://')) {
      assets.push({ index, kind: 'online', source: destination })
      continue
    }
    if (destination.startsWith('__generate:') && destination.endsWith('__')) {
      const prompt = destination.slice('__generate:'.length, -2)
      requiredSafeString(prompt, 'generated Markdown image prompt')
      assets.push({ index, kind: 'ai', source: prompt })
      continue
    }
    if (destination.startsWith('#')
      || destination.startsWith('//')
      || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(destination)) {
      throw new Error('unsupported Markdown image destination')
    }
    const path = resolveLocalImagePath(revisionRoot, destination)
    const portable = path.normalize('NFC').toLowerCase()
    if (portablePaths.has(portable)) throw new Error('preview local images contain duplicate aliases')
    portablePaths.add(portable)
    await store.assertContainedWithin(revisionRoot, path, signal)
    const bytes = await store.read(path, signal)
    if (bytes.byteLength === 0) throw new Error('preview local image must not be empty')
    const authorization = await store.authorizeRead(path, sha256(bytes), signal)
    const image = { source: destination, path, bytes, authorization }
    localImages.push(image)
    assets.push({ index, kind: 'local', source: destination, image })
  }
  localImages.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return {
    current,
    localImages,
    assets,
    contentId: sha256Text(JSON.stringify({
      revisionId: current.revision.id,
      articleSha256: current.revision.articleSha256,
      localImages: localImages.map(image => ({ path: image.path, sha256: sha256(image.bytes) })),
    })),
  }
}

export function discoverMarkdownImageDestinations(bytes: Uint8Array): readonly string[] {
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

export function resolveLocalImagePath(revisionRoot: string, destination: string): string {
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
  settings: { theme: string; fontSize: PreviewFontSize; backgroundType: PreviewBackgroundType },
): { metadata: PreviewMetadata; assets: readonly PreviewAsset[] } {
  if (!response.success || response.status === 'action_required') throw creatorCliError(response)
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
  if (render.mode !== 'api' || render.theme !== settings.theme || render.fidelity !== 'exact' || render.exact_html !== true) {
    throw new Error('preview render does not provide exact API HTML')
  }
  return validateInspect(data.inspect, prepared, settings)
}

function validateInspect(
  value: unknown,
  prepared: PreparedPreviewInputs,
  settings: { theme: string; fontSize: PreviewFontSize; backgroundType: PreviewBackgroundType },
): { metadata: PreviewMetadata; assets: readonly PreviewAsset[] } {
  const inspect = requiredRecord(value, 'preview inspect')
  assertAllowedKeys(inspect, ['source_file', 'source_dir', 'context', 'metadata', 'structure', 'assets', 'readiness', 'checks'], ['source_file', 'source_dir', 'context', 'metadata', 'structure', 'readiness'], 'preview inspect')
  if (inspect.source_file !== prepared.current.articleAuthorization.processPath
    || inspect.source_dir !== dirname(prepared.current.articleAuthorization.processPath)) {
    throw new Error('preview inspect source does not match the authorized article')
  }
  const context = requiredRecord(inspect.context, 'preview inspect context')
  assertExactKeys(context, ['mode', 'theme', 'font_size', 'background_type', 'custom_prompt', 'upload', 'draft'], 'preview inspect context')
  if (context.mode !== 'api'
    || context.theme !== settings.theme
    || context.font_size !== settings.fontSize
    || context.background_type !== settings.backgroundType
    || context.custom_prompt !== false
    || context.upload !== false
    || context.draft !== false) {
    throw new Error('preview inspect context does not match the requested operation')
  }
  const metadata = requiredRecord(inspect.metadata, 'preview inspect metadata')
  assertExactKeys(metadata, ['title', 'author', 'digest'], 'preview inspect metadata')
  const title = validateMetadataField(metadata.title, 'title')
  const author = validateMetadataField(metadata.author, 'author')
  const digest = validateMetadataField(metadata.digest, 'digest')
  const structure = validateStructure(inspect.structure, prepared, title)
  validateAssets(inspect.assets, prepared)
  const checks = validateChecks(inspect.checks)
  const expectedCheckCodes: (keyof typeof diagnosticSpecs)[] = []
  if (!title.valid) expectedCheckCodes.push('TITLE_TOO_LONG')
  if (!author.valid) expectedCheckCodes.push('AUTHOR_TOO_LONG')
  if (!digest.valid) expectedCheckCodes.push('DIGEST_TOO_LONG')
  if (structure.duplicateTitleRisk) expectedCheckCodes.push('DUPLICATE_H1')
  else if (structure.bodyH1Text !== undefined && title.value.trim() !== '' && structure.bodyH1Text !== title.value) {
    expectedCheckCodes.push('TITLE_BODY_MISMATCH')
  }
  if (digest.value.trim() !== '') expectedCheckCodes.push('DIGEST_METADATA_ONLY')
  for (const asset of prepared.assets) {
    if (asset.kind === 'local' && !hasSupportedImageExtension(asset.source)) {
      expectedCheckCodes.push('LOCAL_IMAGE_UNSUPPORTED_FORMAT')
    }
  }
  if (prepared.assets.length > 0) expectedCheckCodes.push('IMAGE_REPLACEMENT_REQUIRES_UPLOAD_OR_DRAFT')
  if (checks.length !== expectedCheckCodes.length || checks.some((check, index) => check.code !== expectedCheckCodes[index])) {
    throw new TypeError('preview inspect checks do not match the prepared article')
  }
  validateReadiness(inspect.readiness, checks)
  if (!title.valid) throw creatorRemoteError(undefined, 'PREVIEW_TITLE_INVALID')
  if (!author.valid) throw creatorRemoteError(undefined, 'PREVIEW_AUTHOR_INVALID')
  if (!digest.valid) throw creatorRemoteError(undefined, 'PREVIEW_DIGEST_INVALID')
  return {
    metadata: { title: title.value, author: author.value, digest: digest.value },
    assets: prepared.assets.map(asset => asset.kind === 'local'
      ? { index: asset.index, kind: 'local' as const, source: asset.source, path: asset.image.path, sha256: createHash('sha256').update(asset.image.bytes).digest('hex') }
      : { index: asset.index, kind: asset.kind, source: asset.source }),
  }
}

function validateMetadataField(value: unknown, name: 'title' | 'author' | 'digest'): { value: string; source: string; valid: boolean } {
  const field = `preview inspect ${name}`
  const metadata = requiredRecord(value, field)
  assertExactKeys(metadata, ['value', 'source', 'limit', 'length', 'valid'], field)
  if (typeof metadata.value !== 'string') throw new TypeError(`${field} value must be a string`)
  const sources = {
    title: ['frontmatter.title', 'markdown.heading', 'fallback.untitled'],
    author: ['frontmatter.author', 'fallback.empty'],
    digest: ['frontmatter.digest', 'frontmatter.summary', 'frontmatter.description', 'fallback.empty'],
  } as const
  const source = oneOf(metadata.source, sources[name], `${field} source`)
  const limits = { title: 32, author: 16, digest: 128 } as const
  const length = [...metadata.value].length
  if (metadata.limit !== limits[name] || metadata.length !== length || metadata.valid !== (length <= limits[name])) {
    throw new TypeError(`${field} counters do not match its value`)
  }
  if ((source === 'fallback.empty' && metadata.value !== '')
    || (source === 'fallback.untitled' && metadata.value !== '未命名文章')) {
    throw new TypeError(`${field} fallback source does not match its value`)
  }
  return { value: metadata.value, source, valid: metadata.valid as boolean }
}

function validateStructure(
  value: unknown,
  prepared: PreparedPreviewInputs,
  title: { value: string; source: string },
): { duplicateTitleRisk: boolean; bodyH1Text?: string } {
  const structure = requiredRecord(value, 'preview inspect structure')
  assertAllowedKeys(structure, ['body_h1', 'duplicate_title_risk', 'headings', 'images'], ['body_h1', 'duplicate_title_risk', 'images'], 'preview inspect structure')
  const bodyH1 = requiredRecord(structure.body_h1, 'preview inspect body_h1')
  assertAllowedKeys(bodyH1, ['present', 'text'], ['present'], 'preview inspect body_h1')
  const headings = structure.headings === undefined ? [] : requiredArray(structure.headings, 'preview inspect headings')
  let firstBodyH1: string | undefined
  for (const entry of headings) {
    const heading = requiredRecord(entry, 'preview inspect heading')
    assertExactKeys(heading, ['level', 'text'], 'preview inspect heading')
    const level = positiveInteger(heading.level, 'preview inspect heading level')
    const text = requiredSafeString(heading.text, 'preview inspect heading text')
    if (level === 1 && firstBodyH1 === undefined) firstBodyH1 = text
  }
  if (bodyH1.present !== (firstBodyH1 !== undefined)
    || bodyH1.text !== firstBodyH1
    || structure.duplicate_title_risk !== (firstBodyH1 === title.value && title.value !== '')) {
    throw new TypeError('preview inspect heading summary is inconsistent')
  }
  const images = requiredRecord(structure.images, 'preview inspect image counters')
  assertExactKeys(images, ['total', 'local', 'remote', 'ai'], 'preview inspect image counters')
  const expected = {
    total: prepared.assets.length,
    local: prepared.assets.filter(asset => asset.kind === 'local').length,
    remote: prepared.assets.filter(asset => asset.kind === 'online').length,
    ai: prepared.assets.filter(asset => asset.kind === 'ai').length,
  }
  for (const key of ['total', 'local', 'remote', 'ai'] as const) {
    if (images[key] !== expected[key]) throw new TypeError(`preview inspect image ${key} does not match the article`)
  }
  return {
    duplicateTitleRisk: structure.duplicate_title_risk as boolean,
    ...(firstBodyH1 === undefined ? {} : { bodyH1Text: firstBodyH1 }),
  }
}

function validateAssets(value: unknown, prepared: PreparedPreviewInputs): void {
  const assets = value === undefined ? [] : requiredArray(value, 'preview inspect assets')
  if (assets.length !== prepared.assets.length) throw new TypeError('preview inspect assets do not match Markdown images')
  for (const [index, entry] of assets.entries()) {
    const asset = requiredRecord(entry, 'preview inspect asset')
    assertAllowedKeys(asset, ['index', 'kind', 'source', 'resolved_source', 'exists'], ['index', 'kind', 'source', 'exists'], 'preview inspect asset')
    const expected = prepared.assets[index]!
    if (asset.index !== expected.index || asset.kind !== expected.kind || asset.source !== expected.source || asset.exists !== true) {
      throw new TypeError('preview inspect asset does not match its Markdown image')
    }
    if (expected.kind === 'local') {
      if (asset.resolved_source !== expected.image.authorization.processPath) {
        throw new TypeError('preview inspect local asset does not match its authorized path')
      }
    } else if ('resolved_source' in asset) {
      throw new TypeError('preview inspect non-local asset must not contain a resolved source')
    }
  }
}

interface ValidatedDiagnostic {
  level: 'info' | 'warn' | 'error'
  code: keyof typeof diagnosticSpecs
  message: string
  field?: string
  suggestedFix?: string
}

const diagnosticSpecs = {
  TITLE_TOO_LONG: { level: 'error', field: 'title', blocks: ['convert', 'upload', 'draft'] },
  AUTHOR_TOO_LONG: { level: 'error', field: 'author', blocks: ['convert', 'upload', 'draft'] },
  DIGEST_TOO_LONG: { level: 'error', field: 'digest', blocks: ['convert', 'upload', 'draft'] },
  DUPLICATE_H1: { level: 'warn', field: 'title', blocks: [] },
  TITLE_BODY_MISMATCH: { level: 'info', field: 'title', blocks: [] },
  DIGEST_METADATA_ONLY: { level: 'info', field: 'digest', blocks: [] },
  LOCAL_IMAGE_UNSUPPORTED_FORMAT: { level: 'error', field: 'images', blocks: ['upload', 'draft'] },
  IMAGE_REPLACEMENT_REQUIRES_UPLOAD_OR_DRAFT: { level: 'info', field: 'images', blocks: [] },
} as const

function validateReadiness(value: unknown, checks: readonly ValidatedDiagnostic[]): void {
  const readiness = requiredRecord(value, 'preview inspect readiness')
  assertExactKeys(readiness, ['convert_ready', 'upload_ready', 'draft_ready', 'preview_fidelity', 'schema_version', 'targets', 'blockers'], 'preview inspect readiness')
  const expectedConvertReady = checks.every(check => !(diagnosticSpecs[check.code].blocks as readonly string[]).includes('convert'))
  if (typeof readiness.convert_ready !== 'boolean'
    || typeof readiness.upload_ready !== 'boolean'
    || readiness.draft_ready !== false
    || readiness.convert_ready !== expectedConvertReady
    || readiness.preview_fidelity !== 'exact'
    || readiness.schema_version !== 'v1') throw new TypeError('preview inspect readiness is malformed')
  const targets = requiredRecord(readiness.targets, 'preview inspect targets')
  assertExactKeys(targets, ['preview', 'convert', 'upload', 'draft'], 'preview inspect targets')
  for (const key of ['preview', 'convert', 'upload', 'draft'] as const) {
    oneOf(targets[key], ['ready', 'blocked', 'degraded', 'not_requested'], `preview inspect target ${key}`)
  }
  if (targets.preview !== 'ready'
    || targets.convert !== (readiness.convert_ready ? 'ready' : 'blocked')
    || targets.upload !== 'not_requested'
    || targets.draft !== 'not_requested') {
    throw new TypeError('preview inspect readiness targets do not match the requested operation')
  }
  const expectedBlockers = checks.filter(check => diagnosticSpecs[check.code].blocks.length > 0)
  const blockers = requiredArray(readiness.blockers, 'preview inspect blockers')
  if (blockers.length !== expectedBlockers.length) throw new TypeError('preview inspect blockers do not match checks')
  for (const [index, entry] of blockers.entries()) {
    const blocker = validateDiagnostic(entry, 'preview inspect blocker', true)
    const expected = expectedBlockers[index]!
    const expectedBlocks = diagnosticSpecs[expected.code].blocks
    const actualBlocks = requiredArray(requiredRecord(entry, 'preview inspect blocker').blocks, 'preview inspect blocker blocks')
    if (blocker.level !== 'error'
      || blocker.code !== expected.code
      || blocker.message !== expected.message
      || blocker.field !== expected.field
      || blocker.suggestedFix !== expected.suggestedFix
      || actualBlocks.length !== expectedBlocks.length
      || actualBlocks.some((item, blockIndex) => item !== expectedBlocks[blockIndex])) {
      throw new TypeError('preview inspect blocker does not match its check')
    }
  }
}

function validateChecks(value: unknown): readonly ValidatedDiagnostic[] {
  if (value === undefined) return []
  return requiredArray(value, 'preview inspect checks').map(entry => validateDiagnostic(entry, 'preview inspect check', false))
}

function validateDiagnostic(value: unknown, field: string, blocker: boolean): ValidatedDiagnostic {
  const diagnostic = requiredRecord(value, field)
  const allowed = blocker
    ? ['code', 'field', 'level', 'message', 'blocks', 'suggested_fix']
    : ['level', 'code', 'message', 'field', 'suggested_fix']
  const required = blocker ? ['code', 'level', 'message', 'blocks'] : ['level', 'code', 'message']
  assertAllowedKeys(diagnostic, allowed, required, field)
  const code = oneOf(diagnostic.code, Object.keys(diagnosticSpecs) as (keyof typeof diagnosticSpecs)[], `${field} code`)
  const level = oneOf(diagnostic.level, ['info', 'warn', 'error'], `${field} level`)
  const message = requiredSafeString(diagnostic.message, `${field} message`)
  if (diagnostic.field !== undefined && typeof diagnostic.field !== 'string') throw new TypeError(`${field} field must be a string`)
  if (typeof diagnostic.suggested_fix !== 'string' || diagnostic.suggested_fix.length === 0) throw new TypeError(`${field} suggested fix must be a non-empty string`)
  const spec = diagnosticSpecs[code]
  if (level !== spec.level || diagnostic.field !== spec.field) throw new TypeError(`${field} does not match the validated CLI contract`)
  if (blocker) {
    const blocks = requiredArray(diagnostic.blocks, `${field} blocks`)
    if (blocks.length === 0) throw new TypeError(`${field} blocks must not be empty`)
    for (const item of blocks) oneOf(item, ['convert', 'upload', 'draft'], `${field} block`)
  }
  return {
    level,
    code,
    message,
    ...(diagnostic.field === undefined ? {} : { field: diagnostic.field }),
    ...(diagnostic.suggested_fix === undefined ? {} : { suggestedFix: diagnostic.suggested_fix }),
  }
}

function hasSupportedImageExtension(source: string): boolean {
  return ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(posix.extname(source).toLowerCase())
}

function assertApproved(outcome: ApprovalOutcome): void {
  switch (outcome) {
    case 'allowed-once':
      return
    case 'rejected':
    case 'unavailable':
      throw new SafePreviewError(`article preview approval ${outcome}`)
    case 'cancelled':
      throw new PreviewCancelledError('article preview cancelled')
    default:
      return assertNever(outcome)
  }
}

function previewCallLocations(manifestPath: string): readonly string[] {
  const match = /^revisions\/([a-f0-9]{64})\/manifest\.json$/u.exec(manifestPath)
  return match === null ? [manifestPath] : [manifestPath, `revisions/${match[1]!}/article.md`]
}

function assertKnownArguments(args: object, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new SafePreviewError('article preview contains an unknown argument')
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

function positiveInteger(value: unknown, field: string): number {
  const integer = nonNegativeInteger(value, field)
  if (integer === 0) throw new TypeError(`${field} must be positive`)
  return integer
}

function oneOf<const T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new TypeError(`${field} is unsupported`)
  return value as T
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
