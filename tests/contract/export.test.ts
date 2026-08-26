import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createExportTool } from '../../src/tools/export.ts'
import { ArtifactStore } from '../../src/workspace/artifact-store.ts'
import { createPreviewPublicationOwnership, createPreviewReceipt, createPreviewSnapshot, publishPreviewSnapshot } from '../../src/workspace/preview.ts'
import { computeArticleRevision } from '../../src/workspace/revision.ts'
import type { ArticleManifest } from '../../src/workspace/revision.ts'

interface Target { targetKey: string; displayPath: string }
const encoder = new TextEncoder(); const now = new Date('2026-08-25T06:00:00.000Z')
function fileSystem(cwd: string) { return { async resolve(path: string): Promise<Target> { const displayPath = resolve(cwd, path); let ancestor = displayPath; const missing: string[] = []; while (true) { try { return { displayPath, targetKey: join(await realpath(ancestor), ...missing) } } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; missing.unshift(basename(ancestor)); const parent = dirname(ancestor); if (parent === ancestor) return { displayPath, targetKey: displayPath }; ancestor = parent } } }, processPath(target: Target) { return target.targetKey }, contains(parent: Target, child: Target) { const path = relative(parent.targetKey, child.targetKey); return path === '' || (!path.startsWith('..') && !isAbsolute(path)) }, async stat(target: Target) { try { const info = await stat(target.targetKey); return { version: `${info.mtimeMs}:${info.size}`, type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.size } } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error } }, async readBytes(target: Target, signal: AbortSignal | undefined, max: number) { signal?.throwIfAborted(); try { const bytes = await readFile(target.targetKey); if (bytes.byteLength > max) throw new Error('large'); return bytes } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { const missing = new Error('missing') as Error & { code: string }; missing.code = 'FS_NOT_FOUND'; throw missing } throw error } } } }

describe('md2wechat_export', () => {
  let temporary: string; let workspace: string; let store: ArtifactStore; let manifestPath: string; let receiptId: string; let sourcePath: string; let html: Uint8Array; let approvals: Record<string, unknown>[]; let resolvedRefs: string[]; let approvalOutcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'; let approvalHook: (() => void | Promise<void>) | undefined
  const key = 'preview-secret'; const agent = { id: 'export-agent' } as never
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-export-')); workspace = join(temporary, 'workspace'); await mkdir(workspace); store = new ArtifactStore(fileSystem(workspace) as never, workspace, '.dsh/md2wechat')
    const article = encoder.encode('# Fixture\n'); const manifest: ArticleManifest = { schemaVersion: 1, articlePath: 'article.md', manifestPath: 'manifest.json', createdAt: now.toISOString(), title: 'Fixture' }; const revision = computeArticleRevision(article, manifest); const articlePath = `revisions/${revision.id}/article.md`; manifestPath = `revisions/${revision.id}/manifest.json`; await store.writeAtomic(articlePath, article); await store.writeAtomic(manifestPath, encoder.encode(`${JSON.stringify(manifest)}\n`))
    const snapshot = createPreviewSnapshot({ revisionId: revision.id, articlePath, articleBytes: article, localImages: [], layoutBaseUrl: 'https://www.md2wechat.cn', previewSettings: { mode: 'api', theme: 'default', fontSize: 'medium', backgroundType: 'none', output: 'standalone-html' }, credentialReference: 'MD2WECHAT_API_KEY', credentialValue: key, pluginVersion: '1.0.0', cliVersion: '3.3.0' })
    html = encoder.encode('<article>exact\nbytes</article>'); sourcePath = `revisions/${revision.id}/previews/html/${snapshot.id}.html`; const receipt = createPreviewReceipt({ snapshot, previewHtmlPath: sourcePath, previewHtmlBytes: html, credentialValue: key, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString(), metadata: { title: 'Fixture', author: '', digest: '' }, assets: [] }); await store.writeAtomic(sourcePath, html); await publishPreviewSnapshot(store, { state: 'published', snapshot, receipt, ownership: createPreviewPublicationOwnership() }); receiptId = receipt.id; approvals = []; resolvedRefs = []; approvalOutcome = 'allowed-once'; approvalHook = undefined
  })
  afterEach(async () => { await import('node:fs/promises').then(fs => fs.rm(temporary, { recursive: true, force: true })) })
  function deps(selectedStore = store) { return { store: selectedStore, layoutBaseUrl: 'https://www.md2wechat.cn', credentialRefs: { MD2WECHAT_API_KEY: 'MD2WECHAT_API_KEY' }, credentials: { resolve(ref: string) { resolvedRefs.push(ref); return Promise.resolve({ value: key, source: 'test' }) } }, approval: { async request(request: Record<string, unknown>) { approvals.push(request); await approvalHook?.(); return approvalOutcome } }, previewTheme: 'default', previewFontSize: 'medium' as const, previewBackgroundType: 'none' as const, now: () => new Date(now.getTime() + 60_000) } }
  function exec(signal = new AbortController().signal) { return { signal, callId: 'export-call' as never, name: 'md2wechat_export', arguments: {}, rootCallId: 'export-call' as never, token: Symbol('export') as never, agent, deferContext() {}, concludeTurn() {} } }

  it('asks once, resolves only preview proof, and atomically copies exact signed bytes without a CLI', async () => {
    const destinationPath = join(temporary, 'out', 'article.html'); const result = await createExportTool(deps()).execute({ manifestPath, previewReceiptId: receiptId, destinationPath }, exec())
    expect(approvals).toHaveLength(1); expect(String(approvals[0]!.reason)).toContain(destinationPath); expect(resolvedRefs).toEqual(['MD2WECHAT_API_KEY']); expect(Array.from(await readFile(destinationPath))).toEqual(Array.from(html)); expect(result).toMatchObject({ manifestPath, previewReceiptId: receiptId, sourcePath, destinationPath, pluginVersion: '1.0.0', cliVersion: '3.3.0' })
  })

  it('rejects relative, same-source, stale, unknown, and pre-cancelled requests without partial output', async () => {
    const tool = createExportTool(deps())
    await expect(tool.execute({ manifestPath, previewReceiptId: receiptId, destinationPath: 'relative.html' }, exec())).rejects.toThrow('absolute')
    await expect(tool.execute({ manifestPath, previewReceiptId: receiptId, destinationPath: store.resolve(sourcePath) }, exec())).rejects.toThrow('failed')
    expect(approvals).toHaveLength(0)
    await expect(tool.execute({ manifestPath, previewReceiptId: 'a'.repeat(64), destinationPath: join(temporary, 'stale.html') }, exec())).rejects.toThrow('failed')
    await expect(tool.execute({ manifestPath, previewReceiptId: receiptId, destinationPath: join(temporary, 'x.html'), extra: true } as never, exec())).rejects.toThrow('unknown')
    const controller = new AbortController(); controller.abort(); await expect(tool.execute({ manifestPath, previewReceiptId: receiptId, destinationPath: join(temporary, 'cancel.html') }, exec(controller.signal))).rejects.toThrow('cancel')
  })

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('does not resolve credentials or write when approval is %s', async outcome => {
    approvalOutcome = outcome; const destinationPath = join(temporary, `${outcome}.html`)
    await expect(createExportTool(deps()).execute({ manifestPath, previewReceiptId: receiptId, destinationPath }, exec())).rejects.toThrow()
    expect(approvals).toHaveLength(1); expect(resolvedRefs).toHaveLength(0); await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('binds destination and parent identity across approval', async () => {
    const first = join(temporary, 'first'); const second = join(temporary, 'second'); const parent = join(temporary, 'selected'); await mkdir(first); await mkdir(second); await symlink(first, parent)
    const destinationPath = join(parent, 'article.html'); approvalHook = async () => { await rm(parent); await symlink(second, parent) }
    await expect(createExportTool(deps()).execute({ manifestPath, previewReceiptId: receiptId, destinationPath }, exec())).rejects.toThrow('failed')
    await expect(readFile(join(first, 'article.html'))).rejects.toMatchObject({ code: 'ENOENT' }); await expect(readFile(join(second, 'article.html'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects destination replacement with a symlink after approval preflight', async () => {
    const destinationPath = join(temporary, 'late-link.html'); const redirected = join(temporary, 'redirected.html'); await writeFile(redirected, 'keep')
    approvalHook = async () => { await symlink(redirected, destinationPath) }
    await expect(createExportTool(deps()).execute({ manifestPath, previewReceiptId: receiptId, destinationPath }, exec())).rejects.toThrow('failed')
    expect(await readFile(redirected, 'utf8')).toBe('keep')
  })

  it('rejects a destination hard-linked to the signed source before approval', async () => {
    const destinationPath = join(temporary, 'hardlink.html'); await link(store.resolve(sourcePath), destinationPath)
    await expect(createExportTool(deps()).execute({ manifestPath, previewReceiptId: receiptId, destinationPath }, exec())).rejects.toThrow('failed')
    expect(approvals).toHaveLength(0); expect(resolvedRefs).toHaveLength(0)
  })

  it('writes verified bytes without calling copyOut or rereading a changed source', async () => {
    const selected = Object.create(store) as ArtifactStore
    selected.copyOut = async () => { await writeFile(store.resolve(sourcePath), 'changed after signature verification'); throw new Error('copyOut must not be used') }
    const destinationPath = join(temporary, 'verified.html')
    const result = await createExportTool(deps(selected)).execute({ manifestPath, previewReceiptId: receiptId, destinationPath }, exec())
    expect(result.sha256).toBeDefined(); expect(Array.from(await readFile(destinationPath))).toEqual(Array.from(html))
  })

  it('fails safely when the signed source changes at the native commit boundary', async () => {
    const destinationPath = join(temporary, 'source-race.html')
    const selected = new ArtifactStore(store.fs, workspace, '.dsh/md2wechat', { async beforeNativeCommit() { await writeFile(store.resolve(sourcePath), 'changed at commit') } })
    await expect(createExportTool(deps(selected)).execute({ manifestPath, previewReceiptId: receiptId, destinationPath }, exec())).rejects.toThrow('failed')
    await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails safely when the destination becomes a hard-link alias at commit', async () => {
    const destinationPath = join(temporary, 'destination-race.html')
    const selected = new ArtifactStore(store.fs, workspace, '.dsh/md2wechat', { async beforeNativeCommit() { await link(store.resolve(sourcePath), destinationPath) } })
    await expect(createExportTool(deps(selected)).execute({ manifestPath, previewReceiptId: receiptId, destinationPath }, exec())).rejects.toThrow('failed')
    expect(approvals).toHaveLength(1); expect(Array.from(await readFile(destinationPath))).toEqual(Array.from(html))
  })

  it('fails safely when the destination parent is replaced at commit', async () => {
    const parent = join(temporary, 'parent-race'); const moved = join(temporary, 'parent-race-moved'); const destinationPath = join(parent, 'article.html'); await mkdir(parent)
    const selected = new ArtifactStore(store.fs, workspace, '.dsh/md2wechat', { async beforeNativeCommit() { await rename(parent, moved); await mkdir(parent) } })
    await expect(createExportTool(deps(selected)).execute({ manifestPath, previewReceiptId: receiptId, destinationPath }, exec())).rejects.toThrow('failed')
    await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(readFile(join(moved, 'article.html'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not perform asynchronous path preparation after the final destination identity check', async () => {
    const destinationPath = join(temporary, 'last-check-race.html'); await writeFile(destinationPath, 'approved target')
    const canonicalDestination = await realpath(destinationPath); const base = fileSystem(workspace); let armed = false; let replaced = false
    const racing = { ...base, async resolve(path: string) { if (armed && !replaced && resolve(path) === canonicalDestination) { replaced = true; await rm(destinationPath); await writeFile(destinationPath, 'replacement target') }; return base.resolve(path) } }
    const selected = new ArtifactStore(racing as never, workspace, '.dsh/md2wechat', { beforeNativeCommit() { armed = true } })
    await expect(createExportTool(deps(selected)).execute({ manifestPath, previewReceiptId: receiptId, destinationPath }, exec())).rejects.toThrow('failed')
    expect(replaced).toBe(true); expect(await readFile(destinationPath, 'utf8')).toBe('replacement target')
  })

  it('binds the nearest existing destination ancestor when the direct parent is absent', async () => {
    const selected = join(temporary, 'selected-tree'); const moved = join(temporary, 'selected-tree-moved'); await mkdir(selected)
    const destinationPath = join(selected, 'new', 'article.html'); approvalHook = async () => { await rename(selected, moved); await mkdir(selected) }
    await expect(createExportTool(deps()).execute({ manifestPath, previewReceiptId: receiptId, destinationPath }, exec())).rejects.toThrow('failed')
    await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(readFile(join(moved, 'new', 'article.html'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['content', 'identity'] as const)('never publishes a temporary file whose %s changes after the commit hook', async mutation => {
    const destinationPath = join(temporary, `temp-${mutation}-race.html`); await writeFile(destinationPath, 'approved target')
    const selected = new ArtifactStore(store.fs, workspace, '.dsh/md2wechat', { async beforeNativeCommit({ tempPath }) { if (mutation === 'identity') await rm(tempPath); await writeFile(tempPath, 'unverified bytes') } })
    await expect(createExportTool(deps(selected)).execute({ manifestPath, previewReceiptId: receiptId, destinationPath }, exec())).rejects.toThrow('failed')
    expect(await readFile(destinationPath, 'utf8')).toBe('approved target')
  })

  it.each(['symlink', 'directory'] as const)('rejects a %s inserted at an exclusively created destination segment', async race => {
    const parent = join(temporary, `${race}-segment-parent`); const segment = join(parent, 'new'); const redirected = join(temporary, `${race}-redirected`); await mkdir(parent); await mkdir(redirected); let raced = false
    const canonicalSegment = join(await realpath(parent), 'new')
    const destinationPath = join(segment, 'article.html')
    const selected = new ArtifactStore(store.fs, workspace, '.dsh/md2wechat', { async beforeExportDirectoryCreate(paths) { if (paths.destinationPath !== canonicalSegment) return; raced = true; if (race === 'symlink') await symlink(redirected, segment); else await mkdir(segment) } })
    await expect(createExportTool(deps(selected)).execute({ manifestPath, previewReceiptId: receiptId, destinationPath }, exec())).rejects.toThrow('failed')
    expect(raced).toBe(true); await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(readFile(join(redirected, 'article.html'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves no partial destination when the final atomic write fails', async () => {
    const destinationPath = join(temporary, 'write-failure.html')
    const selected = new ArtifactStore(store.fs, workspace, '.dsh/md2wechat', { renameAuthorizedSync: () => { throw new Error('injected write failure') } })
    await expect(createExportTool(deps(selected)).execute({ manifestPath, previewReceiptId: receiptId, destinationPath }, exec())).rejects.toThrow('failed')
    await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
