import { mkdir, mkdtemp, readFile, realpath, stat } from 'node:fs/promises'
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
  let temporary: string; let workspace: string; let store: ArtifactStore; let manifestPath: string; let receiptId: string; let sourcePath: string; let html: Uint8Array; let approvals: Record<string, unknown>[]; let resolvedRefs: string[]; let approvalOutcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  const key = 'preview-secret'; const agent = { id: 'export-agent' } as never
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-export-')); workspace = join(temporary, 'workspace'); await mkdir(workspace); store = new ArtifactStore(fileSystem(workspace) as never, workspace, '.dsh/md2wechat')
    const article = encoder.encode('# Fixture\n'); const manifest: ArticleManifest = { schemaVersion: 1, articlePath: 'article.md', manifestPath: 'manifest.json', createdAt: now.toISOString(), title: 'Fixture' }; const revision = computeArticleRevision(article, manifest); const articlePath = `revisions/${revision.id}/article.md`; manifestPath = `revisions/${revision.id}/manifest.json`; await store.writeAtomic(articlePath, article); await store.writeAtomic(manifestPath, encoder.encode(`${JSON.stringify(manifest)}\n`))
    const snapshot = createPreviewSnapshot({ revisionId: revision.id, articlePath, articleBytes: article, localImages: [], layoutBaseUrl: 'https://www.md2wechat.cn', previewSettings: { mode: 'api', theme: 'default', fontSize: 'medium', backgroundType: 'none', output: 'standalone-html' }, credentialReference: 'MD2WECHAT_API_KEY', credentialValue: key, pluginVersion: '1.0.0', cliVersion: '3.3.0' })
    html = encoder.encode('<article>exact\nbytes</article>'); sourcePath = `revisions/${revision.id}/previews/html/${snapshot.id}.html`; const receipt = createPreviewReceipt({ snapshot, previewHtmlPath: sourcePath, previewHtmlBytes: html, credentialValue: key, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString(), metadata: { title: 'Fixture', author: '', digest: '' }, assets: [] }); await store.writeAtomic(sourcePath, html); await publishPreviewSnapshot(store, { state: 'published', snapshot, receipt, ownership: createPreviewPublicationOwnership() }); receiptId = receipt.id; approvals = []; resolvedRefs = []; approvalOutcome = 'allowed-once'
  })
  afterEach(async () => { await import('node:fs/promises').then(fs => fs.rm(temporary, { recursive: true, force: true })) })
  function deps() { return { store, layoutBaseUrl: 'https://www.md2wechat.cn', credentialRefs: { MD2WECHAT_API_KEY: 'MD2WECHAT_API_KEY' }, credentials: { resolve(ref: string) { resolvedRefs.push(ref); return Promise.resolve({ value: key, source: 'test' }) } }, approval: { request(request: Record<string, unknown>) { approvals.push(request); return Promise.resolve(approvalOutcome) } }, previewTheme: 'default', previewFontSize: 'medium' as const, previewBackgroundType: 'none' as const, now: () => new Date(now.getTime() + 60_000) } }
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
})
