import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { CliGateway } from '../cli/gateway.ts'
import type { CliEnvelope } from '../cli/protocol.ts'
import type { OperationCredentialServices } from '../security/credentials.ts'
import { resolveOperationEnv } from '../security/credentials.ts'
import type { ArtifactStore } from '../workspace/artifact-store.ts'
import { DraftStateStore } from '../workspace/draft.ts'
import { ImagePlanStateStore } from '../workspace/image-plan-state.ts'
import { encodeCanonical, imageResultPath, loadImagePlan, loadVerifiedImageResult } from '../workspace/images.ts'
import type { LoadedImagePlan, PersistedImageResult } from '../workspace/images.ts'
import { preflightCurrentPreview, validateCurrentPreview } from '../workspace/preview.ts'
import type { PreviewReceipt } from '../workspace/preview.ts'
import { appendOperation } from '../workspace/revision.ts'
import { PLUGIN_VERSION, SUPPORTED_CLI_VERSION } from '../version.ts'
import { preparePreviewInputs, previewSnapshotInputFor } from './preview.ts'
import { domainResult, genericCall, genericResult } from './shared.ts'

const TOOL_NAME = 'md2wechat_create_draft'
const MAX_PLAN_PATHS = 128
const MAX_DRAFT_HTML_BYTES = 8 * 1024 * 1024
const MAX_REQUEST_BYTES = 9 * 1024 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })
const htmlDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export interface DraftToolDependencies {
  gateway: CliGateway
  store: ArtifactStore
  state: DraftStateStore
  imagePlanState: ImagePlanStateStore
  layoutBaseUrl: string
  credentialRefs: OperationCredentialServices['credentialRefs']
  credentials: OperationCredentialServices['credentials']
  approval: Pick<Context['approval'], 'request'>
  previewTheme: string
  previewFontSize: 'small' | 'medium' | 'large'
  previewBackgroundType: 'default' | 'grid' | 'none'
  now?: () => Date
  reportAuditFailure: (message: string) => void
}

interface PreparedDraft {
  prepared: Awaited<ReturnType<typeof preparePreviewInputs>>
  receipt: PreviewReceipt
  plans: readonly LoadedImagePlan[]
  results: readonly { plan: LoadedImagePlan; result: PersistedImageResult; resultPath: string; resultSha256: string }[]
  finalizedHtml: Uint8Array
  cover: PersistedImageResult
  operationId: string
  request: Uint8Array
  requestPath: string
  resultPath: string
}

/** Shared domain operation; callers provide real approval-turn context, never a synthetic tool token. */
export function createDraftOperation(dependencies: DraftToolDependencies) {
  if (typeof dependencies.reportAuditFailure !== 'function') throw new TypeError('draft audit failure reporter is required')
  return async (args: { manifestPath: string; previewReceiptId: string; planPaths: readonly string[] }, exec: Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>) => {
      try {
        assertExactArgs(args, ['manifestPath', 'previewReceiptId', 'planPaths'])
        const planPaths = validatePlanPaths(args.planPaths)
        exec.signal.throwIfAborted()
        const preparedBefore = await prepareDraft(dependencies, args.manifestPath, args.previewReceiptId, planPaths, exec.signal)
        const authority = await dependencies.state.inspect(dependencies.store, preparedBefore.operationId, exec.signal)
        if (authority.status === 'completed') return await replayCompleted(dependencies.store, preparedBefore, authority.resultDigest, exec.signal)
        if (authority.status === 'started') throw new SafeDraftError('draft outcome unknown; automatic retry is permanently blocked')
        if (exec.agent === undefined) throw new SafeDraftError('WeChat draft creation requires an active agent')
        const approval = await dependencies.approval.request({ agent: exec.agent, toolName: TOOL_NAME, callId: exec.callId, reason: 'Create one unpublished WeChat draft using already-uploaded body images and cover; this does not mass-send or publish.', signal: exec.signal })
        assertApproved(approval)
        const names = ['MD2WECHAT_API_KEY', 'WECHAT_APPID', 'WECHAT_SECRET'] as const
        for (const name of names) if (dependencies.credentialRefs[name] === undefined) throw new SafeDraftError(`${name} is not configured for WeChat draft creation`)
        const resolved = await resolveOperationEnv(names, dependencies)
        const md2wechatKey = resolved.env.MD2WECHAT_API_KEY
        if (md2wechatKey === undefined || resolved.env.WECHAT_APPID === undefined || resolved.env.WECHAT_SECRET === undefined) throw new SafeDraftError('WeChat draft credentials are incomplete')
        const currentInputs = await preparePreviewInputs(dependencies.store, args.manifestPath, exec.signal)
        const current = await validateCurrentPreview(dependencies.store, {
          snapshotInput: previewSnapshotInputFor(currentInputs, dependencies.layoutBaseUrl, dependencies.credentialRefs.MD2WECHAT_API_KEY!, md2wechatKey, dependencies.previewTheme, dependencies.previewFontSize, dependencies.previewBackgroundType),
          credentialValue: md2wechatKey, now: validNow(dependencies.now), signal: exec.signal,
        })
        if (current.receipt.id !== args.previewReceiptId || currentInputs.contentId !== preparedBefore.prepared.contentId) throw new SafeDraftError('draft inputs changed after approval')
        const prepared = await prepareDraft(dependencies, args.manifestPath, args.previewReceiptId, planPaths, exec.signal)
        if (prepared.operationId !== preparedBefore.operationId || sha256(prepared.request) !== sha256(preparedBefore.request)) throw new SafeDraftError('draft inputs changed after approval')
        await dependencies.store.writeIdenticalOrNew(prepared.requestPath, prepared.request, exec.signal)
        const requestAuthorization = await dependencies.store.authorizeRead(prepared.requestPath, sha256(prepared.request), exec.signal)
        const runtime = await dependencies.state.prepareRuntime(dependencies.store, prepared.operationId, exec.signal)
        await dependencies.state.start(dependencies.store, prepared.operationId, exec.signal)
        const response = await dependencies.gateway.run(['create_draft', requestAuthorization.processPath, '--json'], {
          cwd: runtime, signal: exec.signal, secrets: resolved.secrets,
          env: {
            MD2WECHAT_API_KEY: md2wechatKey, WECHAT_APPID: resolved.env.WECHAT_APPID, WECHAT_SECRET: resolved.env.WECHAT_SECRET,
            WECHAT_ACCOUNT: '', WECHAT_PROXY_URL: '', HOME: runtime, USERPROFILE: runtime,
            XDG_CONFIG_HOME: runtime, APPDATA: runtime, LOCALAPPDATA: runtime,
          },
          beforeSpawn: async signal => { await requestAuthorization.beforeSpawn(signal); await dependencies.state.validateEmptyRuntime(runtime, signal) },
        })
        const projected = projectDraftResponse(response)
        const resultRecord = encodeCanonical({ schemaVersion: 1, operationId: prepared.operationId, revisionId: prepared.prepared.current.revision.id, previewReceiptId: prepared.receipt.id, requestPath: prepared.requestPath, requestSha256: sha256(prepared.request), draftId: projected.draftId, ...(projected.draftUrl === undefined ? {} : { draftUrl: projected.draftUrl }), pluginVersion: PLUGIN_VERSION, cliVersion: SUPPORTED_CLI_VERSION, createdAt: validNow(dependencies.now).toISOString() })
        await dependencies.store.writeIdenticalOrNew(prepared.resultPath, resultRecord, exec.signal)
        const resultDigest = sha256(resultRecord)
        await dependencies.state.complete(dependencies.store, prepared.operationId, resultDigest, exec.signal)
        try { await appendOperation(dependencies.store, prepared.prepared.current.revision, { operation: 'create_draft', createdAt: validNow(dependencies.now).toISOString(), details: { previewReceiptId: prepared.receipt.id, draftResultPath: prepared.resultPath, operationId: prepared.operationId } }, resolved.secrets) } catch { try { dependencies.reportAuditFailure('WeChat draft operation history could not be recorded') } catch { /* advisory reporter cannot revoke committed remote success */ } }
        return draftOutput(prepared, projected.draftId, projected.draftUrl)
      } catch (error) {
        if (exec.signal.aborted || error instanceof DraftCancelledError) throw new Error('WeChat draft creation cancelled')
        if (error instanceof SafeDraftError) throw new Error(error.message)
        throw new Error('WeChat draft creation failed')
      }
  }
}

/**
 * Create one idempotent unpublished WeChat draft tool.
 * @param dependencies - Gateway, storage authorities, preview configuration, credentials, approval, and audit services.
 * @returns Registry-ready typed DSH tool.
 */
export function createDraftTool(dependencies: DraftToolDependencies) {
  const operation = createDraftOperation(dependencies)
  return defineTool({
    name: TOOL_NAME,
    description: 'Create one unpublished WeChat draft from the exact current signed preview and authenticated image results.',
    parameters: {
      manifestPath: { type: 'string', required: true },
      previewReceiptId: { type: 'string', required: true },
      planPaths: { type: 'array', required: true, items: { type: 'string' } },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      manifestPath: { type: 'string', required: true }, revisionId: { type: 'string', required: true }, previewReceiptId: { type: 'string', required: true }, draftId: { type: 'string', required: true }, draftUrl: { type: 'string' }, draftResultPath: { type: 'string', required: true }, pluginVersion: { type: 'string', const: '1.0.0', required: true }, cliVersion: { type: 'string', const: '3.3.0', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: `Unpublished WeChat draft ${value.draftId} is ready.` }] },
    execute: operation,
    presentCall: args => genericCall('Create unpublished WeChat draft', 'edit', undefined, safeLocations(args.manifestPath, args.planPaths)),
    presentResult: () => genericResult('Unpublished WeChat draft ready'),
  })
}

async function prepareDraft(dependencies: DraftToolDependencies, manifestPath: string, receiptId: string, planPaths: readonly string[], signal: AbortSignal): Promise<PreparedDraft> {
  const prepared = await preparePreviewInputs(dependencies.store, manifestPath, signal)
  const preflight = await preflightCurrentPreview(dependencies.store, prepared.current.revision.id, receiptId, validNow(dependencies.now), signal)
  await dependencies.imagePlanState.initialize(dependencies.store, false, signal)
  const plans: LoadedImagePlan[] = []; const results: PreparedDraft['results'][number][] = []
  const planIds = new Set<string>(); const targets = new Set<string>()
  let itemCount = 0
  for (const path of planPaths) {
    const plan = await loadImagePlan(dependencies.store, path, prepared.current.revision.id, prepared.current.articlePath, signal)
    const planBytes = await dependencies.store.readBounded(path, 1024 * 1024, signal)
    await dependencies.imagePlanState.verify(dependencies.store, { planPath: plan.path, planId: plan.planId, revisionId: plan.revisionId, items: plan.canonicalItems, planBytes }, signal)
    if (planIds.has(plan.planId)) throw new Error('duplicate image plan ID'); planIds.add(plan.planId); plans.push(plan)
    for (const item of plan.items) {
      const targetKey = item.targetPath.normalize('NFC').toLowerCase()
      if ([...targets].some(existing => targetKey === existing || targetKey.startsWith(`${existing}/`) || existing.startsWith(`${targetKey}/`))) throw new Error('duplicate or aliased image target'); targets.add(targetKey)
      itemCount += 1
      if (itemCount > 512) throw new Error('draft image batch contains too many items')
      const result = await loadVerifiedImageResult(dependencies.store, plan, item, signal)
      if (result === undefined) throw new Error('image result is incomplete')
      const resultPath = imageResultPath(plan, item); const resultBytes = await dependencies.store.readBounded(resultPath, 1024 * 1024, signal)
      results.push({ plan, result, resultPath, resultSha256: sha256(resultBytes) })
    }
  }
  const coverEntries = results.filter(entry => entry.plan.items.find(item => item.id === entry.result.itemId)?.kind === 'cover')
  if (coverEntries.length !== 1) throw new Error('exactly one verified cover is required')
  const finalizedHtml = finalizeHtml(preflight.receipt, results, preflight.receipt.previewHtmlSha256, await dependencies.store.read(preflight.htmlPath, signal))
  const workspaceIdentity = sha256Text(await dependencies.store.canonicalIdentity('revisions', signal))
  const identityMaterial = {
    workspaceIdentity, revisionId: prepared.current.revision.id, credentialReferences: ['MD2WECHAT_API_KEY', 'WECHAT_APPID', 'WECHAT_SECRET'].map(name => sha256Text(`${name}\0${dependencies.credentialRefs[name] ?? ''}`)),
    receiptId: preflight.receipt.id, accountProvenance: preflight.receipt.accountProvenance, originalHtmlSha256: preflight.receipt.previewHtmlSha256, finalHtmlSha256: sha256(finalizedHtml), metadata: preflight.receipt.metadata,
    cover: { planId: coverEntries[0]!.result.planId, itemId: coverEntries[0]!.result.itemId, mediaId: coverEntries[0]!.result.mediaId, resultSha256: coverEntries[0]!.resultSha256 },
    results: results.map(entry => ({ planId: entry.plan.planId, planSha256: entry.plan.contentSha256, itemId: entry.result.itemId, targetPath: entry.result.targetPath, sha256: entry.result.sha256, mediaId: entry.result.mediaId, wechatUrl: entry.result.wechatUrl, resultSha256: entry.resultSha256 })), pluginVersion: PLUGIN_VERSION, cliVersion: SUPPORTED_CLI_VERSION,
  }
  const operationId = sha256(encodeCanonical(identityMaterial))
  const article: Record<string, unknown> = { title: preflight.receipt.metadata.title, content: htmlDecoder.decode(finalizedHtml), thumb_media_id: coverEntries[0]!.result.mediaId, show_cover_pic: 1 }
  if (preflight.receipt.metadata.author !== '') article.author = preflight.receipt.metadata.author
  if (preflight.receipt.metadata.digest !== '') article.digest = preflight.receipt.metadata.digest
  const request = encodeCanonical({ articles: [article] })
  if (request.byteLength > MAX_REQUEST_BYTES) throw new Error('draft request exceeds the safe size limit')
  return { prepared, receipt: preflight.receipt, plans, results, finalizedHtml, cover: coverEntries[0]!.result, operationId, request, requestPath: `revisions/${prepared.current.revision.id}/drafts/requests/${operationId}.json`, resultPath: `revisions/${prepared.current.revision.id}/drafts/results/${operationId}.json` }
}

function finalizeHtml(receipt: PreviewReceipt, results: PreparedDraft['results'], expectedHash: string, bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_DRAFT_HTML_BYTES || sha256(bytes) !== expectedHash) throw new Error('preview HTML changed')
  const html = htmlDecoder.decode(bytes)
  const tags = [...html.matchAll(/<img\b[^>]*>/giu)]
  const sources = tags.map(match => {
    const attributes = match[0].match(/\bsrc=(?:"([^"]*)"|'([^']*)')/iu)
    if (attributes === null) throw new Error('preview HTML contains an image without one quoted src')
    return attributes[1] ?? attributes[2]!
  })
  if (sources.length !== receipt.assets.length) throw new Error('preview HTML image inventory does not match the signed assets')
  for (const [index, asset] of receipt.assets.entries()) {
    const expected = new Set([asset.source, escapeGoHtml(asset.source)])
    if (!expected.has(sources[index]!)) throw new Error('preview HTML image order does not match the signed assets')
  }
  const byTarget = new Map<string, PreparedDraft['results'][number][]>()
  for (const entry of results) { const list = byTarget.get(entry.result.targetPath) ?? []; list.push(entry); byTarget.set(entry.result.targetPath, list) }
  const consumed = new Set<string>(); const seenSources = new Set<string>()
  let finalized: Uint8Array<ArrayBufferLike> = new Uint8Array(bytes)
  for (const asset of receipt.assets) {
    if (asset.kind === 'ai') throw new Error('AI marker asset is unresolved')
    if (asset.kind === 'online') { validateWechatMaterialUrl(asset.source); continue }
    if (seenSources.has(asset.source)) throw new Error('duplicate local asset source is ambiguous'); seenSources.add(asset.source)
    const matches = byTarget.get(asset.path) ?? []
    if (matches.length !== 1 || matches[0]!.result.sha256 !== asset.sha256) throw new Error('local asset does not match one verified image result')
    const matched = matches[0]!; const item = matched.plan.items.find(candidate => candidate.id === matched.result.itemId)
    if (item?.kind === 'cover') throw new Error('cover result cannot be consumed as a body image')
    const result = matched.result; consumed.add(`${result.planId}\0${result.itemId}`)
    finalized = replaceExactImageSourceBytes(finalized, asset.source, validateWechatMaterialUrl(result.wechatUrl))
  }
  for (const entry of results) {
    const item = entry.plan.items.find(candidate => candidate.id === entry.result.itemId)!
    if (item.kind !== 'cover' && !consumed.has(`${entry.result.planId}\0${entry.result.itemId}`)) throw new Error('image result is not represented by one signed local asset')
  }
  return finalized
}

function replaceExactImageSourceBytes(html: Uint8Array, source: string, replacement: string): Uint8Array {
  const encoder = new TextEncoder()
  const escaped = escapeGoHtml(source); const candidates = [...new Set([source, escaped])].flatMap(value => [[encoder.encode(`src="${value}"`), encoder.encode(`src="${replacement}"`)], [encoder.encode(`src='${value}'`), encoder.encode(`src='${replacement}'`)]] as const)
  const counts = candidates.map(([needle]) => countByteOccurrences(html, needle)); const total = counts.reduce((sum, count) => sum + count, 0)
  if (total !== 1) throw new Error(total === 0 ? 'signed local asset is missing from preview HTML' : 'signed local asset appears ambiguously in preview HTML')
  for (const [index, pair] of candidates.entries()) if (counts[index] === 1) return replaceOneByteSequence(html, pair[0], pair[1])
  throw new Error('signed local asset could not be replaced')
}
function escapeGoHtml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll("'", '&#39;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&#34;') }
function countByteOccurrences(haystack: Uint8Array, needle: Uint8Array): number { let count = 0; for (let offset = 0; offset <= haystack.length - needle.length;) { const found = indexOfBytes(haystack, needle, offset); if (found < 0) break; count += 1; offset = found + needle.length } return count }
function replaceOneByteSequence(haystack: Uint8Array, needle: Uint8Array, replacement: Uint8Array): Uint8Array { const offset = indexOfBytes(haystack, needle, 0); if (offset < 0) throw new Error('replacement source disappeared'); const result = new Uint8Array(haystack.length - needle.length + replacement.length); result.set(haystack.subarray(0, offset)); result.set(replacement, offset); result.set(haystack.subarray(offset + needle.length), offset + replacement.length); return result }
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, start: number): number { outer: for (let index = start; index <= haystack.length - needle.length; index += 1) { for (let byte = 0; byte < needle.length; byte += 1) if (haystack[index + byte] !== needle[byte]) continue outer; return index } return -1 }
function validateWechatMaterialUrl(value: string): string { let url: URL; try { url = new URL(value) } catch { throw new Error('asset URL is invalid') }; if (url.protocol !== 'https:' || url.hostname !== 'mmbiz.qpic.cn' || url.port !== '' || url.username !== '' || url.password !== '' || url.hash !== '' || url.href !== value) throw new Error('asset URL must be canonical WeChat material HTTPS'); return value }

function projectDraftResponse(response: CliEnvelope): { draftId: string; draftUrl?: string } {
  if (!response.success || response.code !== 'OK' || response.message !== 'Success' || response.schema_version !== 'v1' || response.status !== 'completed' || response.retryable !== false || response.error !== undefined || response.error_details !== undefined || response.next_actions !== undefined) throw new Error('md2wechat draft response is not a strict success')
  const data = record(response.data); const keys = Object.keys(data).sort(); if (keys.join(',') !== 'media_id' && keys.join(',') !== 'draft_url,media_id') throw new Error('draft response data fields are invalid')
  const draftId = safeOpaque(data.media_id, 'draft ID'); const draftUrl = data.draft_url === undefined ? undefined : canonicalHttps(data.draft_url)
  return { draftId, ...(draftUrl === undefined ? {} : { draftUrl }) }
}

async function replayCompleted(store: ArtifactStore, prepared: PreparedDraft, digest: string, signal: AbortSignal) {
  let bytes: Uint8Array; try { bytes = await store.readBounded(prepared.resultPath, 1024 * 1024, signal) } catch { throw new SafeDraftError('completed draft record is missing or corrupt') }
  if (sha256(bytes) !== digest) throw new SafeDraftError('completed draft record is missing or corrupt')
  let value: Record<string, unknown>; try { value = record(JSON.parse(decoder.decode(bytes))) } catch { throw new SafeDraftError('completed draft record is missing or corrupt') }
  if (!Buffer.from(bytes).equals(Buffer.from(encodeCanonical(value)))) throw new SafeDraftError('completed draft record is missing or corrupt')
  const required = ['schemaVersion', 'operationId', 'revisionId', 'previewReceiptId', 'requestPath', 'requestSha256', 'draftId', 'pluginVersion', 'cliVersion', 'createdAt']; const optional = ['draftUrl']
  if (Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !(key in value))) throw new SafeDraftError('completed draft record is missing or corrupt')
  if (value.schemaVersion !== 1 || value.operationId !== prepared.operationId || value.revisionId !== prepared.prepared.current.revision.id || value.previewReceiptId !== prepared.receipt.id || value.requestPath !== prepared.requestPath || value.requestSha256 !== sha256(prepared.request) || value.pluginVersion !== PLUGIN_VERSION || value.cliVersion !== SUPPORTED_CLI_VERSION) throw new SafeDraftError('completed draft record is missing or corrupt')
  if (typeof value.createdAt !== 'string') throw new SafeDraftError('completed draft record is missing or corrupt')
  const createdAt = new Date(value.createdAt)
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== value.createdAt) throw new SafeDraftError('completed draft record is missing or corrupt')
  const draftId = safeOpaque(value.draftId, 'draft ID'); const draftUrl = value.draftUrl === undefined ? undefined : canonicalHttps(value.draftUrl)
  return draftOutput(prepared, draftId, draftUrl)
}

function draftOutput(prepared: PreparedDraft, draftId: string, draftUrl?: string) { return domainResult({ manifestPath: prepared.prepared.current.manifestPath, revisionId: prepared.prepared.current.revision.id, previewReceiptId: prepared.receipt.id, draftId, ...(draftUrl === undefined ? {} : { draftUrl }), draftResultPath: prepared.resultPath }) }
class SafeDraftError extends Error {}
class DraftCancelledError extends Error {}
function assertApproved(value: ApprovalOutcome): void { if (value === 'allowed-once') return; if (value === 'cancelled') throw new DraftCancelledError(); throw new SafeDraftError(`WeChat draft approval ${value}`) }
function assertExactArgs(value: object, keys: readonly string[]): void { const expected = new Set(keys); if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !expected.has(key))) throw new SafeDraftError('WeChat draft contains unknown or missing arguments') }
function validatePlanPaths(value: readonly string[]): readonly string[] { if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLAN_PATHS || value.some(path => typeof path !== 'string' || path.length < 1 || path.length > 1200) || new Set(value).size !== value.length) throw new SafeDraftError('WeChat draft requires unique bounded non-empty plan paths'); return [...value].sort() }
function record(value: unknown): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('value must be an object'); return value as Record<string, unknown> }
function safeOpaque(value: unknown, field: string): string { if (typeof value !== 'string' || value.trim() === '' || new TextEncoder().encode(value).byteLength > 512 || [...value].some(character => character.codePointAt(0)! <= 0x1f || character.codePointAt(0) === 0x7f)) throw new Error(`${field} is invalid`); return value }
function canonicalHttps(value: unknown): string { if (typeof value !== 'string') throw new Error('draft URL is invalid'); let url: URL; try { url = new URL(value) } catch { throw new Error('draft URL is invalid') }; if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '' || url.href !== value || value.length > 4096) throw new Error('draft URL is invalid'); return value }
function validNow(now: (() => Date) | undefined): Date { const value = (now ?? (() => new Date()))(); if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('draft clock is invalid'); return value }
function sha256(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function sha256Text(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function safeLocations(manifestPath: string, planPaths: readonly string[]): readonly string[] { return [manifestPath, ...(Array.isArray(planPaths) ? planPaths : [])].filter(value => typeof value === 'string' && /^revisions\/[a-f0-9]{64}\/(?:manifest\.json|plans\/[a-f0-9]{64}\.json)$/u.test(value)) }
