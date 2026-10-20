import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import { afterEach, describe, expect, it } from 'vitest'
import { CreatorRemote } from '../../src/creator/remote.ts'
import { CreatorService } from '../../src/creator/service.ts'
import { creatorOperations } from '../../src/creator/runtime.ts'
import { creatorErrorInfo } from '../../src/creator/errors.ts'
import { resolveConfig } from '../../src/config.ts'
import { computeArticleRevision } from '../../src/workspace/revision.ts'
import { ImagePlanStateStore } from '../../src/workspace/image-plan-state.ts'
import { DraftStateStore } from '../../src/workspace/draft.ts'

interface Target { targetKey: string; displayPath: string }
const roots: string[] = []
const signal = new AbortController().signal
const missingId = '00000000-0000-0000-0000-000000000000'
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'creator-legacy-')); roots.push(workspace)
  const stateDir = await mkdtemp(join(process.cwd(), '.state-test-legacy-')); roots.push(stateDir)
  let readable = true; let mode = 'workspace-write'; let failSave = false
  const commands: string[] = []; const listings: string[] = []; const reads: string[] = []
  const fs = {
    async resolve(path: string, options?: { cwd?: string }): Promise<Target> {
      if (!readable) throw Object.assign(new Error('/private/path token=secret'), { code: 'EACCES' })
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
      readSignal?.throwIfAborted(); reads.push(target.targetKey)
      try { const bytes = await readFile(target.targetKey); if (bytes.byteLength > maxBytes) throw Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' }); return bytes }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw Object.assign(new Error('missing file'), { code: 'FS_NOT_FOUND' }); throw error }
    },
    async listDir(target: Target) {
      listings.push(target.targetKey)
      const entries = await readdir(target.targetKey, { withFileTypes: true })
      return Promise.all(entries.map(async entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other', target: await fs.resolve(join(target.targetKey, entry.name)) })))
    },
  }
  const ctx = { fs, sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: workspace }) } }
  const agent = { id: 'owner-a', session: { header: { cwd: workspace } }, followup: () => { throw new Error('unexpected model request') } } as unknown as Agent
  const config = resolveConfig({ stateDir, artifactsDir: '.articles' })
  const gateway = { resolve: async () => 'md2wechat', run: async (argv: string[], options: { signal: AbortSignal; beforeSpawn?: (signal: AbortSignal) => Promise<void> }) => { await options.beforeSpawn?.(options.signal); commands.push(argv.join(' ')); if (commands.at(-1) !== 'themes list --json') throw new Error('unexpected external command'); return { success: true, status: 'completed', code: 'THEMES_SHOWN', data: { themes: [{ type: 'api', selectable: true, name: 'simple', description: 'Simple' }] } } } }
  const operations = creatorOperations(ctx as never, config, gateway as never, () => {}, {} as never, new ImagePlanStateStore(stateDir), new DraftStateStore(stateDir))
  const service = () => new CreatorService(a => {
    const ops = operations(a)
    if (failSave) ops.documents.save = async () => { throw Object.assign(new Error('/private/disk secret-token'), { code: 'ENOSPC' }) }
    return ops
  }, 'unavailable-default', '.articles', true)
  const api = () => new CreatorRemote(new Context(), service())
  async function revision(markdown = '# Legacy article\n\nSaved paragraph.\n', createdAt = '2026-10-01T00:00:00.000Z') {
    const manifest = { schemaVersion: 1 as const, articlePath: 'article.md', manifestPath: 'manifest.json', createdAt, title: 'Legacy article' }
    const bytes = new TextEncoder().encode(markdown); const revision = computeArticleRevision(bytes, manifest)
    const manifestPath = `revisions/${revision.id}/manifest.json`
    await mkdir(join(workspace, '.articles', 'revisions', revision.id), { recursive: true })
    await writeFile(join(workspace, '.articles', 'revisions', revision.id, 'article.md'), bytes)
    await writeFile(join(workspace, '.articles', manifestPath), JSON.stringify(manifest))
    return { revisionId: revision.id, manifestPath, title: 'Legacy article', createdAt, markdown }
  }
  return { workspace, stateDir, agent, operations, service, api, revision, fs, listings, reads, commands, denyReads: () => { readable = false }, readonly: () => { mode = 'read-only' }, failSave: () => { failSave = true } }
}
async function code(result: Promise<unknown>, expected: string) {
  const error = await result.then(() => { throw new Error('expected failure') }, error => error)
  expect(creatorErrorInfo(error).code).toBe(expected)
  expect(error.message).not.toMatch(/\/private|secret-token|token=secret/u)
}

describe('explicit bounded legacy article recovery', () => {
  it('never discovers or adopts old revisions from a missing random card identity', async () => {
    const f = await fixture(); await f.revision(); const api = f.api()
    await code(api.get(f.agent, missingId, signal), 'RECOVERY_REQUIRED')
    expect(await api.list(f.agent, signal)).toEqual([])
    expect(f.listings).toEqual([]); expect(f.commands).toEqual([])
  })

  it('lists direct metadata only on explicit discovery without creating records or reading article bodies', async () => {
    const f = await fixture(); const saved = await f.revision(); const api = f.api()
    const { markdown: _, ...summary } = saved
    expect(await api.discoverRevisions(f.agent, signal)).toEqual([summary])
    expect(f.listings).toEqual([join(f.workspace, '.articles', 'revisions')])
    expect(f.reads.every(path => path.endsWith('/manifest.json'))).toBe(true)
    expect(await api.list(f.agent, signal)).toEqual([]); expect(f.commands).toEqual([])
    expect(await readdir(f.stateDir)).toEqual([])
  })

  it('returns an empty discovery list if there are no saved revisions', async () => {
    const f = await fixture()
    expect(await f.api().discoverRevisions(f.agent, signal)).toEqual([])
    expect(f.commands).toEqual([])
  })

  it('recovers only an explicit manifest into a new stable record and preserves all original files', async () => {
    const f = await fixture(); const saved = await f.revision(); const api = f.api()
    const original = await readFile(join(f.workspace, '.articles', saved.manifestPath), 'utf8')
    const view = await api.recoverRevision(f.agent, saved.manifestPath, signal)
    expect(view.articleId).toMatch(/^[a-f0-9-]{36}$/u)
    expect(view).toMatchObject({ markdown: saved.markdown, theme: 'simple', reviewed: false, preparedForDraft: false, canUndo: false, coverId: '', imageCandidates: [], imageRequest: null, suggestionRequest: null, suggestions: [], delivery: null, preview: { status: 'empty' } })
    expect(view.recovery?.message).toMatch(/原文路径/u)
    expect(view.recovery?.message).toMatch(/主题/u)
    expect(view.recovery?.message).toMatch(/撤回/u)
    expect(view.recovery?.message).toMatch(/交付/u)
    const record = JSON.parse(await readFile(join(f.workspace, '.articles', 'documents', `${view.articleId}.json`), 'utf8'))
    expect(record.sourcePath).toBe(`.articles/revisions/${saved.revisionId}/article.md`)
    expect(record.revision).toEqual({ id: saved.revisionId, manifestPath: saved.manifestPath })
    expect(await readFile(join(f.workspace, '.articles', saved.manifestPath), 'utf8')).toBe(original)
    expect(await readFile(join(f.workspace, record.sourcePath), 'utf8')).toBe(saved.markdown)
    expect(f.commands).toEqual(['themes list --json'])
    expect((await f.api().resume(f.agent, view.articleId, signal)).recovery?.message).toMatch(/原文路径/u)
  })

  it('reuses the same current-owner record on repeated concurrent and restarted explicit recovery', async () => {
    const f = await fixture(); const saved = await f.revision(); const api = f.api()
    const views = await Promise.all([api.recoverRevision(f.agent, saved.manifestPath, signal), api.recoverRevision(f.agent, saved.manifestPath, signal)])
    expect(views[0]!.articleId).toBe(views[1]!.articleId)
    expect((await f.api().recoverRevision(f.agent, saved.manifestPath, signal)).articleId).toBe(views[0]!.articleId)
    expect(await api.list(f.agent, signal)).toHaveLength(1)
  })

  it('isolates stable article identity for sessions that share the same readable directory', async () => {
    const f = await fixture(); const saved = await f.revision(); const api = f.api()
    const a = await api.recoverRevision(f.agent, saved.manifestPath, signal)
    const other = { ...f.agent, id: 'owner-b' } as Agent
    const b = await api.recoverRevision(other, saved.manifestPath, signal)
    expect(a.articleId).not.toBe(b.articleId)
    expect((await api.list(f.agent, signal)).map(item => item.articleId)).toEqual([a.articleId])
    expect((await api.list(other, signal)).map(item => item.articleId)).toEqual([b.articleId])
    await code(api.resume(other, a.articleId, signal), 'PERMISSION_DENIED')
  })

  it('reuses an existing record without discarding its private unknown-delivery barrier', async () => {
    const f = await fixture(); const saved = await f.revision(); const api = f.api()
    const original = await api.recoverRevision(f.agent, saved.manifestPath, signal)
    await f.operations(f.agent).documents.beginDelivery(original.articleId, 'draft', signal)
    const again = await f.api().recoverRevision(f.agent, saved.manifestPath, signal)
    expect(again.articleId).toBe(original.articleId)
    expect(again.delivery).toMatchObject({ kind: 'draft', status: 'unknown' })
    await expect(f.service().dispatch(f.agent, original.articleId, 1, { type: 'create-draft', confirmed: true }, signal)).rejects.toThrow('核对')
    expect(f.commands.every(command => command === 'themes list --json')).toBe(true)
  })

  it.each(['../manifest.json', '/private/manifest.json', 'revisions/' + 'a'.repeat(64) + '/../../manifest.json'])('rejects escaping or non-canonical manifest %s', async manifest => {
    const f = await fixture(); await f.revision()
    await code(f.api().recoverRevision(f.agent, manifest, signal), 'ARTIFACT_INVALID')
    expect(await f.api().list(f.agent, signal)).toEqual([])
  })

  it('rejects changed article bytes and missing referenced assets without creating records', async () => {
    const f = await fixture(); const saved = await f.revision()
    await writeFile(join(f.workspace, '.articles', 'revisions', saved.revisionId, 'article.md'), '# Changed')
    await code(f.api().recoverRevision(f.agent, saved.manifestPath, signal), 'ARTIFACT_INVALID')
    const missingAsset = await f.revision('# Picture\n\n![Image](images/missing.png)\n')
    await code(f.api().recoverRevision(f.agent, missingAsset.manifestPath, signal), 'ARTIFACT_INVALID')
    expect(await f.api().list(f.agent, signal)).toEqual([])
    expect(f.commands).toEqual([])
  })

  it('does not follow directory links or recurse outside the direct revision directory', async () => {
    const f = await fixture(); const saved = await f.revision()
    const outside = await mkdtemp(join(tmpdir(), 'legacy-outside-')); roots.push(outside)
    await symlink(outside, join(f.workspace, '.articles', 'revisions', 'a'.repeat(64)))
    await mkdir(join(f.workspace, '.articles', 'revisions', 'nested'), { recursive: true })
    await writeFile(join(outside, 'manifest.json'), 'secret-token')
    expect((await f.api().discoverRevisions(f.agent, signal)).map(item => item.revisionId)).toEqual([saved.revisionId])
    expect(f.listings).toHaveLength(1)
    expect(f.reads.some(path => path.startsWith(outside))).toBe(false)
    await code(f.api().recoverRevision(f.agent, `revisions/${'a'.repeat(64)}/manifest.json`, signal), 'ARTIFACT_INVALID')
  })

  it('rejects a revision-local article redirected outside its immutable directory even when bytes match', async () => {
    const f = await fixture(); const saved = await f.revision()
    const article = join(f.workspace, '.articles', 'revisions', saved.revisionId, 'article.md')
    await writeFile(join(f.workspace, '.articles', 'other.md'), saved.markdown)
    await rm(article); await symlink(join(f.workspace, '.articles', 'other.md'), article)
    await code(f.api().recoverRevision(f.agent, saved.manifestPath, signal), 'ARTIFACT_INVALID')
    expect(await f.api().list(f.agent, signal)).toEqual([])
  })

  it.each(['discover', 'recover'] as const)('rejects %s when the revisions root redirects to another artifact subtree', async operation => {
    const f = await fixture(); const saved = await f.revision()
    const root = join(f.workspace, '.articles', 'revisions')
    const replacement = join(f.workspace, '.articles', 'other-tree')
    await rename(root, replacement); await symlink(replacement, root)
    const api = f.api()
    await code(operation === 'discover' ? api.discoverRevisions(f.agent, signal) : api.recoverRevision(f.agent, saved.manifestPath, signal), 'ARTIFACT_INVALID')
    expect(f.listings).toEqual([]); expect(f.reads).toEqual([])
    expect(await readdir(f.stateDir)).toEqual([])
  })

  it('preserves a contained configured artifact-root alias without allowing a revisions-root alias', async () => {
    const f = await fixture(); const saved = await f.revision()
    const root = join(f.workspace, '.articles'); const destination = join(f.workspace, '.actual-articles')
    await rename(root, destination); await symlink(destination, root)
    expect((await f.api().discoverRevisions(f.agent, signal)).map(item => item.revisionId)).toEqual([saved.revisionId])
  })

  it('rejects a directory escape introduced after listing without reading the replacement', async () => {
    const f = await fixture(); await f.revision()
    const outside = await mkdtemp(join(tmpdir(), 'legacy-swap-')); roots.push(outside)
    const original = f.fs.listDir
    f.fs.listDir = async target => {
      const entries = await original(target)
      await rename(target.targetKey, `${target.targetKey}-old`)
      await symlink(outside, target.targetKey)
      return entries
    }
    await code(f.api().discoverRevisions(f.agent, signal), 'ARTIFACT_INVALID')
    expect(f.reads).toEqual([])
    expect(await readdir(f.stateDir)).toEqual([])
  })

  it('bounds discovered metadata to 100 direct candidates and never inspects nested directories', async () => {
    const f = await fixture()
    for (let index = 0; index < 104; index++) await f.revision(`# Article ${index}\n`, `2026-10-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`)
    const results = await f.api().discoverRevisions(f.agent, signal)
    expect(results).toHaveLength(100)
    expect(f.listings).toHaveLength(1)
    expect(f.reads).toHaveLength(100)
  })

  it('rechecks current read and write permissions and does not persist a failed recovery', async () => {
    const f = await fixture(); const saved = await f.revision(); const api = f.api()
    f.readonly()
    expect(await api.discoverRevisions(f.agent, signal)).toHaveLength(1)
    await code(api.recoverRevision(f.agent, saved.manifestPath, signal), 'PERMISSION_DENIED')
    expect(await api.list(f.agent, signal)).toEqual([])
    f.denyReads()
    await code(api.discoverRevisions(f.agent, signal), 'PERMISSION_DENIED')
    await code(api.recoverRevision(f.agent, saved.manifestPath, signal), 'PERMISSION_DENIED')
  })

  it('does not publish an unsaved identity or leak a failed save diagnostic', async () => {
    const f = await fixture(); const saved = await f.revision(); f.failSave(); const api = f.api()
    await code(api.recoverRevision(f.agent, saved.manifestPath, signal), 'RECOVERY_REQUIRED')
    expect(await api.list(f.agent, signal)).toEqual([])
    expect(await readFile(join(f.workspace, '.articles', 'revisions', saved.revisionId, 'article.md'), 'utf8')).toBe(saved.markdown)
  })

  it('cancels discovery and recovery before any filesystem or command access', async () => {
    const f = await fixture(); const aborted = new AbortController(); aborted.abort('/private/secret-token')
    const api = f.api()
    await code(api.discoverRevisions(f.agent, aborted.signal), 'HOST_UNAVAILABLE')
    await code(api.recoverRevision(f.agent, 'revisions/x/manifest.json', aborted.signal), 'HOST_UNAVAILABLE')
    expect(f.listings).toEqual([]); expect(f.reads).toEqual([]); expect(f.commands).toEqual([])
  })
})
