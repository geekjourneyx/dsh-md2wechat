import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createCreatorDelivery } from '../../src/creator/delivery.ts'
import type { CreatorDeliveryDependencies } from '../../src/creator/delivery.ts'
import type { CreatorRevision } from '../../src/creator/session.ts'
import type { ImageCandidate } from '../../src/creator/image-choices.ts'
import type { CliEnvelope } from '../../src/cli/protocol.ts'
import type { CliRunOptions } from '../../src/cli/gateway.ts'
import { ArtifactStore } from '../../src/workspace/artifact-store.ts'
import { DraftStateStore } from '../../src/workspace/draft.ts'
import { encodeCanonical } from '../../src/workspace/images.ts'
import { computeArticleRevision } from '../../src/workspace/revision.ts'
import { createPreviewPublicationOwnership, createPreviewReceipt, createPreviewSnapshot, publishPreviewSnapshot } from '../../src/workspace/preview.ts'

const roots: string[] = []
const now = new Date('2026-10-20T08:00:00.000Z')
const signal = new AbortController().signal
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
const coverPng = Buffer.from([...png.slice(0, 8), 2])
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const success = (data: Record<string, unknown>): CliEnvelope => ({ success: true, code: 'OK', message: 'Success', schema_version: 'v1', status: 'completed', retryable: false, data })
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(localOnly = false, bodyBytes = png, onlineSource?: string) {
  const workspace = await mkdtemp(join(tmpdir(), 'creator-delivery-')); roots.push(workspace)
  const stateDir = await mkdtemp(join(process.cwd(), '.creator-delivery-state-')); roots.push(stateDir)
  const fs = {
    async resolve(path: string) {
      const displayPath = resolve(workspace, path); let ancestor = displayPath; const missing: string[] = []
      while (true) {
        try { return { displayPath, targetKey: join(await realpath(ancestor), ...missing) } }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; missing.unshift(basename(ancestor)); ancestor = dirname(ancestor) }
      }
    },
    processPath: (t: { targetKey: string }) => t.targetKey,
    contains(a: { targetKey: string }, b: { targetKey: string }) { const path = relative(a.targetKey, b.targetKey); return path === '' || (!path.startsWith('..') && !isAbsolute(path)) },
    async stat(t: { targetKey: string }) { try { const info = await stat(t.targetKey); return { type: info.isFile() ? 'file' : 'directory', size: info.size, version: `${info.mtimeMs}:${info.size}` } } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error } },
    async readBytes(t: { targetKey: string }, readSignal: AbortSignal | undefined, max: number) {
      readSignal?.throwIfAborted()
      try { const bytes = await readFile(t.targetKey); if (bytes.byteLength > max) throw new Error('too large'); return bytes }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw Object.assign(new Error('missing'), { code: 'FS_NOT_FOUND' }); throw error }
    },
  }
  const store = new ArtifactStore(fs as never, workspace, '.articles')
  const markdown = '# Article\r\n\r\nText.\r\n\r\n![body](images/body.png)\r\n' + (onlineSource ? `\r\n![remote](${onlineSource})\r\n` : '')
  const articleBytes = Buffer.from(markdown)
  const manifest = { schemaVersion: 1 as const, articlePath: 'article.md', manifestPath: 'manifest.json', title: 'Article', createdAt: now.toISOString() }
  const computed = computeArticleRevision(articleBytes, manifest)
  const articlePath = `revisions/${computed.id}/article.md`
  const revision: CreatorRevision = { id: computed.id, manifestPath: `revisions/${computed.id}/manifest.json`, title: 'Article', markdown }
  const bodyPath = `revisions/${revision.id}/images/body.png`
  const coverPath = `revisions/${revision.id}/images/cover.png`
  await store.writeAtomic(articlePath, articleBytes)
  await store.writeAtomic(revision.manifestPath, encodeCanonical(manifest))
  await store.writeAtomic(bodyPath, bodyBytes)
  await store.writeAtomic(coverPath, coverPng)
  await store.writeAtomic(`revisions/${revision.id}/images/unselected.png`, Buffer.from([...png.slice(0, 8), 3]))
  const cover: ImageCandidate = { id: 'selected-cover', revisionId: revision.id, kind: 'cover', path: coverPath, sha256: hash(coverPng), contentType: 'image/png', byteSize: coverPng.length, alt: 'Cover' }
  const html = Buffer.from('\uFEFF<article>Exact\r\n<img class="hero" src="images/body.png" alt="x">  End</article>\r\n' + (onlineSource ? `<img src="${onlineSource.replaceAll('&', '&amp;')}">\r\n` : ''))
  const snapshot = createPreviewSnapshot({ revisionId: revision.id, articlePath, articleBytes, localImages: [{ path: bodyPath, bytes: bodyBytes }], layoutBaseUrl: 'https://www.md2wechat.cn', previewSettings: { mode: 'api', theme: 'default', fontSize: 'medium', backgroundType: 'none', output: 'standalone-html' }, credentialReference: 'MD2WECHAT_API_KEY', credentialValue: 'preview-key', pluginVersion: '1.0.0', cliVersion: '3.3.0' })
  const htmlPath = `revisions/${revision.id}/previews/html/${snapshot.id}.html`
  const receipt = createPreviewReceipt({ snapshot, previewHtmlPath: htmlPath, previewHtmlBytes: html, credentialValue: 'preview-key', issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString(), metadata: { title: 'Article', author: 'Author', digest: 'Summary' }, assets: [{ index: 0, kind: 'local', source: 'images/body.png', path: bodyPath, sha256: hash(bodyBytes) }, ...(onlineSource ? [{ index: 1, kind: 'online' as const, source: onlineSource }] : [])] })
  await store.writeAtomic(htmlPath, html)
  await publishPreviewSnapshot(store, { state: 'published', snapshot, receipt, ownership: createPreviewPublicationOwnership() })
  const calls: Array<{ argv: readonly string[]; options?: CliRunOptions; request?: unknown }> = []
  const approvals: Array<Record<string, unknown>> = []
  const resolved: string[] = []
  const control: {
    approval: 'allowed-once' | 'rejected'; account: string; clock: Date; previewKey: string
    beforeApproval?: () => Promise<void>
    respond?: (argv: readonly string[], index: number) => CliEnvelope
  } = { approval: 'allowed-once', account: 'wx-account', clock: new Date(now.getTime() + 1000), previewKey: 'preview-key' }
  const gateway = {
    resolve: async () => '/fixture/md2wechat',
    async run(argv: readonly string[], options?: CliRunOptions) {
      await options?.beforeSpawn?.(options.signal ?? signal)
      const request = argv[0] === 'create_draft' ? JSON.parse(await readFile(argv[1]!, 'utf8')) : undefined
      calls.push({ argv, ...(options ? { options } : {}), ...(request ? { request } : {}) })
      if (control.respond) return control.respond(argv, calls.length)
      return argv[0] === 'upload_image'
        ? success({ media_id: `media-${basename(argv[1]!)}`, wechat_url: `https://mmbiz.qpic.cn/${basename(argv[1]!)}`, width: 0, height: 0 })
        : success({ media_id: 'draft-one', draft_url: 'https://mp.weixin.qq.com/draft/one' })
    },
  }
  const settings = { layoutBaseUrl: 'https://www.md2wechat.cn', previewFontSize: 'medium' as const, previewBackgroundType: 'none' as const }
  const dependencies: CreatorDeliveryDependencies = { store, gateway, state: new DraftStateStore(stateDir), ...settings, now: () => control.clock,
    credentialRefs: localOnly ? { MD2WECHAT_API_KEY: 'MD2WECHAT_API_KEY' } : { MD2WECHAT_API_KEY: 'MD2WECHAT_API_KEY', WECHAT_APPID: 'WECHAT_APPID', WECHAT_SECRET: 'WECHAT_SECRET' },
    credentials: { resolve: async (ref: string) => { resolved.push(ref); return { value: ref === 'MD2WECHAT_API_KEY' ? control.previewKey : ref === 'WECHAT_APPID' ? control.account : 'account-secret', source: 'test' } } },
    approval: { request: async (request: unknown) => { approvals.push(request as Record<string, unknown>); await control.beforeApproval?.(); return control.approval } },
  }
  const delivery = createCreatorDelivery(dependencies)
  const exec = { agent: { id: 'creator-agent' } as never, callId: 'creator-delivery-call' as never, signal }
  const args = { revision, theme: 'default', previewReceiptId: receipt.id, cover }
  const finalArgs = (proof: Awaited<ReturnType<typeof delivery.prepare>>) => ({ proof, revision, theme: 'default', coverId: cover.id })
  return { workspace, store, delivery, dependencies, exec, args, finalArgs, cover, bodyPath, html, htmlPath, control, calls, approvals, resolved }
}

describe('creator portable local delivery', () => {
  it('prepares standalone local image bytes before review without a cover, WeChat credentials, approval or CLI', async () => {
    const f = await fixture(true)
    await rm(f.store.resolve(f.cover.path))
    const { cover: _cover, ...args } = f.args
    const proof = await f.delivery.prepareLocal(args, f.exec)
    const html = await readFile(join(f.workspace, proof.path))
    expect(html).toEqual(Buffer.from(f.html.toString('utf8').replace('src="images/body.png"', `src="data:image/png;base64,${png.toString('base64')}"`)))
    expect(proof.sha256).toBe(hash(html))
    expect(proof.assets).toEqual([])
    expect(await f.store.read(f.htmlPath)).toEqual(f.html)
    expect(f.approvals).toEqual([]); expect(f.calls).toEqual([])
    expect(f.resolved).toEqual(['MD2WECHAT_API_KEY'])
    const destinationPath = join(f.workspace, 'exports', 'article.html')
    await f.delivery.exportLocal({ proof, revision: args.revision, theme: args.theme, destinationPath }, f.exec)
    expect(await readFile(destinationPath)).toEqual(html)
    expect(f.approvals).toHaveLength(1)
    expect(f.resolved).toEqual(['MD2WECHAT_API_KEY', 'MD2WECHAT_API_KEY'])
    expect(f.calls).toEqual([])
  })

  it('rejects forged, stale revision, theme, expired, and tampered local proofs before approval', async () => {
    const f = await fixture(true)
    const proof = await f.delivery.prepareLocal(f.args, f.exec)
    const args = { proof, revision: f.args.revision, theme: 'default', destinationPath: join(f.workspace, 'no.html') }
    for (const bad of [{ ...args, proof: { ...proof } }, { ...args, theme: 'other' }, { ...args, revision: { ...args.revision, markdown: 'changed' } }]) {
      await expect(f.delivery.exportLocal(bad, f.exec)).rejects.toThrow()
    }
    f.control.clock = new Date(now.getTime() + 700_000)
    await expect(f.delivery.exportLocal(args, f.exec)).rejects.toThrow()
    f.control.clock = new Date(now.getTime() + 1000)
    await writeFile(join(f.workspace, proof.path), 'changed')
    await expect(f.delivery.exportLocal(args, f.exec)).rejects.toThrow()
    expect(f.approvals).toEqual([]); expect(f.calls).toEqual([])
  })

  it('rechecks source images after local export approval and leaves destination unchanged on tampering', async () => {
    const f = await fixture(true)
    const proof = await f.delivery.prepareLocal(f.args, f.exec)
    const destinationPath = join(f.workspace, 'existing.html')
    await writeFile(destinationPath, 'original')
    f.control.beforeApproval = async () => { await writeFile(f.store.resolve(f.bodyPath), coverPng) }
    await expect(f.delivery.exportLocal({ proof, revision: f.args.revision, theme: 'default', destinationPath }, f.exec)).rejects.toThrow()
    expect(await readFile(destinationPath, 'utf8')).toBe('original')
    expect(f.calls).toEqual([])
  })

  it('rejects a changed preview credential and base receipt instead of exporting stale portable HTML', async () => {
    const f = await fixture(true)
    const proof = await f.delivery.prepareLocal(f.args, f.exec)
    const args = { proof, revision: f.args.revision, theme: 'default', destinationPath: join(f.workspace, 'no.html') }
    f.control.previewKey = 'rotated-key'
    await expect(f.delivery.exportLocal(args, f.exec)).rejects.toThrow()
    f.control.previewKey = 'preview-key'
    await writeFile(f.store.resolve(f.htmlPath), '<p>changed original preview</p>')
    await expect(f.delivery.exportLocal(args, f.exec)).rejects.toThrow()
    await expect(readFile(args.destinationPath)).rejects.toThrow()
    expect(f.calls).toEqual([])
  })

  it('does not resolve another credential or write after local export approval is rejected', async () => {
    const f = await fixture(true)
    const proof = await f.delivery.prepareLocal(f.args, f.exec)
    const destinationPath = join(f.workspace, 'no.html')
    f.control.approval = 'rejected'
    const resolved = f.resolved.length
    await expect(f.delivery.exportLocal({ proof, revision: f.args.revision, theme: 'default', destinationPath }, f.exec)).rejects.toThrow(/授权/u)
    expect(f.resolved).toHaveLength(resolved)
    await expect(readFile(destinationPath)).rejects.toThrow()
    expect(f.calls).toEqual([])
  })

  it('binds portable exports to the original signed layout configuration', async () => {
    const f = await fixture(true)
    const proof = await f.delivery.prepareLocal(f.args, f.exec)
    const destinationPath = join(f.workspace, 'no.html')
    f.dependencies.layoutBaseUrl = 'https://different.example'
    await expect(f.delivery.exportLocal({ proof, revision: f.args.revision, theme: 'default', destinationPath }, f.exec)).rejects.toThrow()
    await expect(readFile(destinationPath)).rejects.toThrow()
    expect(f.calls).toEqual([])
  })

  it('bounds portable HTML after base64 expansion without publishing or sending oversized content', async () => {
    const f = await fixture(true, Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]))
    await expect(f.delivery.prepareLocal(f.args, f.exec)).rejects.toThrow(/8-MiB/u)
    await expect(readdir(f.store.resolve(`revisions/${f.args.revision.id}/delivery`))).rejects.toThrow()
    expect(f.calls).toEqual([]); expect(f.approvals).toEqual([])
  })

  it.each(['https://example.test/image.png', 'http://mmbiz.qpic.cn/image.png', 'https://mmbiz.qpic.cn.evil.test/image.png'])('rejects undisplayable remote source %s with a local import remedy and no fetch', async onlineSource => {
    const f = await fixture(true, png, onlineSource)
    await expect(f.delivery.prepareLocal(f.args, f.exec)).rejects.toThrow(/导入本地图片/u)
    await expect(readdir(f.store.resolve(`revisions/${f.args.revision.id}/delivery`))).rejects.toThrow()
    expect(f.calls).toEqual([]); expect(f.approvals).toEqual([]); expect(f.resolved).toEqual([])
  })

  it('preserves display-allowed canonical WeChat sources without fetching them', async () => {
    const f = await fixture(true, png, 'https://mmbiz.qpic.cn/image.png?a=1&b=2')
    const proof = await f.delivery.prepareLocal(f.args, f.exec)
    expect(await readFile(join(f.workspace, proof.path), 'utf8')).toContain('<img src="https://mmbiz.qpic.cn/image.png?a=1&amp;b=2">')
    expect(f.calls).toEqual([]); expect(f.approvals).toEqual([])
  })
})

describe('creator exact final delivery', () => {
  it('uploads only selected local assets then exposes immutable finalized bytes before review', async () => {
    const f = await fixture()
    const proof = await f.delivery.prepare(f.args, f.exec)
    expect(f.calls.map(call => call.argv[0])).toEqual(['upload_image', 'upload_image'])
    expect(f.calls.map(call => basename(call.argv[1]!)).sort()).toEqual(['body.png', 'cover.png'])
    expect(f.approvals).toHaveLength(1)
    expect(String(f.approvals[0]!.reason)).toMatch(/retry|重试/u)
    for (const call of f.calls) {
      expect(call.argv.at(-1)).toBe('--json')
      expect(call.options?.env).toMatchObject({ COMPRESS_IMAGES: 'false', WECHAT_APPID: 'wx-account', WECHAT_SECRET: 'account-secret', WECHAT_ACCOUNT: '', WECHAT_PROXY_URL: '' })
      expect(call.options?.cwd).toBe(call.options?.env?.HOME)
      expect(call.options?.cwd).not.toBe(f.workspace)
    }
    const final = await readFile(join(f.workspace, proof.path))
    expect(final).toEqual(Buffer.from(f.html.toString('utf8').replace('src="images/body.png"', 'src="https://mmbiz.qpic.cn/body.png"')))
    expect(hash(final)).toBe(proof.sha256)
    expect(proof.assets).toEqual([{ source: 'https://mmbiz.qpic.cn/body.png', path: `.articles/${f.bodyPath}`, sha256: hash(png), contentType: 'image/png' }])
    expect(await f.store.read(f.htmlPath)).toEqual(f.html)
    expect(JSON.stringify(proof)).not.toMatch(/media_id|mediaId|account-secret|preview-key/u)
  })

  it('exports and submits the exact same finalized bytes without another upload or transformation', async () => {
    const f = await fixture(); const proof = await f.delivery.prepare(f.args, f.exec)
    const final = await readFile(join(f.workspace, proof.path))
    const destinationPath = join(f.workspace, 'reviewed.html')
    const exported = await f.delivery.exportFinal({ ...f.finalArgs(proof), destinationPath }, f.exec)
    expect(exported.path).toBe(destinationPath)
    expect(await readFile(destinationPath)).toEqual(final)
    const result = await f.delivery.createDraftFinal(f.finalArgs(proof), f.exec)
    expect(result.draftId).toBe('draft-one')
    const request = f.calls.at(-1)!.request as { articles: Array<{ content: string; thumb_media_id: string }> }
    expect(Buffer.from(request.articles[0]!.content, 'utf8')).toEqual(final)
    expect(request.articles[0]!.thumb_media_id).toBe('media-cover.png')
    const replay = await f.delivery.createDraftFinal(f.finalArgs(proof), f.exec)
    expect(replay).toEqual(result)
    expect(f.calls.map(call => call.argv[0])).toEqual(['upload_image', 'upload_image', 'create_draft'])
  })

  it('does no credentials or remote work when upload approval is rejected', async () => {
    const f = await fixture(); f.control.approval = 'rejected'
    await expect(f.delivery.prepare(f.args, f.exec)).rejects.toThrow(/approval|授权/u)
    expect(f.resolved).toEqual([]); expect(f.calls).toEqual([])
  })

  it('rejects a forged delivery proof and changed revision, theme or selected cover', async () => {
    const f = await fixture(); const proof = await f.delivery.prepare(f.args, f.exec)
    const count = f.approvals.length
    const args = f.finalArgs(proof)
    for (const forged of [{ ...args, proof: { ...proof } }, { ...args, revision: { ...args.revision, markdown: 'changed' } }, { ...args, theme: 'other' }, { ...args, coverId: 'unselected' }]) {
      await expect(f.delivery.createDraftFinal(forged, f.exec)).rejects.toThrow()
    }
    expect(f.approvals).toHaveLength(count); expect(f.calls).toHaveLength(2)
  })

  it('rechecks image bytes after approval before an upload', async () => {
    const f = await fixture()
    f.control.beforeApproval = async () => { await writeFile(f.store.resolve(f.cover.path), png) }
    await expect(f.delivery.prepare(f.args, f.exec)).rejects.toThrow()
    expect(f.calls).toEqual([])
  })

  it('blocks uncertain upload retries durably, even through a new prepare call', async () => {
    const f = await fixture()
    f.control.respond = () => success({ media_id: 'unknown', wechat_url: 'https://evil.test/image', width: 0, height: 0 })
    await expect(f.delivery.prepare(f.args, f.exec)).rejects.toThrow(/unknown|未知/u)
    const count = f.calls.length
    delete f.control.respond
    await expect(f.delivery.prepare(f.args, f.exec)).rejects.toThrow(/unknown|未知/u)
    expect(f.calls).toHaveLength(count)
  })

  it('keeps verified upload successes and never reissues an uncertain remaining asset', async () => {
    const f = await fixture()
    f.control.respond = (argv, index) => index === 1 ? success({ media_id: 'first', wechat_url: `https://mmbiz.qpic.cn/${basename(argv[1]!)}`, width: 0, height: 0 }) : success({ unexpected: true })
    await expect(f.delivery.prepare(f.args, f.exec)).rejects.toThrow(/unknown|未知/u)
    expect(f.calls).toHaveLength(2)
    delete f.control.respond
    await expect(f.delivery.prepare(f.args, f.exec)).rejects.toThrow(/unknown|未知/u)
    expect(f.calls).toHaveLength(2)
  })

  it('blocks uncertain draft retries without another approval or CLI call', async () => {
    const f = await fixture(); const proof = await f.delivery.prepare(f.args, f.exec)
    f.control.respond = () => success({ unexpected: true })
    await expect(f.delivery.createDraftFinal(f.finalArgs(proof), f.exec)).rejects.toThrow(/unknown|未知/u)
    const count = f.approvals.length
    delete f.control.respond
    await expect(f.delivery.createDraftFinal(f.finalArgs(proof), f.exec)).rejects.toThrow(/unknown|未知/u)
    expect(f.calls).toHaveLength(3); expect(f.approvals).toHaveLength(count)
  })

  it('rejects final artifact tampering before export or draft', async () => {
    const f = await fixture(); const proof = await f.delivery.prepare(f.args, f.exec)
    await writeFile(join(f.workspace, proof.path), '<p>tampered</p>')
    await expect(f.delivery.createDraftFinal(f.finalArgs(proof), f.exec)).rejects.toThrow()
    await expect(f.delivery.exportFinal({ ...f.finalArgs(proof), destinationPath: join(f.workspace, 'no.html') }, f.exec)).rejects.toThrow()
    expect(f.calls).toHaveLength(2); expect(f.approvals).toHaveLength(1)
  })

  it('rejects persisted upload metadata tampering rather than trusting a media ID', async () => {
    const f = await fixture(); const proof = await f.delivery.prepare(f.args, f.exec)
    const files = await readdir(f.store.resolve('delivery/uploads'))
    const path = f.store.resolve(`delivery/uploads/${files[0]!}`)
    const result = JSON.parse(await readFile(path, 'utf8')); result.mediaId = 'forged'; await writeFile(path, encodeCanonical(result))
    await expect(f.delivery.createDraftFinal(f.finalArgs(proof), f.exec)).rejects.toThrow()
    expect(f.calls).toHaveLength(2)
  })

  it('rejects account changes after preparation and expired review proofs', async () => {
    const f = await fixture(); const proof = await f.delivery.prepare(f.args, f.exec)
    f.control.account = 'other-account'
    await expect(f.delivery.createDraftFinal(f.finalArgs(proof), f.exec)).rejects.toThrow(/account|账户/u)
    expect(f.calls).toHaveLength(2)
    f.control.clock = new Date(now.getTime() + 700_000)
    await expect(f.delivery.exportFinal({ ...f.finalArgs(proof), destinationPath: join(f.workspace, 'no.html') }, f.exec)).rejects.toThrow()
    expect(f.calls).toHaveLength(2)
  })

  it('HTML-escapes uploaded URL attribute values without changing their verified source identity', async () => {
    const f = await fixture()
    f.control.respond = argv => success({ media_id: `media-${basename(argv[1]!)}`, wechat_url: `https://mmbiz.qpic.cn/${basename(argv[1]!)}?a=1&copy;=2`, width: 0, height: 0 })
    const proof = await f.delivery.prepare(f.args, f.exec)
    expect(await readFile(join(f.workspace, proof.path), 'utf8')).toContain('src="https://mmbiz.qpic.cn/body.png?a=1&amp;copy;=2"')
    expect(proof.assets[0]!.source).toBe('https://mmbiz.qpic.cn/body.png?a=1&copy;=2')
  })

  it('rejects cancellation before preparation without approval, credentials or uploads', async () => {
    const f = await fixture()
    await expect(f.delivery.prepare(f.args, { ...f.exec, signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled')
    expect(f.calls).toEqual([]); expect(f.approvals).toEqual([]); expect(f.resolved).toEqual([])
  })

  it('rechecks final and source image bytes after draft approval without issuing a draft', async () => {
    const f = await fixture(); const proof = await f.delivery.prepare(f.args, f.exec)
    f.control.beforeApproval = async () => { await writeFile(f.store.resolve(f.bodyPath), coverPng) }
    await expect(f.delivery.createDraftFinal(f.finalArgs(proof), f.exec)).rejects.toThrow()
    expect(f.calls).toHaveLength(2)
  })

  it('rejects export and draft approval before resolving any more credentials', async () => {
    const f = await fixture(); const proof = await f.delivery.prepare(f.args, f.exec)
    f.control.approval = 'rejected'
    const resolved = f.resolved.length
    await expect(f.delivery.exportFinal({ ...f.finalArgs(proof), destinationPath: join(f.workspace, 'no.html') }, f.exec)).rejects.toThrow(/授权/u)
    await expect(f.delivery.createDraftFinal(f.finalArgs(proof), f.exec)).rejects.toThrow(/授权/u)
    expect(f.resolved).toHaveLength(resolved); expect(f.calls).toHaveLength(2)
  })

  it('allows at most one remote draft across concurrent duplicate submissions', async () => {
    const f = await fixture(); const proof = await f.delivery.prepare(f.args, f.exec)
    const results = await Promise.allSettled([
      f.delivery.createDraftFinal(f.finalArgs(proof), f.exec),
      f.delivery.createDraftFinal(f.finalArgs(proof), f.exec),
    ])
    expect(results.some(result => result.status === 'fulfilled')).toBe(true)
    expect(f.calls.filter(call => call.argv[0] === 'create_draft')).toHaveLength(1)
  })

  it('reuses authenticated completed uploads when preparation is repeated', async () => {
    const f = await fixture(); const first = await f.delivery.prepare(f.args, f.exec)
    const next = await f.delivery.prepare(f.args, f.exec)
    expect(next.sha256).toBe(first.sha256)
    expect(f.calls).toHaveLength(2)
  })
})
