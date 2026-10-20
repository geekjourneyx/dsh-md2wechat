import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '../../src/workspace/artifact-store.ts'
import { DocumentStore, creatorDocumentPath, parseCreatorDocument } from '../../src/creator/documents.ts'
import type { CreatorDocumentV1 } from '../../src/creator/types.ts'

interface TestTarget { targetKey: string; displayPath: string }
function fileSystem(cwd: string) {
  return {
    async resolve(path: string, options?: { cwd?: string }): Promise<TestTarget> {
      const displayPath = resolve(options?.cwd ?? cwd, path); let ancestor = displayPath; const missing: string[] = []
      while (true) {
        try { return { displayPath, targetKey: join(await realpath(ancestor), ...missing) } }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
          missing.unshift(basename(ancestor)); const parent = dirname(ancestor)
          if (parent === ancestor) throw error
          ancestor = parent
        }
      }
    },
    processPath: (target: TestTarget) => target.targetKey,
    contains(parent: TestTarget, child: TestTarget) { const path = relative(parent.targetKey, child.targetKey); return path === '' || (!path.startsWith('..') && !isAbsolute(path)) },
    async stat(target: TestTarget) {
      try { const value = await stat(target.targetKey); return { version: `${value.mtimeMs}:${value.size}`, type: value.isFile() ? 'file' : 'directory', size: value.size } }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error }
    },
    async readBytes(target: TestTarget, signal: AbortSignal | undefined, maxBytes: number) {
      signal?.throwIfAborted(); const bytes = await readFile(target.targetKey)
      if (bytes.byteLength > maxBytes) throw new Error('file exceeds read limit')
      return bytes
    },
  }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function document(articleId = randomUUID()): CreatorDocumentV1 {
  const id = hash('revision')
  return {
    schemaVersion: 1, articleId, ownerSessionId: 'session-a', sourcePath: 'articles/source.md', sourceSha256: hash('# Source'),
    title: 'Saved title', revision: { id, manifestPath: `revisions/${id}/manifest.json` }, theme: 'default',
    imageCandidates: [{ id: 'cover-one', revisionId: id, kind: 'cover', path: `revisions/${id}/images/cover.png`, sha256: hash('image'), contentType: 'image/png', byteSize: 16, alt: '封面' }],
    coverId: 'cover-one', undo: [{ id: hash('previous'), manifestPath: `revisions/${hash('previous')}/manifest.json` }],
    version: 3, updatedAt: '2026-10-20T00:00:00.000Z',
  }
}

describe('persistent creator documents', () => {
  let temporary: string; let workspace: string; let stateDir: string; let store: ArtifactStore; let documents: DocumentStore
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'creator-documents-')); workspace = join(temporary, 'workspace'); await mkdir(workspace)
    stateDir = await mkdtemp(join(process.cwd(), '.state-test-creator-documents-'))
    store = new ArtifactStore(fileSystem(workspace) as never, workspace, '.md2wechat')
    documents = new DocumentStore(store, stateDir, 'session-a')
  })
  afterEach(async () => { await rm(temporary, { recursive: true, force: true }); await rm(stateDir, { recursive: true, force: true }) })

  it('atomically round-trips all bounded fields across store instances without copying article text', async () => {
    const saved = document(); await documents.save(saved)
    const restarted = new DocumentStore(new ArtifactStore(store.fs, workspace, '.md2wechat'), stateDir, 'session-a')
    expect(await restarted.read(saved.articleId)).toEqual(saved)
    expect(await restarted.list()).toEqual([saved])
    const bytes = await readFile(store.resolve(creatorDocumentPath(saved.articleId)), 'utf8')
    expect(JSON.parse(bytes)).toEqual(saved)
    expect(bytes).not.toContain('markdown')
    expect((await readdir(stateDir, { recursive: true, withFileTypes: true })).every(entry => entry.isDirectory() && !entry.isSymbolicLink())).toBe(true)
    expect(await restarted.read(randomUUID())).toBeUndefined()
  })

  it('retains an owner-bound unresolved delivery barrier across records and store instances', async () => {
    const saved = document(); await documents.save(saved)
    const token = await documents.beginDelivery(saved.articleId, 'draft')
    const restarted = new DocumentStore(new ArtifactStore(store.fs, workspace, '.md2wechat'), stateDir, 'session-a')
    expect(await restarted.deliveryStatus(saved.articleId)).toEqual({ kind: 'draft', token })
    await expect(restarted.beginDelivery(saved.articleId, 'materials')).rejects.toThrow('核对')
    await documents.save({ ...saved, version: 4 })
    expect(await restarted.deliveryStatus(saved.articleId)).toEqual({ kind: 'draft', token })
    await expect(new DocumentStore(store, stateDir, 'other-owner').reconcileDelivery(saved.articleId)).rejects.toThrow('owner')
    await expect(restarted.completeDelivery(saved.articleId, 'wrong-token')).rejects.toThrow()
    expect(await restarted.deliveryStatus(saved.articleId)).toEqual({ kind: 'draft', token })
    await restarted.reconcileDelivery(saved.articleId)
    expect(await documents.deliveryStatus(saved.articleId)).toBeUndefined()
    const next = await documents.beginDelivery(saved.articleId, 'materials')
    await documents.completeDelivery(saved.articleId, next)
    expect(await restarted.deliveryStatus(saved.articleId)).toBeUndefined()
  })

  it('rechecks current write policy for private barrier creation, completion and reconciliation', async () => {
    const saved = document(); await documents.save(saved)
    let writable = false
    const guarded = new DocumentStore(store, stateDir, 'session-a', async () => { if (!writable) throw new Error('只读') })
    await expect(guarded.beginDelivery(saved.articleId, 'draft')).rejects.toThrow('只读')
    expect(await documents.deliveryStatus(saved.articleId)).toBeUndefined()
    writable = true; const token = await guarded.beginDelivery(saved.articleId, 'draft'); writable = false
    await expect(guarded.completeDelivery(saved.articleId, token)).rejects.toThrow('只读')
    await expect(guarded.reconcileDelivery(saved.articleId)).rejects.toThrow('只读')
    expect(await documents.deliveryStatus(saved.articleId)).toEqual({ kind: 'draft', token })
  })

  it('treats an interrupted marker before token publication as unknown and blocks retry', async () => {
    const saved = document(); await documents.save(saved)
    const token = await documents.beginDelivery(saved.articleId, 'draft')
    const terminal = (await readdir(stateDir, { recursive: true })).find(path => path.endsWith(token))!
    await rmdir(join(stateDir, terminal))
    expect(await documents.deliveryStatus(saved.articleId)).toEqual({ kind: 'materials', token: '' })
    await expect(documents.beginDelivery(saved.articleId, 'draft')).rejects.toThrow('核对')
    await documents.reconcileDelivery(saved.articleId)
    expect(await documents.deliveryStatus(saved.articleId)).toBeUndefined()
  })

  it('returns an empty list for a missing private state root without creating it', async () => {
    const missing = join(stateDir, 'not-created')
    expect(await new DocumentStore(store, missing, 'session-a').list()).toEqual([])
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns a fresh validated copy and sorts the list newest first', async () => {
    const first = document(); const second = { ...document(), updatedAt: '2026-10-20T01:00:00.000Z' }
    await documents.save(first); await documents.save(second)
    const read = (await documents.read(first.articleId))!; read.undo.length = 0; read.imageCandidates[0]!.alt = 'changed'
    expect(await documents.read(first.articleId)).toEqual(first)
    expect((await documents.list()).map(item => item.articleId)).toEqual([second.articleId, first.articleId])
  })

  it.each([
    ['unknown authority', { reviewed: true }], ['schema version', { schemaVersion: 2 }], ['source hash', { sourceSha256: 'bad' }],
    ['title limit', { title: 'x'.repeat(501) }], ['version', { version: 0 }], ['timestamp', { updatedAt: 'yesterday' }], ['theme', { theme: '../theme' }],
    ['candidate count', { imageCandidates: Array.from({ length: 25 }, () => document().imageCandidates[0]) }],
    ['undo count', { undo: Array.from({ length: 21 }, () => document().revision) }],
    ['cover selection', { coverId: 'not-present' }],
    ['revision identity', { revision: { ...document().revision, id: 'A'.repeat(64) } }],
    ['revision path mismatch', { revision: { ...document().revision, manifestPath: `revisions/${'b'.repeat(64)}/manifest.json` } }],
  ])('rejects malformed %s without publishing a record', async (_name, change) => {
    const value = { ...document(), ...change }
    await expect(documents.save(value as CreatorDocumentV1)).rejects.toThrow()
    await expect(readFile(store.resolve(creatorDocumentPath(value.articleId)))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['../outside.md', '/absolute.md', 'a/../source.md', 'a//source.md', 'a/./source.md', 'a\\source.md', 'file.md:stream', 'NUL.md', 'bad\0.md', 'e\u0301.md'])('rejects non-canonical source path %j', async sourcePath => {
    await expect(documents.save({ ...document(), sourcePath })).rejects.toThrow()
  })

  it('rejects unknown nested fields, candidate traversal, stale revisions, duplicate IDs, and unsafe article IDs', () => {
    const saved = document(); const candidate = saved.imageCandidates[0]!
    for (const value of [
      { ...saved, revision: { ...saved.revision, markdown: 'not persisted' } },
      { ...saved, undo: [{ ...saved.revision, approval: true }] },
      { ...saved, imageCandidates: [{ ...candidate, mediaId: 'not persisted' }] },
      { ...saved, imageCandidates: [{ ...candidate, path: `revisions/${saved.revision.id}/images/../../other.png` }] },
      { ...saved, imageCandidates: [{ ...candidate, revisionId: hash('other') }] },
      { ...saved, imageCandidates: [candidate, candidate] },
      { ...saved, articleId: '../article' }, { ...saved, articleId: 'not-an-id' },
    ]) expect(() => parseCreatorDocument(value)).toThrow()
    expect(() => creatorDocumentPath('../escape')).toThrow()
  })

  it.each([
    ['array', [hash('image')]],
    ['object', { value: hash('image') }],
  ])('rejects a non-string %s candidate hash rather than coercing it', (_kind, sha256) => {
    const saved = document()
    const value = { ...saved, imageCandidates: [{ ...saved.imageCandidates[0]!, sha256 }] }
    expect(() => parseCreatorDocument(JSON.parse(JSON.stringify(value)))).toThrow('candidate hash')
  })

  it('does not trust a forged workspace JSON owner or expose same-directory session records', async () => {
    const saved = document(); await documents.save(saved)
    const other = new DocumentStore(store, stateDir, 'session-b')
    expect(await other.list()).toEqual([])
    await expect(other.read(saved.articleId)).rejects.toThrow('owner')
    await store.writeAtomic(creatorDocumentPath(saved.articleId), new TextEncoder().encode(JSON.stringify({ ...saved, ownerSessionId: 'session-b' })))
    await expect(other.read(saved.articleId)).rejects.toThrow('owner')
    await expect(documents.read(saved.articleId)).rejects.toThrow('owner')
    await expect(other.save({ ...saved, ownerSessionId: 'session-b' })).rejects.toThrow('owner')
  })

  it('cannot adopt an unbound record or accept a caller-provided owner different from the authenticated owner', async () => {
    const saved = document()
    await store.writeAtomic(creatorDocumentPath(saved.articleId), new TextEncoder().encode(JSON.stringify(saved)))
    expect(await documents.read(saved.articleId)).toBeUndefined()
    expect(await documents.list()).toEqual([])
    await expect(documents.save(saved)).rejects.toThrow('unbound')
    await expect(documents.save({ ...document(), ownerSessionId: 'session-b' })).rejects.toThrow('owner')
  })

  it('preserves the previous complete record and immutable article after an interrupted commit', async () => {
    const saved = document(); await store.writeAtomic(`revisions/${saved.revision.id}/article.md`, new TextEncoder().encode('# Immutable'))
    await documents.save(saved)
    const interrupted = new ArtifactStore(store.fs, workspace, '.md2wechat', { async beforeNativeCommit({ destinationPath }) { if (destinationPath.endsWith('.json')) throw new Error('injected interruption') } })
    await expect(new DocumentStore(interrupted, stateDir, 'session-a').save({ ...saved, version: 4, theme: 'classic' })).rejects.toThrow('injected interruption')
    expect(await documents.read(saved.articleId)).toEqual(saved)
    expect(await readFile(store.resolve(`revisions/${saved.revision.id}/article.md`), 'utf8')).toBe('# Immutable')
    expect((await readdir(dirname(store.resolve(creatorDocumentPath(saved.articleId))))).filter(path => path.endsWith('.tmp'))).toEqual([])
  })

  it('never reports success on disk-full publication or current write permission failures', async () => {
    const saved = document(); await documents.save(saved)
    const diskFull = new ArtifactStore(store.fs, workspace, '.md2wechat', { async rename() { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) } })
    await expect(new DocumentStore(diskFull, stateDir, 'session-a').save({ ...saved, version: 4 })).rejects.toMatchObject({ code: 'ENOSPC' })
    const denied = new ArtifactStore(store.fs, workspace, '.md2wechat', {}, async () => { throw new Error('read-only policy') })
    await expect(new DocumentStore(denied, stateDir, 'session-a').save({ ...saved, version: 4 })).rejects.toThrow('read-only policy')
    expect(await documents.read(saved.articleId)).toEqual(saved)
  })

  it('bounds saved articles to 100 without counting failed initial saves or another session', async () => {
    const failed = new ArtifactStore(store.fs, workspace, '.md2wechat', { async rename() { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) } })
    const unpublished = document()
    await expect(new DocumentStore(failed, stateDir, 'session-a').save(unpublished)).rejects.toMatchObject({ code: 'ENOSPC' })
    for (let index = 0; index < 100; index++) await documents.save(document())
    const saved = (await documents.list())[0]!
    await expect(documents.save(document())).rejects.toThrow('100')
    await expect(documents.save(unpublished)).rejects.toThrow('100')
    await documents.save({ ...saved, version: 4 })
    const other = new DocumentStore(store, stateDir, 'session-b')
    await other.save({ ...document(), ownerSessionId: 'session-b' })
    expect(await other.list()).toHaveLength(1)
    expect(await documents.list()).toHaveLength(100)
  }, 30_000)

  it('revalidates current filesystem permissions and canonical containment for every read', async () => {
    const saved = document(); await documents.save(saved)
    const deniedFs = { ...fileSystem(workspace), async readBytes() { throw new Error('read denied') } }
    await expect(new DocumentStore(new ArtifactStore(deniedFs as never, workspace, '.md2wechat'), stateDir, 'session-a').read(saved.articleId)).rejects.toThrow('read denied')
    await mkdir(join(workspace, 'articles')); await symlink(temporary, join(workspace, 'articles/escape'))
    await expect(documents.save({ ...document(), sourcePath: 'articles/escape/outside.md' })).rejects.toThrow('source')
    await rm(store.resolve('documents'), { recursive: true }); await symlink(temporary, store.resolve('documents'))
    await expect(documents.read(saved.articleId)).rejects.toThrow('escapes')
  })

  it('rejects non-private, symlinked, temporary, and workspace state roots', async () => {
    const saved = document()
    for (const unsafe of [workspace, join(workspace, 'state'), join(tmpdir(), 'creator-unsafe-state')]) {
      await expect(new DocumentStore(store, unsafe, 'session-a').save(saved)).rejects.toThrow('stateDir')
    }
    if (process.platform !== 'win32') {
      await chmod(stateDir, 0o755)
      await expect(documents.save(saved)).rejects.toThrow('permissions')
      await chmod(stateDir, 0o700)
    }
    const alias = `${stateDir}-alias`; await symlink(stateDir, alias)
    try { await expect(new DocumentStore(store, alias, 'session-a').save(saved)).rejects.toThrow('symlink') }
    finally { await rm(alias) }
  })

  it('ignores incomplete bindings but rejects forged files and links in private ownership state', async () => {
    const saved = document(); await documents.save(saved)
    const entries = await readdir(stateDir, { recursive: true, withFileTypes: true })
    const binding = entries.find(entry => entry.name === saved.articleId)!
    await mkdir(join(binding.parentPath, randomUUID()), { mode: 0o700 })
    expect(await documents.list()).toEqual([saved])
    await writeFile(join(binding.parentPath, 'forged'), '{}')
    await expect(documents.list()).rejects.toThrow('authority')
  })
})
