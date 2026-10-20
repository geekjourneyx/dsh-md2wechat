import { mkdtemp, readFile, realpath, rm, stat, writeFile, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { CreatorService } from '../../src/creator/service.ts'
import { creatorOperations } from '../../src/creator/runtime.ts'
import { resolveConfig } from '../../src/config.ts'
import { ImagePlanStateStore } from '../../src/workspace/image-plan-state.ts'
import { DraftStateStore } from '../../src/workspace/draft.ts'

interface Target { targetKey: string; displayPath: string }
const roots: string[] = []
const signal = new AbortController().signal
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'creator-recovery-')); roots.push(workspace)
  const stateDir = await mkdtemp(join(process.cwd(), '.state-test-creator-recovery-')); roots.push(stateDir)
  let mode = 'workspace-write'; let calls = 0
  const fs = {
    async resolve(path: string, options?: { cwd?: string }): Promise<Target> {
      const displayPath = resolve(options?.cwd ?? workspace, path); let ancestor = displayPath; const missing: string[] = []
      while (true) {
        try { return { displayPath, targetKey: join(await realpath(ancestor), ...missing) } }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; missing.unshift(basename(ancestor)); ancestor = dirname(ancestor) }
      }
    },
    processPath: (target: Target) => target.targetKey,
    contains(parent: Target, child: Target) { const path = relative(parent.targetKey, child.targetKey); return path === '' || (!path.startsWith('..') && !isAbsolute(path)) },
    async stat(target: Target) { try { const value = await stat(target.targetKey); return { version: `${value.mtimeMs}:${value.size}`, type: value.isFile() ? 'file' : 'directory', size: value.size } } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error } },
    async readBytes(target: Target, readSignal: AbortSignal | undefined, maxBytes: number) {
      readSignal?.throwIfAborted()
      try { const bytes = await readFile(target.targetKey); if (bytes.byteLength > maxBytes) throw new Error('too large'); return bytes }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw Object.assign(new Error('missing file'), { code: 'FS_NOT_FOUND' }); throw error }
    },
  }
  const ctx = { fs, sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: workspace }) } }
  const agent = { id: 'owner-a', session: { header: { cwd: workspace } }, followup: () => { throw new Error('unexpected model request') } } as never
  const config = resolveConfig({ stateDir, artifactsDir: '.articles' })
  const gateway = { resolve: async () => 'md2wechat', run: async (argv: string[], options: { signal: AbortSignal; beforeSpawn?: (signal: AbortSignal) => Promise<void> }) => { await options.beforeSpawn?.(options.signal); calls++; if (argv.join(' ') !== 'themes list --json') throw new Error('unexpected external command'); return { success: true, status: 'completed', code: 'THEMES_SHOWN', data: { themes: [{ type: 'api', selectable: true, name: 'default', description: 'Default' }, { type: 'api', selectable: true, name: 'simple', description: 'Simple' }] } } } }
  const service = () => new CreatorService(creatorOperations(ctx as never, config, gateway as never, () => {}, {} as never, new ImagePlanStateStore(stateDir), new DraftStateStore(stateDir)), 'default', '.articles')
  await writeFile(join(workspace, 'a.md'), '# Article\n\nOriginal paragraph.\n')
  await writeFile(join(workspace, 'cover.png'), png)
  return { workspace, agent, service, readonly: () => { mode = 'read-only' }, calls: () => calls }
}

describe('filesystem-backed creator recovery', () => {
  it('rebuilds runtime/store/controller and restores the exact immutable revision and checked cover bytes', async () => {
    const f = await fixture(); const service = f.service(); const opened = await service.open(f.agent, 'a.md', '', signal)
    const imported = await service.dispatch(f.agent, opened.articleId, 1, { type: 'import-local-image', kind: 'cover', anchorId: '', sourcePath: 'cover.png', alt: 'Cover' }, signal)
    const cover = imported.imageCandidates[0]!
    await service.dispatch(f.agent, opened.articleId, 1, { type: 'select-cover', candidateId: cover.id }, signal)
    await service.dispatch(f.agent, opened.articleId, 2, { type: 'select-theme', theme: 'simple' }, signal)
    const restored = await f.service().get(f.agent, opened.articleId, signal)
    expect(restored).toMatchObject({ articleId: opened.articleId, version: 3, theme: 'simple', coverId: cover.id, reviewed: false, preparedForDraft: false, markdown: '# Article\n\nOriginal paragraph.\n' })
    expect(restored.imageCandidates).toEqual(imported.imageCandidates)
    expect(await readFile(join(f.workspace, 'a.md'), 'utf8')).toBe(opened.markdown)
    expect(f.calls()).toBe(2) // Theme discovery only, no preview/model/image/upload/draft commands.
  })

  it('allows restoring files after policy changes to read-only and still blocks later mutations', async () => {
    const f = await fixture(); const opened = await f.service().open(f.agent, 'a.md', '', signal); f.readonly()
    const restarted = f.service()
    expect((await restarted.resume(f.agent, opened.articleId, signal)).markdown).toBe(opened.markdown)
    await expect(restarted.dispatch(f.agent, opened.articleId, 1, { type: 'select-theme', theme: 'simple' }, signal)).rejects.toThrow('只读')
  })

  it('rejects a changed candidate instead of trusting its persisted metadata', async () => {
    const f = await fixture(); const service = f.service(); const opened = await service.open(f.agent, 'a.md', '', signal)
    const imported = await service.dispatch(f.agent, opened.articleId, 1, { type: 'import-local-image', kind: 'cover', anchorId: '', sourcePath: 'cover.png', alt: 'Cover' }, signal)
    await writeFile(join(f.workspace, imported.imageCandidates[0]!.path), Buffer.from('changed'))
    await expect(f.service().resume(f.agent, opened.articleId, signal)).rejects.toThrow('图片内容已经变化')
  })

  it('rejects a changed immutable revision even when the record itself was not changed', async () => {
    const f = await fixture(); const opened = await f.service().open(f.agent, 'a.md', '', signal)
    const record = JSON.parse(await readFile(join(f.workspace, '.articles', 'documents', `${opened.articleId}.json`), 'utf8'))
    await writeFile(join(f.workspace, '.articles', 'revisions', record.revision.id, 'article.md'), '# Corrupt')
    await expect(f.service().resume(f.agent, opened.articleId, signal)).rejects.toThrow('stale revision')
  })

  it('does not expose another session’s record when both sessions share the same workspace', async () => {
    const f = await fixture(); const opened = await f.service().open(f.agent, 'a.md', '', signal)
    const other = { ...f.agent as object, id: 'owner-b' } as never
    const restarted = f.service()
    expect(await restarted.list(other, signal)).toEqual([])
    await expect(restarted.resume(other, opened.articleId, signal)).rejects.toThrow('owner')
  })

  it('continues the saved file after source deletion without creating a replacement source', async () => {
    const f = await fixture(); const opened = await f.service().open(f.agent, 'a.md', '', signal)
    await unlink(join(f.workspace, 'a.md'))
    expect(await f.service().resume(f.agent, opened.articleId, signal)).toMatchObject({ markdown: opened.markdown, recovery: { sourceChanged: true } })
    await expect(stat(join(f.workspace, 'a.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('checks locally referenced body-image files before restoring the saved article', async () => {
    const f = await fixture()
    await writeFile(join(f.workspace, 'a.md'), '# Article\n\nParagraph.\n\n![body](cover.png)\n')
    const opened = await f.service().open(f.agent, 'a.md', '', signal)
    const record = JSON.parse(await readFile(join(f.workspace, '.articles', 'documents', `${opened.articleId}.json`), 'utf8'))
    await unlink(join(f.workspace, '.articles', 'revisions', record.revision.id, 'cover.png'))
    await expect(f.service().resume(f.agent, opened.articleId, signal)).rejects.toThrow('missing file')
  })

})
