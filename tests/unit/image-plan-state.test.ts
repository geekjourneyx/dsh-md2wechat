import { createHash } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '../../src/workspace/artifact-store.ts'
import { ImagePlanStateStore } from '../../src/workspace/image-plan-state.ts'
import { canonicalImagePlanId, encodeCanonical } from '../../src/workspace/images.ts'

interface TestTarget { targetKey: string; displayPath: string }
const encoder = new TextEncoder()

function createSandboxFileSystem(cwd: string) {
  const api = {
    async resolve(path: string): Promise<TestTarget> {
      const displayPath = resolve(cwd, path); let ancestor = displayPath; const missing: string[] = []
      while (true) {
        try { return { displayPath, targetKey: join(await realpath(ancestor), ...missing) } } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
          missing.unshift(basename(ancestor)); const parent = dirname(ancestor)
          if (parent === ancestor) return { displayPath, targetKey: displayPath }; ancestor = parent
        }
      }
    },
    processPath(target: TestTarget): string { return target.targetKey },
    contains(parent: TestTarget, child: TestTarget): boolean { const candidate = relative(parent.targetKey, child.targetKey); return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate)) },
    async stat(target: TestTarget) {
      try { const info = await stat(target.targetKey); return { version: `${info.mtimeMs}:${info.size}`, type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.size } }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error }
    },
    async readBytes(target: TestTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> { signal?.throwIfAborted(); const bytes = await readFile(target.targetKey); if (bytes.byteLength > maxBytes) throw new Error('too large'); return bytes },
    async writeText(path: string, text: string): Promise<void> {
      const workspace = await api.resolve(cwd); const target = await api.resolve(path)
      if (!api.contains(workspace, target)) { const error = new Error('sandbox write denied') as Error & { code: string }; error.code = 'FS_PERMISSION'; throw error }
      await writeFile(target.targetKey, text)
    },
    async mkdir(path: string): Promise<void> {
      const workspace = await api.resolve(cwd); const target = await api.resolve(path)
      if (!api.contains(workspace, target)) { const error = new Error('sandbox mkdir denied') as Error & { code: string }; error.code = 'FS_PERMISSION'; throw error }
      await mkdir(target.targetKey)
    },
  }
  return api
}

describe('external image plan state', () => {
  let temporary: string; let workspace: string; let stateDir: string; let fs: ReturnType<typeof createSandboxFileSystem>; let store: ArtifactStore
  const revisionId = 'a'.repeat(64)
  const items = [{ original: { id: 'hero', kind: 'image', prompt: 'Hero', targetPath: 'images/hero.png' }, targetArtifactPath: `revisions/${revisionId}/images/hero.png`, cliPlan: { prompt: 'Hero' } }]
  const planId = canonicalImagePlanId(revisionId, items)
  const planPath = `revisions/${revisionId}/plans/${planId}.json`

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-state-workspace-')); workspace = join(temporary, 'workspace'); await mkdir(workspace)
    stateDir = await mkdtemp(join(process.cwd(), '.state-test-')); fs = createSandboxFileSystem(workspace); store = new ArtifactStore(fs as never, workspace, '.dsh/md2wechat')
  })
  afterEach(async () => { await rm(temporary, { recursive: true, force: true }); await rm(stateDir, { recursive: true, force: true }) })

  function proposal() {
    const planBytes = encodeCanonical({ schemaVersion: 1, planId, revisionId, createdAt: '2026-08-25T00:00:00.000Z', items })
    return { planPath, planId, revisionId, items, planBytes }
  }

  it('rejects state roots inside the workspace, artifacts root, or platform temp root', async () => {
    for (const unsafe of [join(workspace, 'state'), store.resolve('state'), join(tmpdir(), 'dsh-md2wechat-state')]) {
      await expect(new ImagePlanStateStore(unsafe).initialize(store, true)).rejects.toThrow('stateDir')
    }
  })

  it('rejects non-private roots and symlink aliases before authority use', async () => {
    const state = new ImagePlanStateStore(stateDir)
    await state.initialize(store, true)
    if (process.platform !== 'win32') {
      await chmod(stateDir, 0o755)
      await expect(state.initialize(store, false)).rejects.toThrow('permissions')
      await chmod(stateDir, 0o700)
    }
    const alias = `${stateDir}-alias`
    await symlink(stateDir, alias)
    try { await expect(new ImagePlanStateStore(alias).initialize(store, false)).rejects.toThrow('symlink') }
    finally { await rm(alias) }
  })

  it('uses first-writer-wins bytes across instances and recovers record-before-plan crashes', async () => {
    const first = new ImagePlanStateStore(stateDir); const second = new ImagePlanStateStore(stateDir)
    await Promise.all([first.publish(store, proposal()), second.publish(store, proposal())])
    await expect(store.read(planPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await new ImagePlanStateStore(stateDir).publish(store, proposal())
    await store.createExclusive(planPath, proposal().planBytes)
    await expect(new ImagePlanStateStore(stateDir).verify(store, proposal())).resolves.toBeUndefined()
  })

  it('recovers after interruption at every authority directory publication point', async () => {
    const state = new ImagePlanStateStore(stateDir)
    const workspaceIdentity = await state.initialize(store, true)
    const digest = createHash('sha256').update(proposal().planBytes).digest('hex')
    const components = ['image-plans', workspaceIdentity, revisionId, planId, digest]
    for (let depth = 0; depth <= components.length; depth += 1) {
      await rm(join(stateDir, 'image-plans'), { recursive: true, force: true })
      if (depth > 0) await mkdir(join(stateDir, ...components.slice(0, depth)), { recursive: true, mode: 0o700 })
      await expect(state.publish(store, proposal())).resolves.toBeUndefined()
      await expect(state.verify(store, proposal())).resolves.toBeUndefined()
    }
  })

  it('fails both candidates safe when one plan ID gains two different exact-byte digests', async () => {
    const other = { ...proposal(), planBytes: encodeCanonical({
      schemaVersion: 1, planId, revisionId, createdAt: '2026-08-25T00:00:01.000Z', items,
    }) }
    await Promise.allSettled([
      new ImagePlanStateStore(stateDir).publish(store, proposal()),
      new ImagePlanStateStore(stateDir).publish(store, other),
    ])
    await expect(new ImagePlanStateStore(stateDir).verify(store, proposal())).rejects.toThrow('conflicting')
    await expect(new ImagePlanStateStore(stateDir).verify(store, other)).rejects.toThrow('conflicting')
  })

  it('keeps authority outside workspace sandbox writes and unreachable through artifact symlink aliases', async () => {
    const state = new ImagePlanStateStore(stateDir); await state.publish(store, proposal())
    const entries = await readdir(stateDir, { recursive: true, withFileTypes: true })
    expect(entries.every(entry => entry.isDirectory() && !entry.isSymbolicLink())).toBe(true)
    const digest = createHash('sha256').update(proposal().planBytes).digest('hex')
    const terminal = entries.find(entry => entry.name === digest)
    expect(terminal).toBeDefined()
    const terminalPath = join(terminal!.parentPath, terminal!.name)
    await expect(link(terminalPath, join(workspace, 'directory-hardlink'))).rejects.toBeDefined()
    await mkdir(dirname(store.resolve('.trusted')), { recursive: true })
    await symlink(stateDir, store.resolve('.trusted'))
    await expect(store.read(`.trusted/image-plans/${digest}`)).rejects.toThrow()
    await expect(store.writeAtomic('.trusted/marker', encoder.encode('{}'))).rejects.toThrow('escapes')
    await expect(fs.writeText(join(stateDir, 'direct-marker'), '{}')).rejects.toMatchObject({ code: 'FS_PERMISSION' })
    await expect(fs.writeText(join(store.resolve('.trusted'), 'marker'), '{}')).rejects.toMatchObject({ code: 'FS_PERMISSION' })
    await expect(fs.writeText(join(store.resolve('.trusted'), '..', '.trusted', 'dot-marker'), '{}')).rejects.toMatchObject({ code: 'FS_PERMISSION' })
    await expect(fs.mkdir(join(store.resolve('.trusted'), 'directory'))).rejects.toMatchObject({ code: 'FS_PERMISSION' })
    await expect(fs.writeText(join(store.resolve('.TRUSTED'), 'case-marker'), '{}')).rejects.toMatchObject({ code: 'FS_PERMISSION' })
    await expect(state.verify(store, proposal())).resolves.toBeUndefined()
  })

  it('rejects a second digest and every file, link, or non-empty terminal before authentication', async () => {
    const state = new ImagePlanStateStore(stateDir); await state.publish(store, proposal())
    const digest = createHash('sha256').update(proposal().planBytes).digest('hex')
    const entries = await readdir(stateDir, { recursive: true, withFileTypes: true })
    const terminal = entries.find(entry => entry.name === digest)!
    const terminalPath = join(terminal.parentPath, terminal.name)

    await mkdir(join(dirname(terminalPath), 'b'.repeat(64)))
    await expect(state.verify(store, proposal())).rejects.toThrow('conflicting')
    await rm(join(dirname(terminalPath), 'b'.repeat(64)), { recursive: true })

    await writeFile(join(terminalPath, 'marker'), '')
    await expect(state.verify(store, proposal())).rejects.toThrow('empty')
    await rm(join(terminalPath, 'marker'))

    await writeFile(join(dirname(dirname(terminalPath)), 'regular-file'), '')
    await expect(state.verify(store, proposal())).rejects.toThrow('file, link')
  })
})
