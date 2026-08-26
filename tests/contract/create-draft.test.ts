import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CliEnvelope } from '../../src/cli/protocol.ts'
import type { CliGateway, CliRunOptions } from '../../src/cli/gateway.ts'
import { createDraftTool } from '../../src/tools/create-draft.ts'
import { ArtifactStore } from '../../src/workspace/artifact-store.ts'
import { DraftStateStore } from '../../src/workspace/draft.ts'
import { ImagePlanStateStore } from '../../src/workspace/image-plan-state.ts'
import { canonicalImagePlanId, createPersistedImageResult, encodeCanonical, imageResultPath, loadImagePlan } from '../../src/workspace/images.ts'
import { createPreviewPublicationOwnership, createPreviewReceipt, createPreviewSnapshot, publishPreviewSnapshot } from '../../src/workspace/preview.ts'
import { computeArticleRevision } from '../../src/workspace/revision.ts'
import type { ArticleManifest } from '../../src/workspace/revision.ts'

interface Target { targetKey: string; displayPath: string }
const encoder = new TextEncoder(); const now = new Date('2026-08-25T05:00:00.000Z')
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
function fileSystem(cwd: string) {
  return {
    async resolve(path: string): Promise<Target> {
      const displayPath = resolve(cwd, path); let ancestor = displayPath; const missing: string[] = []
      while (true) {
        try { return { displayPath, targetKey: join(await realpath(ancestor), ...missing) } }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; missing.unshift(basename(ancestor)); const parent = dirname(ancestor); if (parent === ancestor) return { displayPath, targetKey: displayPath }; ancestor = parent }
      }
    },
    processPath(target: Target) { return target.targetKey },
    contains(parent: Target, child: Target) { const path = relative(parent.targetKey, child.targetKey); return path === '' || (!path.startsWith('..') && !isAbsolute(path)) },
    async stat(target: Target) { try { const info = await stat(target.targetKey); return { version: `${info.mtimeMs}:${info.size}`, type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.size } } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error } },
    async readBytes(target: Target, signal: AbortSignal | undefined, max: number) { signal?.throwIfAborted(); try { const value = await readFile(target.targetKey); if (value.byteLength > max) throw new Error('large'); return value } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { const missing = new Error('missing') as Error & { code: string }; missing.code = 'FS_NOT_FOUND'; throw missing } throw error } },
  }
}

class Gateway implements CliGateway {
  calls: Array<{ argv: readonly string[]; options?: CliRunOptions; request: unknown }> = []
  response: CliEnvelope = { success: true, code: 'OK', message: 'Success', schema_version: 'v1', status: 'completed', retryable: false, data: { media_id: 'draft-safe', draft_url: 'https://mp.weixin.qq.com/draft/1' } }
  hold?: Promise<void>
  entered?: () => void
  resolve() { return Promise.resolve('/fixture/md2wechat') }
  async run(argv: readonly string[], options?: CliRunOptions) { if (options?.beforeSpawn) await options.beforeSpawn(options.signal ?? new AbortController().signal); const request = JSON.parse(await readFile(argv[1]!, 'utf8')); this.calls.push({ argv: [...argv], options, request }); this.entered?.(); await this.hold; return this.response }
}

describe('md2wechat_create_draft', () => {
  let temporary: string; let workspace: string; let stateDir: string; let store: ArtifactStore; let imageState: ImagePlanStateStore; let draftState: DraftStateStore
  let revisionId: string; let manifestPath: string; let receiptId: string; let planPaths: string[]; let approvals: Record<string, unknown>[]; let resolved: string[]; let gateway: Gateway; let approvalOutcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  const previewKey = 'preview-secret'; const agent = { id: 'draft-agent' } as never
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-draft-')); workspace = join(temporary, 'workspace'); await mkdir(workspace)
    stateDir = await mkdtemp(join(process.cwd(), '.draft-contract-state-')); store = new ArtifactStore(fileSystem(workspace) as never, workspace, '.dsh/md2wechat'); imageState = new ImagePlanStateStore(stateDir); draftState = new DraftStateStore(stateDir)
    const article = encoder.encode('# Fixture\n\n![hero](images/hero.png)\n'); const manifest: ArticleManifest = { schemaVersion: 1, articlePath: 'article.md', manifestPath: 'manifest.json', createdAt: now.toISOString(), title: 'Fixture' }; const revision = computeArticleRevision(article, manifest); revisionId = revision.id; manifestPath = `revisions/${revisionId}/manifest.json`
    const articlePath = `revisions/${revisionId}/article.md`; const heroPath = `revisions/${revisionId}/images/hero.png`; await store.writeAtomic(articlePath, article); await store.writeAtomic(manifestPath, encodeCanonical(manifest)); await store.writeAtomic(heroPath, png)
    const snapshotInput = { revisionId, articlePath, articleBytes: article, localImages: [{ path: heroPath, bytes: png }], layoutBaseUrl: 'https://www.md2wechat.cn', previewSettings: { mode: 'api' as const, theme: 'default', fontSize: 'medium' as const, backgroundType: 'none' as const, output: 'standalone-html' }, credentialReference: 'MD2WECHAT_API_KEY', credentialValue: previewKey, pluginVersion: '1.0.0', cliVersion: '3.3.0' }
    const snapshot = createPreviewSnapshot(snapshotInput); const html = encoder.encode('<article>A<img class="hero" src="images/hero.png" alt="x">B</article>'); const htmlPath = `revisions/${revisionId}/previews/html/${snapshot.id}.html`
    const receipt = createPreviewReceipt({ snapshot, previewHtmlPath: htmlPath, previewHtmlBytes: html, credentialValue: previewKey, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString(), metadata: { title: 'Fixture', author: 'Author', digest: 'Digest' }, assets: [{ index: 0, kind: 'local', source: 'images/hero.png', path: heroPath, sha256: createHash('sha256').update(png).digest('hex') }] })
    await store.writeAtomic(htmlPath, html); await publishPreviewSnapshot(store, { state: 'published', snapshot, receipt, ownership: createPreviewPublicationOwnership() }); receiptId = receipt.id
    planPaths = [await installPlan('body', 'image', 'images/hero.png', png, 'body-media', 'https://mmbiz.qpic.cn/body.png'), await installPlan('cover', 'cover', 'images/cover.png', png, 'cover-media', 'https://mmbiz.qpic.cn/cover.png')]
    approvals = []; resolved = []; gateway = new Gateway(); approvalOutcome = 'allowed-once'
  })
  afterEach(async () => { await import('node:fs/promises').then(fs => fs.rm(temporary, { recursive: true, force: true })); await import('node:fs/promises').then(fs => fs.rm(stateDir, { recursive: true, force: true })) })

  async function installPlan(id: string, kind: 'image' | 'cover', target: string, bytes: Uint8Array, mediaId: string, wechatUrl: string) {
    const articlePath = `revisions/${revisionId}/article.md`; const original = { id, kind, prompt: `${id} prompt`, targetPath: target }
    const cliPlan = kind === 'image' ? { mode: 'plan', command: 'generate_image', execution_owner: 'host_agent', side_effects: false, requires_provider: false, requires_image_api_key: false, prompt: `${id} prompt`, raw_prompt: `${id} prompt`, preset: '', archetype: '', primary_use_case: '', compatible_use_cases: [], recommended_aspect_ratios: [], default_aspect_ratio: '', article: '', title: '', summary: '', keywords: '', style: '', aspect: '', size: '', model_hint: '', suggested_filename: '', alt_text: '' } : { mode: 'plan', command: 'generate_cover', execution_owner: 'host_agent', side_effects: false, requires_provider: false, requires_image_api_key: false, prompt: `${id} prepared`, raw_prompt: '', preset: 'cover-default', archetype: 'cover', primary_use_case: 'cover', compatible_use_cases: ['cover'], recommended_aspect_ratios: ['16:9'], default_aspect_ratio: '16:9', article: articlePath, title: 'Fixture', summary: '', keywords: '', style: '', aspect: '16:9', size: '', model_hint: '', suggested_filename: 'cover.png', alt_text: 'Fixture' }
    const items = [{ original, targetArtifactPath: `revisions/${revisionId}/${target}`, cliPlan }]; const planId = canonicalImagePlanId(revisionId, items); const path = `revisions/${revisionId}/plans/${planId}.json`; const planBytes = encodeCanonical({ schemaVersion: 1, planId, revisionId, createdAt: now.toISOString(), items }); await imageState.publish(store, { planPath: path, planId, revisionId, items, planBytes }); await store.createExclusive(path, planBytes)
    const plan = await loadImagePlan(store, path, revisionId, articlePath); const item = plan.items[0]!; await store.writeIdenticalOrNew(item.targetPath, bytes); const result = createPersistedImageResult({ plan, item, bytes, mimeType: 'image/png', remoteUrl: `https://images.example/${id}.png`, mediaId, wechatUrl, createdAt: now }); await store.createExclusive(imageResultPath(plan, item), encodeCanonical(result)); return path
  }
  function deps(selectedStore = store) { return { gateway, store: selectedStore, state: draftState, imagePlanState: imageState, layoutBaseUrl: 'https://www.md2wechat.cn', credentialRefs: { MD2WECHAT_API_KEY: 'MD2WECHAT_API_KEY', WECHAT_APPID: 'WECHAT_APPID', WECHAT_SECRET: 'WECHAT_SECRET' }, credentials: { resolve(ref: string) { resolved.push(ref); return Promise.resolve({ value: ref === 'MD2WECHAT_API_KEY' ? previewKey : `secret-${ref}`, source: 'test' }) } }, approval: { request(request: Record<string, unknown>) { approvals.push(request); return Promise.resolve(approvalOutcome) } }, previewTheme: 'default', previewFontSize: 'medium' as const, previewBackgroundType: 'none' as const, now: () => new Date(now.getTime() + 60_000), reportAuditFailure() {} } }
  function exec() { return { signal: new AbortController().signal, callId: 'draft-call' as never, name: 'md2wechat_create_draft', arguments: {}, rootCallId: 'draft-call' as never, token: Symbol('draft') as never, agent, deferContext() {}, concludeTurn() {} } }

  it('uses exact finalized preview bytes, one approval, isolated account environment, and replays without side effects', async () => {
    const tool = createDraftTool(deps()); const args = { manifestPath, previewReceiptId: receiptId, planPaths }; const result = await tool.execute(args, exec())
    expect(approvals).toHaveLength(1); expect(String(approvals[0]!.reason)).toContain('does not mass-send or publish'); expect(resolved).toEqual(['MD2WECHAT_API_KEY', 'WECHAT_APPID', 'WECHAT_SECRET']); expect(gateway.calls).toHaveLength(1)
    const call = gateway.calls[0]!; expect(call.argv).toEqual(['create_draft', expect.any(String), '--json']); expect(call.options?.cwd).toBe(call.options?.env?.HOME); expect(call.options?.env).toMatchObject({ WECHAT_ACCOUNT: '', WECHAT_PROXY_URL: '', XDG_CONFIG_HOME: call.options?.cwd, MD2WECHAT_API_KEY: previewKey, WECHAT_APPID: 'secret-WECHAT_APPID', WECHAT_SECRET: 'secret-WECHAT_SECRET' }); expect(call.options?.secrets).toEqual([previewKey, 'secret-WECHAT_APPID', 'secret-WECHAT_SECRET'])
    expect(call.request).toEqual({ articles: [{ author: 'Author', content: '<article>A<img class="hero" src="https://mmbiz.qpic.cn/body.png" alt="x">B</article>', digest: 'Digest', show_cover_pic: 1, thumb_media_id: 'cover-media', title: 'Fixture' }] })
    expect(result).toMatchObject({ manifestPath, revisionId, previewReceiptId: receiptId, draftId: 'draft-safe', draftUrl: 'https://mp.weixin.qq.com/draft/1', pluginVersion: '1.0.0', cliVersion: '3.3.0' }); expect(JSON.stringify(result)).not.toContain('secret-')
    approvals.length = 0; resolved.length = 0; const replay = await tool.execute(args, exec()); expect(replay).toEqual(result); expect(approvals).toHaveLength(0); expect(resolved).toHaveLength(0); expect(gateway.calls).toHaveLength(1)
  })

  it('permanently blocks automatic retry after an uncertain malformed response', async () => {
    gateway.response = { ...gateway.response, code: 'WRONG' }
    const tool = createDraftTool(deps()); const args = { manifestPath, previewReceiptId: receiptId, planPaths }
    await expect(tool.execute(args, exec())).rejects.toThrow('failed'); const calls = gateway.calls.length
    await expect(tool.execute(args, exec())).rejects.toThrow('outcome unknown'); expect(gateway.calls).toHaveLength(calls)
  })

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('does no credential or remote work when approval is %s', async outcome => {
    approvalOutcome = outcome
    await expect(createDraftTool(deps()).execute({ manifestPath, previewReceiptId: receiptId, planPaths }, exec())).rejects.toThrow()
    expect(approvals).toHaveLength(1); expect(resolved).toHaveLength(0); expect(gateway.calls).toHaveLength(0)
  })

  it('rejects incomplete authenticated results before approval and credentials', async () => {
    const plan = await loadImagePlan(store, planPaths[0]!, revisionId, `revisions/${revisionId}/article.md`)
    await import('node:fs/promises').then(fs => fs.rm(store.resolve(imageResultPath(plan, plan.items[0]!))))
    await expect(createDraftTool(deps()).execute({ manifestPath, previewReceiptId: receiptId, planPaths }, exec())).rejects.toThrow('failed')
    expect(approvals).toHaveLength(0); expect(resolved).toHaveLength(0); expect(gateway.calls).toHaveLength(0)
  })

  it('serializes concurrent identical calls to one remote invocation', async () => {
    let enter!: () => void; const entered = new Promise<void>(resolveEntered => { enter = resolveEntered }); let release!: () => void; gateway.hold = new Promise<void>(resolveHold => { release = resolveHold }); gateway.entered = enter
    const tool = createDraftTool(deps()); const args = { manifestPath, previewReceiptId: receiptId, planPaths }; const first = tool.execute(args, exec()); await entered
    await expect(tool.execute(args, exec())).rejects.toThrow('outcome unknown'); expect(gateway.calls).toHaveLength(1); release(); await expect(first).resolves.toMatchObject({ draftId: 'draft-safe' })
  })

  it('keeps a successful remote outcome permanently non-retryable when result persistence fails', async () => {
    const failing = Object.create(store) as ArtifactStore
    failing.writeIdenticalOrNew = async (path, bytes, signal, ownership) => { if (path.includes('/drafts/results/')) throw new Error('raw persistence failure'); return store.writeIdenticalOrNew(path, bytes, signal, ownership) }
    const args = { manifestPath, previewReceiptId: receiptId, planPaths }
    await expect(createDraftTool(deps(failing)).execute(args, exec())).rejects.toThrow('failed'); expect(gateway.calls).toHaveLength(1)
    await expect(createDraftTool(deps()).execute(args, exec())).rejects.toThrow('outcome unknown'); expect(gateway.calls).toHaveLength(1)
  })
})
