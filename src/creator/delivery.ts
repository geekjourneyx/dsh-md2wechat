import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CliEnvelope } from '../cli/protocol.ts'
import { probeCliVersion } from '../cli/gateway.ts'
import type { CliGateway } from '../cli/gateway.ts'
import { resolveOperationEnv } from '../security/credentials.ts'
import type { OperationCredentialServices, ResolvedOperationEnv } from '../security/credentials.ts'
import type { ArtifactReadAuthorization, ArtifactStore } from '../workspace/artifact-store.ts'
import type { DraftStateStore } from '../workspace/draft.ts'
import { encodeCanonical, validateImageBytes } from '../workspace/images.ts'
import type { SupportedImageMime } from '../workspace/images.ts'
import { preflightCurrentPreview, validateCurrentPreview } from '../workspace/preview.ts'
import type { PreviewReceipt } from '../workspace/preview.ts'
import { preparePreviewInputs, previewSnapshotInputFor } from '../tools/preview.ts'
import { verifyImageCandidate } from './image-choices.ts'
import type { ImageCandidate } from './image-choices.ts'
import type { CreatorRevision } from './session.ts'
import type { CreatorPreviewAsset } from './types.ts'

const MAX_BYTES = 8 * 1024 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
type Execution = Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>

export interface CreatorDeliveryDependencies extends OperationCredentialServices {
  store: ArtifactStore
  gateway: CliGateway
  state: DraftStateStore
  approval: Pick<Context['approval'], 'request'>
  layoutBaseUrl: string
  previewFontSize: 'small' | 'medium' | 'large'
  previewBackgroundType: 'default' | 'grid' | 'none'
  now?: () => Date
}

/** Display projection only. Authority is held by the creating adapter, never reconstructed from this object. */
export interface CreatorLocalProof {
  readonly id: string
  readonly revisionId: string
  readonly theme: string
  readonly path: string
  readonly sha256: string
  readonly assets: readonly CreatorPreviewAsset[]
  readonly expiresAt: string
}

export interface CreatorDeliveryProof extends CreatorLocalProof {
  readonly coverId: string
}

export interface CreatorLocalCurrent {
  proof: CreatorLocalProof
  revision: CreatorRevision
  theme: string
}

export interface CreatorDeliveryCurrent {
  proof: CreatorDeliveryProof
  revision: CreatorRevision
  theme: string
  coverId: string
}

export class CreatorDeliveryUnknownError extends Error {
  readonly outcomeUnknown = true
}

interface Asset {
  path: string
  sha256: string
  byteSize: number
  contentType: SupportedImageMime
  authorization: ArtifactReadAuthorization
}
interface UploadRecord {
  schemaVersion: 1
  operationId: string
  accountDigest: string
  sha256: string
  byteSize: number
  contentType: SupportedImageMime
  mediaId: string
  wechatUrl: string
}
interface Upload { record: UploadRecord; path: string; digest: string }
interface Prepared {
  proof: CreatorDeliveryProof
  revision: CreatorRevision
  contentId: string
  receipt: PreviewReceipt
  accountDigest: string
  cover: ImageCandidate
  uploads: readonly Upload[]
  coverUpload: Upload
  finalPath: string
}
interface PreparedLocal {
  proof: CreatorLocalProof
  revision: CreatorRevision
  contentId: string
  receipt: PreviewReceipt
  finalPath: string
}

/** One session-scoped adapter. Upload authority comes only from its own verified CLI completions. */
export function createCreatorDelivery(deps: CreatorDeliveryDependencies) {
  const proofs = new WeakMap<CreatorDeliveryProof, Prepared>()
  const localProofs = new WeakMap<CreatorLocalProof, PreparedLocal>()
  const clock = () => { const now = (deps.now ?? (() => new Date()))(); if (!Number.isFinite(now.getTime())) throw new Error('交付时间无效。'); return now }

  async function inputs(revision: CreatorRevision, receiptId: string, signal: AbortSignal, local = false) {
    signal.throwIfAborted()
    const prepared = await preparePreviewInputs(deps.store, revision.manifestPath, signal)
    if (prepared.current.revision.id !== revision.id || !Buffer.from(prepared.current.articleBytes).equals(Buffer.from(revision.markdown, 'utf8'))) throw new Error('文章已经变化，请重新准备交付。')
    if (prepared.current.articleBytes.byteLength > MAX_BYTES || prepared.localImages.length > 128) throw new Error('文章或图片数量超过交付限制。')
    const preview = await preflightCurrentPreview(deps.store, revision.id, receiptId, clock(), signal)
    const html = await deps.store.readBounded(preview.htmlPath, MAX_BYTES, signal)
    if (sha256(html) !== preview.receipt.previewHtmlSha256) throw new Error('预览内容已经变化。')
    for (const asset of preview.receipt.assets) {
      if (asset.kind === 'ai') throw new Error('仍有未完成的正文图片，请先完成配图。')
      if (asset.kind === 'online') {
        try { wechatUrl(asset.source) }
        catch (error) {
          if (local) throw new Error('该远程图片无法在安全预览中显示，请先导入本地图片，再重新生成预览。')
          throw error
        }
      }
    }
    return { prepared, receipt: preview.receipt, html }
  }

  async function credentials(): Promise<ResolvedOperationEnv> {
    for (const name of ['MD2WECHAT_API_KEY', 'WECHAT_APPID', 'WECHAT_SECRET']) if (!deps.credentialRefs[name]) throw new Error('请先配置排版与公众号凭据。')
    try {
      const resolved = await resolveOperationEnv(['MD2WECHAT_API_KEY', 'WECHAT_APPID', 'WECHAT_SECRET'], deps)
      for (const name of ['MD2WECHAT_API_KEY', 'WECHAT_APPID', 'WECHAT_SECRET']) if (!resolved.env[name]) throw new Error('missing')
      return resolved
    } catch { throw new Error('无法读取交付所需凭据，请检查配置。') }
  }

  async function previewCredentials(): Promise<ResolvedOperationEnv> {
    if (!deps.credentialRefs.MD2WECHAT_API_KEY) throw new Error('请先配置排版凭据。')
    try {
      const resolved = await resolveOperationEnv(['MD2WECHAT_API_KEY'], deps)
      if (!resolved.env.MD2WECHAT_API_KEY) throw new Error('missing')
      return resolved
    } catch { throw new Error('无法读取排版凭据，请检查配置。') }
  }

  async function verifyPreview(current: Awaited<ReturnType<typeof inputs>>, theme: string, resolved: ResolvedOperationEnv, signal: AbortSignal): Promise<void> {
    const verified = await validateCurrentPreview(deps.store, {
      snapshotInput: previewSnapshotInputFor(current.prepared, deps.layoutBaseUrl, deps.credentialRefs.MD2WECHAT_API_KEY!, resolved.env.MD2WECHAT_API_KEY!, theme, deps.previewFontSize, deps.previewBackgroundType, await probeCliVersion(deps.gateway, signal)),
      credentialValue: resolved.env.MD2WECHAT_API_KEY!, now: clock(), signal,
    })
    if (verified.receipt.id !== current.receipt.id || sha256(verified.htmlBytes) !== sha256(current.html)) throw new Error('预览已经变化，请重新审阅。')
  }

  async function approve(exec: Execution, toolName: string, reason: string): Promise<void> {
    exec.signal.throwIfAborted()
    if (!exec.agent) throw new Error('交付需要当前文章的有效会话。')
    const outcome = await deps.approval.request({ agent: exec.agent, callId: exec.callId, toolName, reason, signal: exec.signal })
    if (outcome !== 'allowed-once') throw new Error('交付未获授权，未执行上传或提交。')
    exec.signal.throwIfAborted()
  }

  async function asset(path: string, contentType: SupportedImageMime, expectedHash: string, expectedSize: number, signal: AbortSignal): Promise<Asset> {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_BYTES) throw new Error('图片超过 8-MiB 限制。')
    const bytes = await deps.store.readBounded(path, MAX_BYTES, signal)
    if (bytes.byteLength !== expectedSize || sha256(bytes) !== expectedHash) throw new Error('图片内容已经变化。')
    validateImageBytes(contentType, bytes)
    return { path, sha256: expectedHash, byteSize: expectedSize, contentType, authorization: await deps.store.authorizeRead(path, expectedHash, signal) }
  }

  async function verifyUpload(upload: Upload, signal: AbortSignal): Promise<void> {
    const authority = await deps.state.inspect(deps.store, upload.record.operationId, signal)
    if (authority.status !== 'completed' || authority.resultDigest !== upload.digest) throw new Error('素材上传凭据无效。')
    const bytes = await deps.store.readBounded(upload.path, 1024 * 1024, signal)
    if (sha256(bytes) !== upload.digest || sha256(encodeCanonical(upload.record)) !== upload.digest) throw new Error('素材上传记录已经变化。')
  }

  async function uploadOne(image: Asset, resolved: ResolvedOperationEnv, signal: AbortSignal): Promise<Upload> {
    const accountDigest = account(resolved)
    const workspace = await deps.store.canonicalIdentity('revisions', signal)
    const operationId = sha256(encodeCanonical({ scope: 'creator-local-upload/v1', workspace, accountDigest, sha256: image.sha256, contentType: image.contentType, byteSize: image.byteSize }))
    const path = `delivery/uploads/${operationId}.json`
    const runtime = await deps.state.prepareRuntime(deps.store, operationId, signal)
    const authority = await deps.state.inspect(deps.store, operationId, signal)
    if (authority.status === 'started') throw new CreatorDeliveryUnknownError('素材上传结果未知，禁止自动重复上传，请先在公众号后台核对。')
    if (authority.status === 'completed') {
      const bytes = await deps.store.readBounded(path, 1024 * 1024, signal)
      if (sha256(bytes) !== authority.resultDigest) throw new Error('素材上传记录已经变化。')
      const record = JSON.parse(decoder.decode(bytes)) as UploadRecord
      if (record.operationId !== operationId || record.accountDigest !== accountDigest || record.sha256 !== image.sha256 || record.byteSize !== image.byteSize || record.contentType !== image.contentType) throw new Error('素材上传记录不匹配。')
      opaque(record.mediaId); wechatUrl(record.wechatUrl)
      await image.authorization.beforeSpawn(signal)
      return { record, path, digest: authority.resultDigest }
    }
    await image.authorization.beforeSpawn(signal)
    await deps.state.start(deps.store, operationId, signal)
    try {
      const response = await deps.gateway.run(['upload_image', image.authorization.processPath, '--json'], {
        cwd: runtime, signal, secrets: resolved.secrets, env: isolatedEnv(resolved, runtime),
        beforeSpawn: async spawnSignal => { await image.authorization.beforeSpawn(spawnSignal); await deps.state.validateEmptyRuntime(runtime, spawnSignal) },
      })
      const uploaded = projectUpload(response)
      const record: UploadRecord = { schemaVersion: 1, operationId, accountDigest, sha256: image.sha256, byteSize: image.byteSize, contentType: image.contentType, ...uploaded }
      const bytes = encodeCanonical(record); const digest = sha256(bytes)
      await publish(deps.store, path, bytes, signal)
      await deps.state.complete(deps.store, operationId, digest, signal)
      return { record, path, digest }
    } catch { throw new CreatorDeliveryUnknownError('素材上传结果未知，禁止自动重复上传，请先在公众号后台核对。') }
  }

  async function currentProof(args: CreatorDeliveryCurrent, signal: AbortSignal) {
    signal.throwIfAborted()
    const saved = proofs.get(args.proof)
    if (!saved || args.revision.id !== saved.revision.id || args.revision.manifestPath !== saved.revision.manifestPath
      || args.revision.markdown !== saved.revision.markdown || args.theme !== saved.proof.theme || args.coverId !== saved.cover.id) throw new Error('交付版本或封面已经变化，请重新准备并审阅。')
    if (clock().getTime() >= Date.parse(saved.proof.expiresAt)) throw new Error('最终预览已过期，请重新准备并审阅。')
    const current = await inputs(args.revision, saved.receipt.id, signal)
    if (current.prepared.contentId !== saved.contentId) throw new Error('正文图片已经变化，请重新准备交付。')
    await verifyImageCandidate(deps.store, args.revision.id, saved.cover, signal)
    for (const uploaded of saved.uploads) await verifyUpload(uploaded, signal)
    const bytes = await deps.store.readBounded(saved.finalPath, MAX_BYTES, signal)
    if (sha256(bytes) !== saved.proof.sha256) throw new Error('最终 HTML 已经变化，请重新准备交付。')
    return { saved, current, bytes }
  }

  async function authenticate(args: CreatorDeliveryCurrent, signal: AbortSignal, resolved: ResolvedOperationEnv) {
    const current = await currentProof(args, signal)
    if (account(resolved) !== current.saved.accountDigest) throw new Error('公众号账户已经变化，请重新准备交付。')
    await verifyPreview(current.current, args.theme, resolved, signal)
    return current
  }

  async function currentLocalProof(args: CreatorLocalCurrent, signal: AbortSignal) {
    signal.throwIfAborted()
    const saved = localProofs.get(args.proof)
    if (!saved || args.revision.id !== saved.revision.id || args.revision.manifestPath !== saved.revision.manifestPath
      || args.revision.markdown !== saved.revision.markdown || args.theme !== saved.proof.theme) throw new Error('本地预览版本已经变化，请重新生成并审阅。')
    if (clock().getTime() >= Date.parse(saved.proof.expiresAt)) throw new Error('本地预览已过期，请重新生成并审阅。')
    const current = await inputs(args.revision, saved.receipt.id, signal, true)
    if (current.prepared.contentId !== saved.contentId) throw new Error('正文图片已经变化，请重新生成本地预览。')
    const bytes = await deps.store.readBounded(saved.finalPath, MAX_BYTES, signal)
    if (sha256(bytes) !== saved.proof.sha256) throw new Error('本地 HTML 已经变化，请重新生成预览。')
    return { saved, current, bytes }
  }

  return {
    async prepareLocal(args: { revision: CreatorRevision; theme: string; previewReceiptId: string }, exec: Execution): Promise<CreatorLocalProof> {
      const current = await inputs(args.revision, args.previewReceiptId, exec.signal, true)
      const resolved = await previewCredentials()
      await verifyPreview(current, args.theme, resolved, exec.signal)
      const sources = new Map<string, string>()
      for (const image of current.prepared.localImages) {
        const verified = await asset(image.path, mime(image.path), sha256(image.bytes), image.bytes.byteLength, exec.signal)
        await verified.authorization.beforeSpawn(exec.signal)
        sources.set(image.path, `data:${verified.contentType};base64,${Buffer.from(image.bytes).toString('base64')}`)
      }
      const finalBytes = finalize(current.html, current.receipt, sources, 'local')
      const finalSha = sha256(finalBytes)
      const latest = await inputs(args.revision, args.previewReceiptId, exec.signal, true)
      if (latest.prepared.contentId !== current.prepared.contentId) throw new Error('正文已经变化，请重新生成本地预览。')
      await verifyPreview(latest, args.theme, resolved, exec.signal)
      for (const image of latest.prepared.localImages) await image.authorization.beforeSpawn(exec.signal)
      const id = sha256(encodeCanonical({ scope: 'creator-local-html/v1', revisionId: args.revision.id, contentId: current.prepared.contentId, theme: args.theme, receiptId: current.receipt.id, finalSha }))
      const finalPath = `revisions/${args.revision.id}/delivery/${id}/portable.html`
      await publish(deps.store, finalPath, finalBytes, exec.signal)
      // Local images are already embedded in the exact reviewed bytes, so display needs no substitution.
      const proof: CreatorLocalProof = Object.freeze({ id, revisionId: args.revision.id, theme: args.theme, path: `${deps.store.rootRelative}/${finalPath}`, sha256: finalSha, assets: Object.freeze([]), expiresAt: current.receipt.expiresAt })
      localProofs.set(proof, { proof, revision: { ...args.revision }, contentId: current.prepared.contentId, receipt: current.receipt, finalPath })
      return proof
    },

    async exportLocal(args: CreatorLocalCurrent & { destinationPath: string }, exec: Execution): Promise<{ path: string; sha256: string }> {
      if (!isAbsolute(args.destinationPath) || args.destinationPath.length > 4096 || containsControl(args.destinationPath)) throw new Error('请输入有效的绝对导出路径。')
      const before = await currentLocalProof(args, exec.signal)
      const copy = await deps.store.authorizeCopyOut(before.saved.finalPath, args.proof.sha256, args.destinationPath, exec.signal)
      await approve(exec, 'md2wechat_export', `Write the exact reviewed portable HTML, including its embedded local images, to ${args.destinationPath}. Existing content at this destination may be replaced.`)
      const resolved = await previewCredentials()
      const verified = await currentLocalProof(args, exec.signal)
      await verifyPreview(verified.current, args.theme, resolved, exec.signal)
      for (const image of verified.current.prepared.localImages) await image.authorization.beforeSpawn(exec.signal)
      await copy.commitVerified(verified.bytes, exec.signal)
      return { path: args.destinationPath, sha256: args.proof.sha256 }
    },

    async prepare(args: { revision: CreatorRevision; theme: string; previewReceiptId: string; cover: ImageCandidate }, exec: Execution): Promise<CreatorDeliveryProof> {
      const before = await inputs(args.revision, args.previewReceiptId, exec.signal)
      const cover = await verifyImageCandidate(deps.store, args.revision.id, args.cover, exec.signal)
      if (cover.kind !== 'cover') throw new Error('请选择一张封面。')
      // Validate exact source inventory before any upload or credential request.
      finalize(before.html, before.receipt, new Map(before.receipt.assets.filter(asset => asset.kind === 'local').map(asset => [asset.path, 'https://mmbiz.qpic.cn/validation'])))
      await approve(exec, 'md2wechat_prepare_delivery', `Upload the selected cover and ${before.prepared.localImages.length} current body image(s) to the configured WeChat material library, then prepare the final HTML for review. Unselected candidates are not uploaded. The CLI may internally retry each upload up to 3 times; uncertain outcomes will not be automatically reissued.`)
      const resolved = await credentials()
      const current = await inputs(args.revision, args.previewReceiptId, exec.signal)
      if (current.prepared.contentId !== before.prepared.contentId) throw new Error('正文已经变化，请重新准备交付。')
      await verifyPreview(current, args.theme, resolved, exec.signal)
      await verifyImageCandidate(deps.store, args.revision.id, cover, exec.signal)
      const coverAsset = await asset(cover.path, cover.contentType, cover.sha256, cover.byteSize, exec.signal)
      const body = await Promise.all(current.prepared.localImages.map(image => asset(image.path, mime(image.path), sha256(image.bytes), image.bytes.byteLength, exec.signal)))
      const assets = [coverAsset, ...body]
      for (const image of assets) await image.authorization.beforeSpawn(exec.signal)
      const uploaded = new Map<string, Upload>()
      for (const image of assets) uploaded.set(image.path, await uploadOne(image, resolved, exec.signal))
      for (const image of assets) await image.authorization.beforeSpawn(exec.signal)
      const latest = await inputs(args.revision, args.previewReceiptId, exec.signal)
      if (latest.prepared.contentId !== current.prepared.contentId) throw new Error('正文已经变化，请重新准备交付。')
      await verifyPreview(latest, args.theme, resolved, exec.signal)
      const finalBytes = finalize(latest.html, latest.receipt, new Map(body.map(image => [image.path, uploaded.get(image.path)!.record.wechatUrl])))
      const finalSha = sha256(finalBytes)
      const uploads = [...new Map([...uploaded.values()].map(value => [value.record.operationId, value])).values()]
      const accountDigest = account(resolved)
      const id = sha256(encodeCanonical({ scope: 'creator-final-html/v1', revisionId: args.revision.id, contentId: current.prepared.contentId, theme: args.theme, receiptId: latest.receipt.id, coverId: cover.id, coverSha256: cover.sha256, accountDigest, uploads: uploads.map(upload => upload.digest), finalSha }))
      const finalPath = `revisions/${args.revision.id}/delivery/${id}/final.html`
      await publish(deps.store, finalPath, finalBytes, exec.signal)
      const previewAssets = latest.prepared.localImages.map(image => Object.freeze({ source: uploaded.get(image.path)!.record.wechatUrl, path: `${deps.store.rootRelative}/${image.path}`, sha256: sha256(image.bytes), contentType: mime(image.path) }))
      const proof: CreatorDeliveryProof = Object.freeze({ id, revisionId: args.revision.id, theme: args.theme, path: `${deps.store.rootRelative}/${finalPath}`, sha256: finalSha, assets: Object.freeze(previewAssets), coverId: cover.id, expiresAt: latest.receipt.expiresAt })
      proofs.set(proof, { proof, revision: { ...args.revision }, contentId: current.prepared.contentId, receipt: latest.receipt, accountDigest, cover: { ...cover }, uploads, coverUpload: uploaded.get(cover.path)!, finalPath })
      return proof
    },

    async exportFinal(args: CreatorDeliveryCurrent & { destinationPath: string }, exec: Execution): Promise<{ path: string; sha256: string }> {
      if (!isAbsolute(args.destinationPath) || args.destinationPath.length > 4096 || containsControl(args.destinationPath)) throw new Error('请输入有效的绝对导出路径。')
      const before = await currentProof(args, exec.signal)
      const copy = await deps.store.authorizeCopyOut(before.saved.finalPath, args.proof.sha256, args.destinationPath, exec.signal)
      await approve(exec, 'md2wechat_export', `Write the exact reviewed final HTML locally to ${args.destinationPath}. Existing content at this destination may be replaced.`)
      const verified = await authenticate(args, exec.signal, await credentials())
      await copy.commitVerified(verified.bytes, exec.signal)
      return { path: args.destinationPath, sha256: args.proof.sha256 }
    },

    async createDraftFinal(args: CreatorDeliveryCurrent, exec: Execution): Promise<{ draftId: string; draftUrl?: string; path: string }> {
      const before = await currentProof(args, exec.signal)
      const saved = before.saved
      const operationId = sha256(encodeCanonical({ scope: 'creator-final-draft/v1', workspace: await deps.store.canonicalIdentity('revisions', exec.signal), deliveryId: saved.proof.id, accountDigest: saved.accountDigest }))
      const resultPath = `revisions/${args.revision.id}/delivery/${args.proof.id}/draft-${operationId}.json`
      const runtime = await deps.state.prepareRuntime(deps.store, operationId, exec.signal)
      const authority = await deps.state.inspect(deps.store, operationId, exec.signal)
      if (authority.status === 'started') throw new CreatorDeliveryUnknownError('草稿提交结果未知，禁止自动重复创建，请先在公众号后台核对。')
      if (authority.status === 'completed') {
        await authenticate(args, exec.signal, await credentials())
        const bytes = await deps.store.readBounded(resultPath, 1024 * 1024, exec.signal)
        if (sha256(bytes) !== authority.resultDigest) throw new Error('草稿结果记录已经变化。')
        const result = JSON.parse(decoder.decode(bytes)) as { operationId: string; draftId: string; draftUrl?: string }
        if (result.operationId !== operationId) throw new Error('草稿结果不匹配。')
        return { draftId: opaque(result.draftId), ...(result.draftUrl ? { draftUrl: canonicalHttps(result.draftUrl) } : {}), path: `${deps.store.rootRelative}/${resultPath}` }
      }
      await approve(exec, 'md2wechat_create_draft', `Create one unpublished WeChat draft titled ${saved.receipt.metadata.title} with the selected cover and exact final HTML already shown for review. This does not publish or mass-send.`)
      const resolved = await credentials()
      const verified = await authenticate(args, exec.signal, resolved)
      const article: Record<string, unknown> = { title: saved.receipt.metadata.title, content: decoder.decode(verified.bytes), thumb_media_id: saved.coverUpload.record.mediaId, show_cover_pic: 1 }
      if (saved.receipt.metadata.author) article.author = saved.receipt.metadata.author
      if (saved.receipt.metadata.digest) article.digest = saved.receipt.metadata.digest
      const request = encodeCanonical({ articles: [article] })
      if (request.byteLength > 9 * 1024 * 1024) throw new Error('草稿请求超过安全大小限制。')
      const requestPath = `revisions/${args.revision.id}/delivery/${args.proof.id}/request-${operationId}.json`
      await publish(deps.store, requestPath, request, exec.signal)
      const authorization = await deps.store.authorizeRead(requestPath, sha256(request), exec.signal)
      await deps.state.start(deps.store, operationId, exec.signal)
      try {
        const response = await deps.gateway.run(['create_draft', authorization.processPath, '--json'], {
          cwd: runtime, signal: exec.signal, env: isolatedEnv(resolved, runtime), secrets: resolved.secrets,
          beforeSpawn: async spawnSignal => { await authenticate(args, spawnSignal, resolved); await authorization.beforeSpawn(spawnSignal); await deps.state.validateEmptyRuntime(runtime, spawnSignal) },
        })
        const result = projectDraft(response)
        const resultBytes = encodeCanonical({ schemaVersion: 1, operationId, deliveryId: args.proof.id, accountDigest: saved.accountDigest, requestSha256: sha256(request), ...result })
        await publish(deps.store, resultPath, resultBytes, exec.signal)
        await deps.state.complete(deps.store, operationId, sha256(resultBytes), exec.signal)
        return { ...result, path: `${deps.store.rootRelative}/${resultPath}` }
      } catch { throw new CreatorDeliveryUnknownError('草稿提交结果未知，禁止自动重复创建，请先在公众号后台核对。') }
    },
  }
}

function isolatedEnv(resolved: ResolvedOperationEnv, runtime: string): Record<string, string> {
  return { ...resolved.env, COMPRESS_IMAGES: 'false', WECHAT_ACCOUNT: '', WECHAT_PROXY_URL: '', IMAGE_API_KEY: '', HOME: runtime, USERPROFILE: runtime, XDG_CONFIG_HOME: runtime, APPDATA: runtime, LOCALAPPDATA: runtime }
}
function account(resolved: ResolvedOperationEnv): string { return sha256(`creator-wechat-account/v1\0${resolved.env.WECHAT_APPID}`) }
function mime(path: string): SupportedImageMime {
  const extension = path.split('.').at(-1)?.toLowerCase()
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'webp') return 'image/webp'
  throw new Error('正文图片必须是 PNG、JPEG、GIF 或 WebP。')
}
function responseData(response: CliEnvelope): Record<string, unknown> {
  if (!response.success || response.code !== 'OK' || response.message !== 'Success' || response.schema_version !== 'v1' || response.status !== 'completed' || response.retryable !== false || response.error !== undefined || response.error_details !== undefined || response.next_actions !== undefined) throw new Error('CLI did not return strict success')
  if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) throw new Error('CLI data is invalid')
  return response.data as Record<string, unknown>
}
function projectUpload(response: CliEnvelope): Pick<UploadRecord, 'mediaId' | 'wechatUrl'> {
  const data = responseData(response)
  if (Object.keys(data).sort().join(',') !== 'height,media_id,wechat_url,width') throw new Error('upload response fields are invalid')
  for (const field of ['width', 'height']) if (!Number.isSafeInteger(data[field]) || Number(data[field]) < 0 || Number(data[field]) > 1_000_000) throw new Error('upload dimensions are invalid')
  return { mediaId: opaque(data.media_id), wechatUrl: wechatUrl(data.wechat_url) }
}
function projectDraft(response: CliEnvelope): { draftId: string; draftUrl?: string } {
  const data = responseData(response); const keys = Object.keys(data).sort().join(',')
  if (keys !== 'media_id' && keys !== 'draft_url,media_id') throw new Error('draft response fields are invalid')
  return { draftId: opaque(data.media_id), ...(data.draft_url === undefined ? {} : { draftUrl: canonicalHttps(data.draft_url) }) }
}
function opaque(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 512 || containsControl(value)) throw new Error('invalid opaque identifier'); return value }
function canonicalHttps(value: unknown): string { if (typeof value !== 'string' || value.length > 4096) throw new Error('invalid HTTPS URL'); const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.href !== value) throw new Error('invalid HTTPS URL'); return value }
function wechatUrl(value: unknown): string { const url = canonicalHttps(value); if (new URL(url).hostname !== 'mmbiz.qpic.cn') throw new Error('正文图片需要规范的微信素材地址。'); return url }
function containsControl(value: string): boolean { return [...value].some(character => character.codePointAt(0)! <= 0x1f || character.codePointAt(0) === 0x7f) }
function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
async function publish(store: ArtifactStore, path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  try { await store.createExclusive(path, bytes, signal) }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ARTIFACT_EXISTS')) throw error; if (sha256(await store.read(path, signal)) !== sha256(bytes)) throw new Error('immutable delivery artifact changed') }
}
function escapeHtml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll("'", '&#39;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&#34;') }

/** Replace only the verified quoted src value of each inventoried img, preserving every other UTF-8 byte. */
function finalize(bytes: Uint8Array, receipt: PreviewReceipt, uploaded: ReadonlyMap<string, string>, mode: 'wechat' | 'local' = 'wechat'): Uint8Array {
  const html = decoder.decode(bytes)
  const tags = [...html.matchAll(/<img\b[^>]*>/giu)]
  if (tags.length !== receipt.assets.length) throw new Error('预览图片清单不匹配。')
  const replacements: Array<{ start: number; end: number; value: string }> = []
  const locals = new Set<string>()
  for (const [index, tag] of tags.entries()) {
    const attributes = [...tag[0].matchAll(/(?:^|\s)src=(?:"([^"]*)"|'([^']*)')/giu)]
    if (attributes.length !== 1 || /\ssrcset\s*=/iu.test(tag[0])) throw new Error('预览图片地址有歧义。')
    const attribute = attributes[0]!; const source = attribute[1] ?? attribute[2]!
    const asset = receipt.assets[index]!
    if (source !== asset.source && source !== escapeHtml(asset.source)) throw new Error('预览图片顺序不匹配。')
    if (asset.kind === 'online') { if (mode === 'wechat') wechatUrl(asset.source); continue }
    if (asset.kind !== 'local' || locals.has(asset.source)) throw new Error('预览图片尚未解析或存在重复。')
    locals.add(asset.source)
    const destination = uploaded.get(asset.path)
    if (!destination) throw new Error('正文图片缺少已验证素材。')
    const quote = attribute[1] === undefined ? "'" : '"'
    const start = tag.index! + attribute.index! + attribute[0].indexOf(quote) + 1
    replacements.push({ start, end: start + source.length, value: escapeHtml(mode === 'wechat' ? wechatUrl(destination) : destination) })
  }
  let final = html
  for (const replacement of replacements.reverse()) final = final.slice(0, replacement.start) + replacement.value + final.slice(replacement.end)
  const result = new TextEncoder().encode(final)
  if (!result.byteLength || result.byteLength > MAX_BYTES) throw new Error('最终 HTML 超过 8-MiB 限制。')
  return result
}
