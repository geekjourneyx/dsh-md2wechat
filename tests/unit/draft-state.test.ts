import { mkdir, mkdtemp, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '../../src/workspace/artifact-store.ts'
import { DraftStateStore } from '../../src/workspace/draft.ts'

interface TestTarget { targetKey: string; displayPath: string }

function createTestFileSystem(cwd: string) {
  return {
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
    async stat(target: TestTarget) { try { const value = await stat(target.targetKey); return { version: `${value.mtimeMs}:${value.size}`, type: value.isFile() ? 'file' : value.isDirectory() ? 'directory' : 'other', size: value.size } } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error } },
    async readBytes(target: TestTarget, signal: AbortSignal | undefined, maxBytes: number) { signal?.throwIfAborted(); const value = await readFile(target.targetKey); if (value.byteLength > maxBytes) throw new Error('too large'); return value },
  }
}

describe('DraftStateStore', () => {
  let temporary: string
  let workspace: string
  let stateDir: string
  let store: ArtifactStore

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-draft-state-'))
    workspace = join(temporary, 'workspace'); await mkdir(workspace)
    stateDir = await mkdtemp(join(process.cwd(), '.draft-state-test-'))
    store = new ArtifactStore(createTestFileSystem(workspace) as never, workspace, '.dsh/md2wechat')
  })
  afterEach(async () => { await import('node:fs/promises').then(fs => fs.rm(temporary, { recursive: true, force: true })); await import('node:fs/promises').then(fs => fs.rm(stateDir, { recursive: true, force: true })) })

  it('creates exclusive started authority, records one exact result digest, and authenticates replay', async () => {
    const state = new DraftStateStore(stateDir)
    const operationId = 'a'.repeat(64); const digest = 'b'.repeat(64)
    expect(await state.inspect(store, operationId)).toEqual({ status: 'absent' })
    await state.start(store, operationId)
    expect(await state.inspect(store, operationId)).toEqual({ status: 'started' })
    await expect(state.start(store, operationId)).rejects.toThrow('started')
    await state.complete(store, operationId, digest)
    expect(await state.inspect(store, operationId)).toEqual({ status: 'completed', resultDigest: digest })
    await state.complete(store, operationId, digest)
    await expect(state.complete(store, operationId, 'c'.repeat(64))).rejects.toThrow('conflicting')
  })

  it('rejects regular files, symlink roots, overlapping roots, and malformed identities', async () => {
    const state = new DraftStateStore(stateDir)
    expect(() => new DraftStateStore('relative')).toThrow('absolute')
    await expect(state.inspect(store, 'not-a-hash')).rejects.toThrow('identity')
    await import('node:fs/promises').then(fs => fs.writeFile(join(stateDir, 'unexpected'), 'x'))
    await expect(state.inspect(store, 'a'.repeat(64))).rejects.toThrow()
    await expect(new DraftStateStore(workspace).inspect(store, 'a'.repeat(64))).rejects.toThrow()
  })
})
